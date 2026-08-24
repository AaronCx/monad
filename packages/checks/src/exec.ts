import { execFile } from "node:child_process";

/**
 * The one place monad's checks start a child process.
 *
 * `execFile`, never `exec` and never a shell: a command string is split on
 * whitespace and handed to the OS as argv, so nothing in it is interpreted.
 * That matters most on the untrusted path, where parts of the command line are
 * derived from a worktree monad does not trust (decision record 0009).
 */

/** Result of one child process run. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed rather than allowed to exit. */
  timedOut: boolean;
}

export interface RunCommandOptions {
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Kill the child after this many milliseconds. Omitting it means no timeout,
   * which is what the dependency audit and the linter have always done: their
   * commands are short and their callers never set one.
   */
  timeoutMs?: number;
  /** Per-stream output cap. */
  maxBuffer?: number;
}

/** 10 MiB per stream, the value every check has used since M2. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Run one command and resolve with its output. Never rejects: a missing
 * binary, a non-zero exit, and a timeout are all results a check reports on,
 * not exceptions it has to catch.
 */
export function runCommand(
  command: string | readonly string[],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const parts = typeof command === "string" ? command.split(/\s+/) : [...command];
  const [cmd = "", ...args] = parts;
  const { cwd, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER } = options;

  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: cwd ?? process.cwd(),
        maxBuffer,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve({ exitCode: -1, stdout: stdout || "", stderr: stderr || "", timedOut: true });
          return;
        }
        resolve({
          exitCode: error ? Number(error.code) || child.exitCode || 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut: false,
        });
      },
    );
  });
}
