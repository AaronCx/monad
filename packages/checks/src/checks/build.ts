import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, BuildCheckConfig } from "../types";

/**
 * Build verifier. Runs in `cwd`, which is the repo root or the review worktree;
 * the LastGate clone-to-tempdir path is gone on purpose (monad always has a
 * checkout to build in).
 *
 * Command resolution: explicit `command` from config wins; else a repo with a
 * package.json builds with `bun run build`; else `Package.swift` builds with
 * `swift build`; else `pyproject.toml` skips with a note (no standard build
 * step); else skip.
 */
export async function checkBuild(config: BuildCheckConfig): Promise<CheckResult> {
  const timeoutMs = (config.timeout ?? 120) * 1000;
  const cwd = (config as BuildCheckConfig & { cwd?: string }).cwd ?? process.cwd();

  // Detection first, custom command second: a directory with nothing buildable
  // skips even when a command is configured (ported LastGate behavior).
  const hasPackageJson = existsSync(join(cwd, "package.json"));
  const hasPackageSwift = existsSync(join(cwd, "Package.swift"));
  if (!hasPackageJson && !hasPackageSwift) {
    if (existsSync(join(cwd, "pyproject.toml"))) {
      return {
        type: "build",
        status: "pass",
        title: "Build Verifier",
        summary: "Build check skipped: Python project with no standard build step",
        details: { skipped: true, reason: "pyproject.toml has no standard build command" },
      };
    }
    return {
      type: "build",
      status: "pass",
      title: "Build Verifier",
      summary: "Build check skipped — no package.json in working directory",
      details: { command: config.command ?? "bun run build", skipped: true, reason: "no package.json" },
    };
  }

  const command = config.command ?? (hasPackageJson ? "bun run build" : "swift build");

  const parts = command.split(/\s+/);
  const [cmd, ...args] = parts;

  try {
    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve({ exitCode: -1, stdout: stdout || "", stderr: stderr || "" });
          return;
        }
        resolve({
          exitCode: error?.code ? Number(error.code) || 1 : child.exitCode ?? 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      });
    });

    if (exitCode === -1) {
      return {
        type: "build",
        status: "fail",
        title: "Build Verifier",
        summary: `Build timed out after ${config.timeout ?? 120}s (${command})`,
        details: { command, timeout: true, timeoutSeconds: config.timeout ?? 120 },
      };
    }

    if (exitCode === 0) {
      return {
        type: "build",
        status: "pass",
        title: "Build Verifier",
        summary: `Build passed (${command})`,
        details: { command, exitCode, output: "Build completed successfully" },
      };
    }

    const output = (`${stdout}\n${stderr}`).trim();
    const errorLines = output
      .split("\n")
      .filter((line) => /error|Error|ERROR|failed|Failed|FAILED/.test(line))
      .slice(0, 20);

    return {
      type: "build",
      status: "fail",
      title: "Build Verifier",
      summary: `Build failed with exit code ${exitCode} (${command})`,
      details: {
        command,
        exitCode,
        errorLines,
        output: (`${stdout}\n${stderr}`).trim().substring(0, 2000),
        stdout: stdout.substring(0, 2000),
        stderr: stderr.substring(0, 2000),
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      type: "build",
      status: "fail",
      title: "Build Verifier",
      summary: `Build command failed to execute: ${errMsg}`,
      details: { command, error: errMsg },
    };
  }
}
