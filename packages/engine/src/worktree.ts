import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { monadStateDir } from "./paths.ts";

/**
 * Review worktrees: detached git checkouts under ~/.monad/worktrees, one per
 * session, so a review never touches the user's main checkout. The only
 * thing monad writes into the main repo is the namespaced refs/monad/pr/*
 * refs used to materialize PR heads.
 *
 * Install strategy per decision record 0008: symlinking node_modules from
 * the main checkout is structurally broken under bun's isolated linker and
 * is never performed. `auto` and `install` both run
 * `bun install --frozen-lockfile` in the worktree (about 0.1 s warm); a
 * frozen-install failure surfaces as a loud error, never a mutated install.
 */

/** Overrides the bun binary the installer runs; tests point it at a script. */
export const MONAD_BUN_BIN_ENV = "MONAD_BUN_BIN";

export type InstallStrategy = "auto" | "symlink" | "install" | "none";

/** What actually happened; "symlink" is never performed (decision 0008). */
export type PerformedInstallStrategy = "install" | "none";

export interface InstallResult {
  installStrategy: PerformedInstallStrategy;
  /** Wall-clock milliseconds spent installing; 0 when skipped. */
  installMs: number;
  /** Non-fatal notes, e.g. the decision 0008 downgrade of "symlink". */
  warnings: string[];
}

/**
 * Payload shape of the worktree_ready event the review playbook appends
 * (stage 3). Kept here so the playbook and its tests share one contract.
 */
export interface WorktreeReadyPayload {
  path: string;
  installStrategy: PerformedInstallStrategy;
  installMs: number;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`git ${args.join(" ")} failed: ${String(stderr).trim()}`));
      } else {
        resolvePromise(stdout);
      }
    });
  });
}

async function tryGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await git(args, cwd);
  } catch {
    return undefined;
  }
}

/**
 * Stable key for a repo's worktree directory: a short hash of the origin
 * URL, falling back to the resolved absolute path for repos with no origin.
 */
export async function repoKey(repoRoot: string): Promise<string> {
  const origin = (await tryGit(["config", "--get", "remote.origin.url"], repoRoot))?.trim();
  const source = origin && origin.length > 0 ? origin : resolve(repoRoot);
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

/** Root directory holding every monad worktree ($MONAD_HOME/worktrees). */
export function worktreesRoot(env: Record<string, string | undefined> = process.env): string {
  return join(monadStateDir(env), "worktrees");
}

export interface CreateWorktreeInput {
  repoRoot: string;
  /** The commit to check out; the worktree is always detached, never a branch. */
  sha: string;
  sessionId: string;
  env?: Record<string, string | undefined>;
}

/**
 * Creates the session's detached worktree at
 * $MONAD_HOME/worktrees/<repoKey>/<sessionId>. Fails loudly if the path is
 * already occupied (session ids are unique; a leftover means a gc bug).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<{ path: string }> {
  const key = await repoKey(input.repoRoot);
  const path = join(worktreesRoot(input.env), key, input.sessionId);
  if (existsSync(path)) {
    throw new Error(`worktree path already exists: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await git(["worktree", "add", "--detach", path, input.sha], input.repoRoot);
  return { path };
}

/**
 * Removes a worktree through git so the main repo's bookkeeping stays clean;
 * falls back to deleting the directory plus `git worktree prune` when git
 * refuses (already-broken registration, dirty tree in a force removal).
 */
export async function removeWorktree(input: { repoRoot: string; path: string }): Promise<void> {
  const removed = await tryGit(["worktree", "remove", "--force", input.path], input.repoRoot);
  if (removed === undefined) {
    await rm(input.path, { recursive: true, force: true });
    await tryGit(["worktree", "prune"], input.repoRoot);
  }
}

/**
 * Materializes a PR head as the namespaced ref refs/monad/pr/<n> and returns
 * its sha. The refspec is forced so a re-review after the PR was force
 * pushed updates the ref instead of failing non-fast-forward.
 */
export async function fetchPullRequestHead(input: {
  repoRoot: string;
  number: number;
}): Promise<{ headSha: string; ref: string }> {
  const ref = `refs/monad/pr/${input.number}`;
  await git(["fetch", "origin", `+refs/pull/${input.number}/head:${ref}`], input.repoRoot);
  const headSha = (await git(["rev-parse", ref], input.repoRoot)).trim();
  return { headSha, ref };
}

/**
 * The merge base of a PR against its base branch: fetch the base ref from
 * origin, then merge-base origin/<baseRef> with the head sha.
 */
export async function resolveBaseSha(input: {
  repoRoot: string;
  baseRef: string;
  headSha: string;
}): Promise<{ baseSha: string }> {
  await git(["fetch", "origin", input.baseRef], input.repoRoot);
  const baseSha = (
    await git(["merge-base", `origin/${input.baseRef}`, input.headSha], input.repoRoot)
  ).trim();
  return { baseSha };
}

export interface InstallWorktreeDepsInput {
  /** The worktree path dependencies are installed into. */
  path: string;
  /** From review.install config. Default "auto". */
  strategy?: InstallStrategy;
  env?: Record<string, string | undefined>;
}

/**
 * Applies the install strategy to a fresh worktree, per decision 0008:
 * - `auto` and `install`: always `bun install --frozen-lockfile` in the
 *   worktree. No symlink fast path exists, even with byte-identical
 *   lockfiles (root-only symlinks break bun's isolated linker and can make
 *   dependents resolve the MAIN checkout's sources).
 * - `symlink` (from config): warns citing decision 0008 and installs.
 * - `none`: skips; dependent checks report skipped.
 * - Non-JS repos (no package.json): none is implied.
 * A frozen-install failure throws with the installer output; it must never
 * degrade into a lockfile-mutating install.
 */
export async function installWorktreeDeps(input: InstallWorktreeDepsInput): Promise<InstallResult> {
  const env = input.env ?? process.env;
  const strategy = input.strategy ?? "auto";
  const warnings: string[] = [];

  if (!existsSync(join(input.path, "package.json"))) {
    return { installStrategy: "none", installMs: 0, warnings };
  }
  if (strategy === "none") {
    return { installStrategy: "none", installMs: 0, warnings };
  }
  if (strategy === "symlink") {
    warnings.push(
      'review.install "symlink" is not supported (decision 0008: root-only node_modules ' +
        "symlinks break bun's isolated linker and can resolve the main checkout's sources); " +
        "running bun install --frozen-lockfile instead",
    );
  }

  const bunBin = env[MONAD_BUN_BIN_ENV]?.trim() || "bun";
  const startedAt = performance.now();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      bunBin,
      ["install", "--frozen-lockfile"],
      { cwd: input.path, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              [
                `bun install --frozen-lockfile failed in ${input.path}; the worktree's`,
                "lockfile does not match its manifest (or the installer broke) and monad",
                "will not fall back to a lockfile-mutating install:",
                String(stderr).trim() || String(stdout).trim(),
              ].join(" "),
            ),
          );
        } else {
          resolvePromise();
        }
      },
    );
  });
  const installMs = Math.round(performance.now() - startedAt);
  return { installStrategy: "install", installMs, warnings };
}

