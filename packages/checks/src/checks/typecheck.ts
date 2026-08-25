import { resolveTool, runCommand } from "../exec";
import { existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { CheckResult, Finding, TypecheckCheckConfig } from "../types";
import type { TrustLevel } from "../config/loader";
import { statusFromFindings } from "./status";

const DEFAULT_TIMEOUT_SECONDS = 300;

function isOnPath(binary: string): boolean {
  const pathVar = process.env.PATH ?? "";
  return pathVar.split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, binary)));
}

function readScripts(cwd: string): Record<string, string> | undefined {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

/**
 * Detect the repo's type checker, in order:
 *  1. a package.json script named `typecheck` or `type-check` (run via `bun run`)
 *  2. a tsconfig.json (`bunx tsc --noEmit -p tsconfig.json`)
 *  3. a pyproject.toml with pyright or mypy on PATH
 *  4. nothing: skip with a note
 *
 * Detection reads the worktree, so under decision record 0009 it is itself a
 * place the reviewed PR could decide what monad executes. Dropping
 * `checks.typecheck.command` from an untrusted config is not enough on its
 * own: `bun run typecheck` runs whatever `scripts.typecheck` says, and
 * `mypy` loads the `plugins` named in the PR's own `pyproject.toml`. Both are
 * PR-authored code, so an untrusted run refuses them and says so. What is
 * left is a fixed command line reading a configuration format that cannot
 * carry code: `tsc` against `tsconfig.json`, and `pyright`.
 */
interface DetectedTypechecker {
  kind: string;
  /** Bare binary name. `resolveTool` decides where it may come from. */
  tool: string;
  /** The fixed arguments monad wrote, never the PR's. */
  args: string[];
  /** Trusted runs reach this one through bunx. */
  viaBunx: boolean;
}

function detectTypechecker(
  cwd: string,
  trust: TrustLevel,
): DetectedTypechecker | { skip: string } {
  const untrusted = trust === "untrusted";
  const scripts = readScripts(cwd);
  if (scripts) {
    for (const name of ["typecheck", "type-check"]) {
      if (typeof scripts[name] === "string") {
        if (untrusted) {
          break; // The script body is written by the PR. Fall through to tsc.
        }
        return { kind: `package.json ${name} script`, tool: "bun", args: ["run", name], viaBunx: false };
      }
    }
  }
  if (existsSync(join(cwd, "tsconfig.json"))) {
    return { kind: "tsc", tool: "tsc", args: ["--noEmit", "-p", "tsconfig.json"], viaBunx: true };
  }
  if (existsSync(join(cwd, "pyproject.toml"))) {
    if (isOnPath("pyright")) return { kind: "pyright", tool: "pyright", args: [], viaBunx: false };
    if (isOnPath("mypy")) {
      if (untrusted) {
        return {
          skip: "untrusted PR: mypy is not run because it loads plugins from the PR's pyproject.toml",
        };
      }
      return { kind: "mypy", tool: "mypy", args: ["."], viaBunx: false };
    }
    return { skip: "pyproject.toml found but neither pyright nor mypy is on PATH" };
  }
  if (untrusted && scripts) {
    return {
      skip: "untrusted PR: the package.json typecheck script is not run, and no tsconfig.json was found",
    };
  }
  return { skip: "no typecheck script, tsconfig.json, or pyproject.toml found" };
}

/**
 * Parse tsc-style diagnostics: `file(line,col): error TSxxxx: message`.
 * Each becomes a Finding with rule "TS<code>".
 */
export function parseTscOutput(output: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of output.split("\n")) {
    // Unambiguous by construction: the file part cannot contain "(", and
    // every run of spacing is bounded, so no input backtracks quadratically.
    const match = line.match(
      /^([^(\n]{1,4096})\((\d{1,9}),(\d{1,9})\):[ \t]{1,8}error[ \t]{1,8}TS(\d{1,9}):[ \t]{0,8}(.*)$/,
    );
    if (!match) continue;
    findings.push({
      file: match[1] ?? "",
      line: Number.parseInt(match[2] ?? "0", 10),
      rule: `TS${match[4]}`,
      message: (match[5] ?? "").trim(),
      severity: "high",
    });
  }
  return findings;
}

/**
 * Type checking is never diff-scoped: type errors propagate, so a changed file
 * can break a file the diff never touched.
 */
export async function checkTypecheck(config: TypecheckCheckConfig): Promise<CheckResult> {
  const context = config as TypecheckCheckConfig & { cwd?: string; trust?: TrustLevel };
  const cwd = context.cwd ?? process.cwd();
  // Default deny: an unset trust level is the untrusted one here, because the
  // only caller that omits it is one that did not think about it.
  const trust: TrustLevel = context.trust === "trusted" ? "trusted" : "untrusted";
  const timeoutSeconds = config.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  // `invocation` is argv when monad built the command line; a config-supplied
  // command stays a string and is split the way it always was.
  let invocation: string | string[];
  let command: string;
  let kind: string;
  if (config.command) {
    command = config.command;
    invocation = config.command;
    kind = "custom";
  } else {
    const detected = detectTypechecker(cwd, trust);
    if ("skip" in detected) {
      return {
        type: "typecheck",
        status: "pass",
        title: "Type Check",
        summary: "Type check skipped: no type checker detected",
        details: { skipped: true, reason: detected.skip },
      };
    }
    // Detection chose the tool; resolution decides where the binary may come
    // from. An untrusted run takes it from PATH or takes nothing, because
    // `bunx tsc` would happily run a tsc the PR committed (record 0009).
    const resolved = resolveTool(detected.tool, { trust, cwd, viaBunx: detected.viaBunx });
    if (!resolved.ok) {
      return {
        type: "typecheck",
        status: "pass",
        title: "Type Check",
        summary: `Type check skipped: ${detected.kind} could not be resolved`,
        details: { skipped: true, reason: resolved.reason, typechecker: detected.kind },
      };
    }
    const argv = [...resolved.argv, ...detected.args];
    invocation = argv;
    command = argv.join(" ");
    kind = detected.kind;
  }

  try {
    const result = await runCommand(invocation, { cwd, timeoutMs: timeoutSeconds * 1000 });

    if (result.timedOut) {
      return {
        type: "typecheck",
        status: "fail",
        title: "Type Check",
        summary: `Type check timed out after ${timeoutSeconds}s (${command})`,
        details: { command, timeout: true, timeoutSeconds },
      };
    }

    if (result.exitCode === 0) {
      return {
        type: "typecheck",
        status: "pass",
        title: "Type Check",
        summary: `Type check passed (${kind})`,
        details: { command, exitCode: 0 },
      };
    }

    const findings = parseTscOutput(`${result.stdout}\n${result.stderr}`);

    if (findings.length === 0) {
      return {
        type: "typecheck",
        status: "fail",
        title: "Type Check",
        summary: `Type check failed (exit ${result.exitCode}, ${command})`,
        details: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout.substring(0, 2000),
          stderr: result.stderr.substring(0, 2000),
        },
      };
    }

    return {
      type: "typecheck",
      status: statusFromFindings(findings, { severity: config.severity }),
      title: "Type Check",
      summary: `Type check failed with ${findings.length} error(s) (${kind})`,
      details: {
        command,
        exitCode: result.exitCode,
        findings,
        errorCount: findings.length,
        stdout: result.stdout.substring(0, 2000),
        stderr: result.stderr.substring(0, 2000),
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      type: "typecheck",
      status: "fail",
      title: "Type Check",
      summary: `Type check command failed to execute: ${errMsg}`,
      details: { command, error: errMsg },
    };
  }
}
