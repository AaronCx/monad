import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { CheckResult, Finding, TypecheckCheckConfig } from "../types";
import { statusFromFindings } from "./status";

const DEFAULT_TIMEOUT_SECONDS = 300;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  const parts = command.split(/\s+/);
  const [cmd = "", ...args] = parts;
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve({ exitCode: -1, stdout: stdout || "", stderr: stderr || "", timedOut: true });
          return;
        }
        resolve({
          exitCode: error ? (Number(error.code) || child.exitCode || 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut: false,
        });
      },
    );
  });
}

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
 */
function detectTypechecker(cwd: string): { command: string; kind: string } | { skip: string } {
  const scripts = readScripts(cwd);
  if (scripts) {
    for (const name of ["typecheck", "type-check"]) {
      if (typeof scripts[name] === "string") {
        return { command: `bun run ${name}`, kind: `package.json ${name} script` };
      }
    }
  }
  if (existsSync(join(cwd, "tsconfig.json"))) {
    return { command: "bunx tsc --noEmit -p tsconfig.json", kind: "tsc" };
  }
  if (existsSync(join(cwd, "pyproject.toml"))) {
    if (isOnPath("pyright")) return { command: "pyright", kind: "pyright" };
    if (isOnPath("mypy")) return { command: "mypy .", kind: "mypy" };
    return { skip: "pyproject.toml found but neither pyright nor mypy is on PATH" };
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
  const cwd = (config as TypecheckCheckConfig & { cwd?: string }).cwd ?? process.cwd();
  const timeoutSeconds = config.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  let command: string;
  let kind: string;
  if (config.command) {
    command = config.command;
    kind = "custom";
  } else {
    const detected = detectTypechecker(cwd);
    if ("skip" in detected) {
      return {
        type: "typecheck",
        status: "pass",
        title: "Type Check",
        summary: "Type check skipped: no type checker detected",
        details: { skipped: true, reason: detected.skip },
      };
    }
    command = detected.command;
    kind = detected.kind;
  }

  try {
    const result = await runCommand(command, cwd, timeoutSeconds * 1000);

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