/** monad/fix/pr-<n>-<shortsha>: the branch fix mode commits on. */
export function fixBranchName(pr: { number: number; headSha: string }): string {
  return `monad/fix/pr-${pr.number}-${pr.headSha.slice(0, 7)}`;
}

/**
 * Lazily puts a detached fix worktree on its branch. Review worktrees are
 * detached on purpose; the branch appears on the FIRST granted edit of a fix
 * session, at the current HEAD, so an untouched review leaves no branch
 * behind. Idempotent: an already-attached HEAD (this branch or any other) is
 * left alone.
 */
export async function ensureFixBranch(input: {
  worktreePath: string;
  branchName: string;
}): Promise<{ created: boolean }> {
  const attached = await tryGit(["symbolic-ref", "--quiet", "HEAD"], input.worktreePath);
  if (attached !== undefined) {
    return { created: false };
  }
  await git(["checkout", "-b", input.branchName], input.worktreePath);
  return { created: true };
}

/** Parses a worktree's .git file to find the main repo root, if possible. */
async function mainRepoRootOf(worktreePath: string): Promise<string | undefined> {
  try {
    const gitFile = (await readFile(join(worktreePath, ".git"), "utf8")).trim();
    const match = gitFile.match(/^gitdir:\s*(.+)$/m);
    const gitdir = match?.[1]?.trim();
    if (!gitdir) {
      return undefined;
    }
    // <repoRoot>/.git/worktrees/<name> is the registered layout.
    const marker = "/.git/worktrees/";
    const markerIdx = gitdir.indexOf(marker);
    if (markerIdx === -1) {
      return undefined;
    }
    return gitdir.slice(0, markerIdx) || undefined;
  } catch {
    return undefined;
  }
}

export interface GcWorktreesInput {
  /** Only worktrees at least this old (directory mtime) are removed. */
  olderThanDays: number;
  /**
   * Whether a session is closed. Only closed sessions' worktrees are ever
   * removed; event logs are never touched by gc.
   */
  isSessionClosed: (sessionId: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Removes worktrees belonging to closed sessions older than the cutoff.
 * Directory names under $MONAD_HOME/worktrees are <repoKey>/<sessionId>, so
 * the session id is recoverable without a database join here.
 */
export async function gcWorktrees(input: GcWorktreesInput): Promise<{ removed: string[] }> {
  const root = worktreesRoot(input.env);
  const removed: string[] = [];
  const cutoffMs = Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000;
  let repoKeys: string[];
  try {
    repoKeys = await readdir(root);
  } catch {
    return { removed };
  }
  for (const key of repoKeys) {
    const keyDir = join(root, key);
    let sessionIds: string[];
    try {
      sessionIds = await readdir(keyDir);
    } catch {
      continue;
    }
    for (const sessionId of sessionIds) {
      const path = join(keyDir, sessionId);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > cutoffMs || !input.isSessionClosed(sessionId)) {
        continue;
      }
      const repoRoot = await mainRepoRootOf(path);
      if (repoRoot !== undefined) {
        await removeWorktree({ repoRoot, path });
      } else {
        await rm(path, { recursive: true, force: true });
      }
      removed.push(path);
    }
    // Tidy an emptied repoKey directory; failure (still occupied) is fine.
    await rmdir(keyDir).catch(() => {});
  }
  return { removed };
}
