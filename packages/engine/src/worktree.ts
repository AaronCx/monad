import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TrustLevel } from "@aaroncx/protocol";
import { monadStateDir } from "./paths.ts";

/**
 * Review worktrees: detached git checkouts under ~/.monad/worktrees, one per
 * session, so a review never touches the user's main checkout.
 *
 * What monad writes into the main repo, and nothing else:
 * 1. refs/monad/pr/<n>, the namespaced ref a PR head is materialized as.
 * 2. .git/worktrees/<name>, git's own bookkeeping for a registered
 *    worktree; `git worktree add` cannot exist without it, and
 *    removeWorktree unregisters it again.
 * 3. refs/remotes/origin/<baseRef> plus the fetched objects, from the
 *    `git fetch origin <baseRef>` that resolveBaseSha needs before it can
 *    compute a merge base. Fetching a remote-tracking ref is the ordinary
 *    meaning of a fetch and is the same write `git fetch` would make on its
 *    own.
 * None of the three touch the working tree, the index, HEAD, a local
 * branch, a stash, or a config value. A dirty main checkout stays exactly
 * as dirty as it was.
 *
 * Install strategy per decision record 0008: symlinking node_modules from
 * the main checkout is structurally broken under bun's isolated linker and
 * is never performed. `auto` and `install` both run
 * `bun install --frozen-lockfile` in the worktree (about 0.1 s warm); a
 * frozen-install failure surfaces as a loud error, never a mutated install.
 */

/**
 * PR numbers and branch names arrive from `gh pr view` on a repo monad did
 * not write, so they are untrusted input to a git command line. git treats
 * a leading dash as an option, and options such as --upload-pack turn a
 * fetch into arbitrary command execution on this machine. Validate both
 * before they reach argv rather than trusting the caller.
 */
function assertPrNumber(number: number): string {
  const digits = String(number);
  if (!/^[1-9][0-9]{0,8}$/.test(digits)) {
    throw new Error(`not a PR number: ${digits}`);
  }
  return digits;
}

/** Conservative git ref name: no leading dash, no option or path traversal. */
function assertRefName(name: string, what: string): string {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/.test(name) || name.includes("..")) {
    throw new Error(`${what} is not a valid git ref name: ${name}`);
  }
  return name;
}

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
  /** The session's trust level, so the transcript says why install was skipped. */
  trust?: TrustLevel;
  /** Non-fatal notes from the install decision. */
  warnings?: string[];
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
  const number = assertPrNumber(input.number);
  const ref = `refs/monad/pr/${number}`;
  await git(["fetch", "origin", `+refs/pull/${number}/head:${ref}`], input.repoRoot);
  const headSha = (await git(["rev-parse", ref], input.repoRoot)).trim();
  return { headSha, ref };
}

/**
 * The merge base of a PR against its base branch: fetch the base ref from
 * origin, then merge-base origin/<baseRef> with the head sha. The fetch
 * updates refs/remotes/origin/<baseRef> in the main repo (item 3 of the
 * write list at the top of this file); no local branch and no working tree
 * is touched.
 */
export async function resolveBaseSha(input: {
  repoRoot: string;
  baseRef: string;
  headSha: string;
}): Promise<{ baseSha: string }> {
  const baseRef = assertRefName(input.baseRef, "base ref");
  await git(["fetch", "origin", baseRef], input.repoRoot);
  const baseSha = (
    await git(["merge-base", `origin/${baseRef}`, input.headSha], input.repoRoot)
  ).trim();
  return { baseSha };
}

export interface InstallWorktreeDepsInput {
  /** The worktree path dependencies are installed into. */
  path: string;
  /** From review.install config. Default "auto". */
  strategy?: InstallStrategy;
  env?: Record<string, string | undefined>;
  /**
   * Whose code the worktree holds (decision record 0009). Installing runs
   * the tree's own lifecycle scripts, so an untrusted worktree is never
   * installed unless a human asked for it. Absent means trusted, the M2
   * behavior: this is a library entry point whose caller chose the path.
   * Default deny lives at the session boundary, where the review playbook
   * resolves an absent trust level to untrusted before calling in.
   */
  trust?: TrustLevel;
  /** --install: a human overriding the untrusted default, knowingly. */
  force?: boolean;
}

/** Printed when an untrusted worktree is left uninstalled. */
export const UNTRUSTED_INSTALL_SKIPPED =
  "untrusted PR: dependencies were not installed, so lint and typecheck are limited to what " +
  "runs without node_modules";

/** Printed when --install overrides that. */
export const UNTRUSTED_INSTALL_FORCED =
  "--install on an untrusted PR: bun install runs this PR's own lifecycle scripts " +
  "(preinstall, postinstall) on this machine";

/**
 * Applies the install strategy to a fresh worktree, per decision 0008:
 * - `auto` and `install`: always `bun install --frozen-lockfile` in the
 *   worktree. No symlink fast path exists, even with byte-identical
 *   lockfiles (root-only symlinks break bun's isolated linker and can make
 *   dependents resolve the MAIN checkout's sources).
 * - `symlink` (from config): warns citing decision 0008 and installs.
 * - `none`: skips; dependent checks report skipped.
 * - Non-JS repos (no package.json): none is implied.
 * - An untrusted worktree (decision record 0009): none, whatever the
 *   strategy says, unless `force` (the --install flag) is set. Installing
 *   executes the tree's own lifecycle scripts, which is a code-execution
 *   decision, not a performance one.
 * A frozen-install failure throws with the installer output; it must never
 * degrade into a lockfile-mutating install.
 */
export async function installWorktreeDeps(input: InstallWorktreeDepsInput): Promise<InstallResult> {
  const env = input.env ?? process.env;
  const strategy = input.strategy ?? "auto";
  const trust: TrustLevel = input.trust ?? "trusted";
  const warnings: string[] = [];

  if (!existsSync(join(input.path, "package.json"))) {
    return { installStrategy: "none", installMs: 0, warnings };
  }
  if (strategy === "none") {
    return { installStrategy: "none", installMs: 0, warnings };
  }
  if (trust === "untrusted") {
    if (!input.force) {
      return { installStrategy: "none", installMs: 0, warnings: [UNTRUSTED_INSTALL_SKIPPED] };
    }
    warnings.push(UNTRUSTED_INSTALL_FORCED);
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
