import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { CheckResult, TestCheckConfig } from "../types";

const DEFAULT_TIMEOUT_SECONDS = 600;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  const parts = command.split(/\s+/);
  const [cmd, ...args] = parts;
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".turbo"]);

function hasFileMatching(dir: string, predicate: (name: string) => boolean, depth = 0): boolean {
  if (depth > 6) return false;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && predicate(entry.name)) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      if (hasFileMatching(join(dir, entry.name), predicate, depth + 1)) return true;
    }
  }
  return false;
}

function hasPythonTests(cwd: string): boolean {
  if (existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))) return true;
  return hasFileMatching(cwd, (name) => /^test_.*\.py$/.test(name) || /_test\.py$/.test(name));
}

/**
 * Detect the repo's test runner, in order:
 *  1. a package.json `test` script (`bun run test`)
 *  2. `bun test` when any *.test.ts exists
 *  3. `swift test` when Package.swift exists
 *  4. `pytest` when it is on PATH and tests exist
 *  5. nothing: skip with a note
 */
function detectTestRunner(cwd: string): { command: string; kind: string } | { skip: string } {
  const scripts = readScripts(cwd);
  if (scripts && typeof scripts.test === "string") {
    return { command: "bun run test", kind: "package.json test script" };
  }
  if (hasFileMatching(cwd, (name) => name.endsWith(".test.ts"))) {
    return { command: "bun test", kind: "bun test" };
  }
  if (existsSync(join(cwd, "Package.swift"))) {
    return { command: "swift test", kind: "swift test" };
  }
  if (isOnPath("pytest") && hasPythonTests(cwd)) {
    return { command: "pytest", kind: "pytest" };
  }
  return { skip: "no test script, *.test.ts files, Package.swift, or pytest tests found" };
}

/**
 * Best-effort pass/fail counts from a test runner's output. Understands bun
 * test (" N pass" / " N fail"), jest/vitest ("Tests: 1 failed, 2 passed"),
 * pytest ("2 passed, 1 failed"), and swift test ("Executed 3 tests, with 1
 * failure"). Returns undefined when nothing recognizable was printed.
 */
export function parseTestCounts(output: string): { passed: number; failed: number } | undefined {
  const bunPass = output.match(/^\s*(\d+)\s+pass\b/m);
  const bunFail = output.match(/^\s*(\d+)\s+fail\b/m);
  if (bunPass || bunFail) {
    return {
      passed: bunPass ? Number.parseInt(bunPass[1], 10) : 0,
      failed: bunFail ? Number.parseInt(bunFail[1], 10) : 0,
    };
  }

  const jest = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed/);
  if (jest) {
    return { passed: Number.parseInt(jest[2], 10), failed: jest[1] ? Number.parseInt(jest[1], 10) : 0 };
  }

  const pytest = output.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/);
  const pytestFailFirst = output.match(/(\d+)\s+failed,\s+(\d+)\s+passed/);
  if (pytestFailFirst) {
    return { passed: Number.parseInt(pytestFailFirst[2], 10), failed: Number.parseInt(pytestFailFirst[1], 10) };
  }
  if (pytest) {
    return { passed: Number.parseInt(pytest[1], 10), failed: pytest[2] ? Number.parseInt(pytest[2], 10) : 0 };
  }

  const swift = output.match(/Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?/);
  if (swift) {
    const total = Number.parseInt(swift[1], 10);
    const failed = Number.parseInt(swift[2], 10);
    return { passed: total - failed, failed };
  }

  return undefined;
}

/**
 * Test runner check. Never diff-scoped: a changed file can break any test in
 * the repo. Full-profile by default; the timeout comes from config (600s
 * default).
 */
export async function checkTest(config: TestCheckConfig): Promise<CheckResult> {
  const cwd = (config as TestCheckConfig & { cwd?: string }).cwd ?? process.cwd();
  const timeoutSeconds = config.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  let command: string;
  let kind: string;
  if (config.command) {
    command = config.command;
    kind = "custom";
  } else {
    const detected = detectTestRunner(cwd);
    if ("skip" in detected) {
      return {
        type: "test",
        status: "pass",
        title: "Test Runner",
        summary: "Tests skipped: no test runner detected",
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
        type: "test",
        status: "fail",
        title: "Test Runner",
        summary: `Tests timed out after ${timeoutSeconds}s (${command})`,
        details: { command, timeout: true, timeoutSeconds },
      };
    }

    const counts = parseTestCounts(`${result.stdout}\n${result.stderr}`);
    const countSuffix = counts ? ` (${counts.passed} passed, ${counts.failed} failed)` : "";

    if (result.exitCode === 0) {
      return {
        type: "test",
        status: "pass",
        title: "Test Runner",
        summary: `Tests passed (${kind})${countSuffix}`,
        details: { command, exitCode: 0, ...(counts ? { counts } : {}) },
      };
    }

    return {
      type: "test",
      status: config.severity === "warn" ? "warn" : "fail",
      title: "Test Runner",
      summary: `Tests failed (exit ${result.exitCode}, ${kind})${countSuffix}`,
      details: {
        command,
        exitCode: result.exitCode,
        ...(counts ? { counts } : {}),
        stdout: result.stdout.substring(0, 2000),
        stderr: result.stderr.substring(0, 2000),
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      type: "test",
      status: "fail",
      title: "Test Runner",
      summary: `Test command failed to execute: ${errMsg}`,
      details: { command, error: errMsg },
    };
  }
}
