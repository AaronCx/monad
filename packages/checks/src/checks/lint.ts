import { execFile } from "node:child_process";
import type { ChangedFile, CheckResult, LintCheckConfig } from "../types";
import { existsSync } from "node:fs";
import { join } from "node:path";

const LINTABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".swift",
  ".vue", ".svelte",
]);

function isLintable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return LINTABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

async function runCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parts = command.split(/\s+/);
  const [cmd = "", ...args] = parts;

  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: cwd ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (child.exitCode ?? 1) : 0,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

type LinterKind = "biome" | "eslint" | "ruff" | "swiftlint";

export function detectLinter(cwd: string): { kind: LinterKind; commandPrefix: string } | null {
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return { kind: "biome", commandPrefix: "bunx biome check" };
  }
  const eslintConfigs = [
    ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json",
    ".eslintrc.yml", ".eslintrc.yaml",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  ];
  for (const config of eslintConfigs) {
    if (existsSync(join(cwd, config))) {
      return { kind: "eslint", commandPrefix: "bunx eslint" };
    }
  }
  if (existsSync(join(cwd, "pyproject.toml"))) {
    return { kind: "ruff", commandPrefix: "ruff check" };
  }
  if (existsSync(join(cwd, ".swiftlint.yml"))) {
    return { kind: "swiftlint", commandPrefix: "swiftlint lint --path" };
  }
  return null;
}

interface LintError {
  file?: string;
  line?: number;
  rule?: string;
  message: string;
}

function parseOutput(stdout: string, stderr: string): LintError[] {
  const errors: LintError[] = [];
  const output = `${stdout}\n${stderr}`;
  const lines = output.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    // Biome diagnostic header: "path.ts:2:7 lint/suspicious/noDoubleEquals ..."
    // (no "error" keyword, so it needs its own pattern).
    const biomeMatch = line.match(/^(.+?):(\d+):(\d+)\s+((?:lint|assist|syntax|format)\/[\w/.-]+)\b/);
    if (biomeMatch) {
      errors.push({
        file: biomeMatch[1] ?? "",
        line: Number.parseInt(biomeMatch[2] ?? "0", 10),
        rule: biomeMatch[4],
        message: biomeMatch[4] ?? "",
      });
      continue;
    }

    const match = line.match(/^(.+?):(\d+)(?::\d+)?:\s*(?:error|Error|ERR)\s*(.+)/);
    if (match) {
      const msg = (match[3] ?? "").trim();
      // Try to extract rule name from message (e.g. "no-unused-vars" or "(no-unused-vars)")
      const ruleMatch = msg.match(/\(?([\w-]+\/[\w-]+|[\w-]{3,})\)?$/);
      errors.push({
        file: match[1] ?? "",
        line: Number.parseInt(match[2] ?? "0", 10),
        rule: ruleMatch ? ruleMatch[1] : undefined,
        message: ruleMatch ? msg.replace(ruleMatch[0], '').trim() : msg,
      });
      continue;
    }

    const errorMatch = line.match(/^(?:error|Error|ERROR)[:\s]+(.+)/);
    if (errorMatch) {
      errors.push({ message: (errorMatch[1] ?? "").trim() });
    }
  }

  return errors;
}

export async function checkLint(
  files: ChangedFile[],
  config: LintCheckConfig,
): Promise<CheckResult> {
  const cwd = (config as LintCheckConfig & { cwd?: string }).cwd ?? process.cwd();

  // Scope the linter to changed lintable files only — don't run against the whole repo.
  const lintableFiles = files
    .filter((f) => f.status !== "removed")
    .map((f) => f.path)
    .filter(isLintable);

  if (lintableFiles.length === 0) {
    return {
      type: "lint",
      status: "pass",
      title: "Lint & Type Check",
      summary: "No lintable changed files",
      details: { skipped: true, reason: "no lintable files in diff" },
    };
  }

  let command: string;
  let kind: LinterKind | null = null;

  if (config.command) {
    command = config.command;
  } else {
    const detected = detectLinter(cwd);
    if (!detected) {
      return {
        type: "lint",
        status: "pass",
        title: "Lint & Type Check",
        summary: "No linter configuration detected, skipping",
        details: { skipped: true },
      };
    }
    command = `${detected.commandPrefix} ${lintableFiles.join(" ")}`;
    kind = detected.kind;
  }

  try {
    const result = await runCommand(command, cwd);

    if (result.exitCode === 0) {
      return {
        type: "lint",
        status: "pass",
        title: "Lint & Type Check",
        summary: `Lint check passed (${kind ?? "custom"}, ${lintableFiles.length} file(s))`,
        details: { command, checked: lintableFiles },
      };
    }

    const errors = parseOutput(result.stdout, result.stderr);
    // Filter findings to lines present in addedLines for each file. A change that doesn't
    // touch a file with pre-existing lint errors must not fail lint.
    const filtered = filterToAddedLines(errors, files);

    // If the linter exited non-zero with no parseable output, treat it as a command-level failure
    // (binary missing, config invalid, etc.) rather than swallowing the signal.
    if (errors.length === 0) {
      return {
        type: "lint",
        status: "fail",
        title: "Lint & Type Check",
        summary: `Lint command failed (exit ${result.exitCode}) with no parseable output`,
        details: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout.substring(0, 2000),
          stderr: result.stderr.substring(0, 2000),
        },
      };
    }

    if (filtered.length === 0) {
      return {
        type: "lint",
        status: "pass",
        title: "Lint & Type Check",
        summary: `Linter reported ${errors.length} pre-existing error(s); none on changed lines`,
        details: {
          command,
          checked: lintableFiles,
          preExisting: errors.length,
        },
      };
    }

    return {
      type: "lint",
      status: "fail",
      title: "Lint & Type Check",
      summary: `Lint check failed with ${filtered.length} error(s) on changed lines (${kind ?? "custom"})`,
      details: {
        command,
        findings: filtered.map((e) => ({
          file: e.file,
          line: e.line,
          rule: e.rule,
          message: e.message,
        })),
        errors: filtered,
        errorCount: filtered.length,
        preExisting: errors.length - filtered.length,
        stdout: result.stdout.substring(0, 2000),
        stderr: result.stderr.substring(0, 2000),
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      type: "lint",
      status: "fail",
      title: "Lint & Type Check",
      summary: `Lint command failed to execute: ${errMsg}`,
      details: { error: errMsg },
    };
  }
}

function filterToAddedLines(errors: LintError[], files: ChangedFile[]): LintError[] {
  const addedLineMap = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.addedLines) continue;
    addedLineMap.set(
      file.path,
      new Set(file.addedLines.map((l) => l.lineNo)),
    );
  }

  return errors.filter((e) => {
    // Findings without file/line cannot be scoped — keep them (e.g., command-level failures).
    if (!e.file || e.line === undefined) return true;
    const lines = addedLineMap.get(e.file)
      // Fallback: linter output may include "./path" or absolute paths — match by basename suffix.
      ?? [...addedLineMap.entries()].find(([p]) => e.file === p || e.file?.endsWith(`/${p}`) || p.endsWith(`/${e.file}`))?.[1];
    if (!lines) {
      // We don't have addedLines for this file — be permissive (could be a config-level finding).
      return true;
    }
    return lines.has(e.line);
  });
}
