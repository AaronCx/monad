import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { TrustLevel } from "./config/loader";

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

/**
 * Where a tool binary is allowed to come from.
 *
 * Decision record 0009 says the worktree may not decide what monad executes.
 * `bunx <name>` breaks that rule quietly: bun prefers a locally installed
 * binary, which means `<worktree>/node_modules/.bin/<name>`, and a PR can
 * commit that file. An untrusted review that lints with `bunx biome` therefore
 * runs a program the PR wrote, on the one path 0009 left open because "its
 * configuration format cannot carry code". Measured on 2026-08-24; see the
 * record.
 *
 * So monad resolves the binary itself. An untrusted run gets an absolute path
 * out of PATH and nothing else. A trusted run keeps `bunx`, because a repo you
 * trust should be linted with the toolchain it pinned.
 */
export interface ResolveToolOptions {
  /** Whose code the tool is about to be pointed at. */
  trust: TrustLevel;
  /**
   * The worktree the check runs in. Never searched for the binary. It is here
   * so a PATH entry that happens to point inside the worktree can be refused.
   */
  cwd: string;
  /**
   * True when a trusted run reaches this tool through `bunx` (biome, tsc,
   * eslint). False for tools monad has always invoked by bare name (ruff,
   * swiftlint, pyright, mypy, bun itself).
   */
  viaBunx?: boolean;
}

export type ToolResolution =
  | { ok: true; argv: string[] }
  /** Not resolvable under this trust level. The check skips and says this. */
  | { ok: false; reason: string };

function isInside(candidate: string, directory: string): boolean {
  let child: string;
  let parent: string;
  try {
    child = realpathSync(candidate);
    parent = realpathSync(directory);
  } catch {
    // An unreadable path is not provably outside the worktree: default deny.
    return true;
  }
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Resolve `name` to the argv prefix that should invoke it, or refuse.
 *
 * Untrusted: `Bun.which(name)`, which reads PATH only. The worktree is never
 * consulted, and a PATH entry resolving inside the worktree is refused too.
 * Trusted: today's behavior, unchanged.
 */
export function resolveTool(name: string, options: ResolveToolOptions): ToolResolution {
  const { trust, cwd, viaBunx = false } = options;

  if (trust === "trusted") {
    return { ok: true, argv: viaBunx ? ["bunx", name] : [name] };
  }

  const resolved = Bun.which(name);
  if (!resolved) {
    return {
      ok: false,
      reason: `untrusted PR: ${name} is not on PATH, and monad will not resolve it from the worktree because the PR could have committed that binary (decision record 0009)`,
    };
  }
  if (isInside(resolved, cwd)) {
    return {
      ok: false,
      reason: `untrusted PR: the ${name} found on PATH resolves inside the reviewed worktree`,
    };
  }
  return { ok: true, argv: [resolved] };
}
