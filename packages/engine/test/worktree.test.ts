import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  fetchPullRequestHead,
  gcWorktrees,
  installWorktreeDeps,
  MONAD_BUN_BIN_ENV,
  removeWorktree,
  repoKey,
  resolveBaseSha,
  worktreesRoot,
} from "../src/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

let scratch: string;
let monadHome: string;
let env: Record<string, string | undefined>;
/** A local clone with an origin, package.json, and bun.lock. */
let repoDir: string;
/** The bare origin the clone points at. */
let originDir: string;
let baseSha = "";
let prHeadSha = "";
/** Recording fake installer plus its log. */
let recorderBin: string;
let recorderLog: string;
let failingBin: string;

function recordedCalls(): string[] {
  if (!existsSync(recorderLog)) {
    return [];
  }
  return readFileSync(recorderLog, "utf8").trim().split("\n").filter(Boolean);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "monad-worktree-"));
  monadHome = join(scratch, "monad-home");
  env = { ...process.env, MONAD_HOME: monadHome };

  // Seed repo -> bare origin -> working clone, so origin-based flows
  // (PR head fetch, base sha, repoKey) run against a real remote.
  const seed = join(scratch, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "package.json"), '{ "name": "wt-fixture", "private": true }\n');
  writeFileSync(join(seed, "bun.lock"), "lockfileVersion: fixture\n");
  writeFileSync(join(seed, "readme.md"), "base\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "chore: base");
  baseSha = git(seed, "rev-parse", "HEAD");
  // A PR branch, then expose it the way GitHub does: refs/pull/<n>/head.
  git(seed, "checkout", "-q", "-b", "pr-branch");
  writeFileSync(join(seed, "feature.txt"), "pr change\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "feat: pr change");
  prHeadSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");

  originDir = join(scratch, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, originDir]);
  git(originDir, "update-ref", "refs/pull/7/head", prHeadSha);
  // Bare mirrors of local branches would shadow the test; drop the branch ref
  // so the PR head is reachable ONLY through refs/pull/7/head, like GitHub.
  git(originDir, "update-ref", "-d", "refs/heads/pr-branch");

  repoDir = join(scratch, "clone");
  execFileSync("git", ["clone", "-q", originDir, repoDir]);

  recorderLog = join(scratch, "installer-calls.log");
  recorderBin = join(scratch, "fake-bun.sh");
  writeFileSync(recorderBin, `#!/bin/sh\necho "$PWD $@" >> ${recorderLog}\nexit 0\n`);
  chmodSync(recorderBin, 0o755);
  failingBin = join(scratch, "failing-bun.sh");
  writeFileSync(failingBin, '#!/bin/sh\necho "lockfile had changes" >&2\nexit 1\n');
  chmodSync(failingBin, 0o755);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("createWorktree", () => {
  test("creates a detached worktree under MONAD_HOME/worktrees/<repoKey>/<sessionId>", async () => {
    const sessionId = "sess-create";
    const { path } = await createWorktree({ repoRoot: repoDir, sha: baseSha, sessionId, env });
    const key = await repoKey(repoDir);
    expect(path).toBe(join(worktreesRoot(env), key, sessionId));
    expect(existsSync(path)).toBe(true);
    expect(git(path, "rev-parse", "HEAD")).toBe(baseSha);
    // Detached: symbolic-ref on HEAD must fail.
    expect(() => git(path, "symbolic-ref", "-q", "HEAD")).toThrow();
    // Registered with the main repo.
    expect(git(repoDir, "worktree", "list")).toContain(sessionId);
    await removeWorktree({ repoRoot: repoDir, path });
    expect(existsSync(path)).toBe(false);
    expect(git(repoDir, "worktree", "list")).not.toContain(sessionId);
  });

  test("refuses to reuse an occupied worktree path", async () => {
    const sessionId = "sess-occupied";
    const { path } = await createWorktree({ repoRoot: repoDir, sha: baseSha, sessionId, env });
    expect(
      createWorktree({ repoRoot: repoDir, sha: baseSha, sessionId, env }),
    ).rejects.toThrow(/already exists/);
    await removeWorktree({ repoRoot: repoDir, path });
  });
});

describe("PR head and base resolution", () => {
  test("fetchPullRequestHead materializes refs/monad/pr/<n>", async () => {
    const { headSha, ref } = await fetchPullRequestHead({ repoRoot: repoDir, number: 7 });
    expect(ref).toBe("refs/monad/pr/7");
    expect(headSha).toBe(prHeadSha);
    expect(git(repoDir, "rev-parse", "refs/monad/pr/7")).toBe(prHeadSha);
  });

  test("resolveBaseSha computes the merge base against origin's base ref", async () => {
    const { baseSha: resolved } = await resolveBaseSha({
      repoRoot: repoDir,
      baseRef: "main",
      headSha: prHeadSha,
    });
    expect(resolved).toBe(baseSha);
  });
});

describe("install strategy (decision 0008)", () => {
  async function freshWorktree(sessionId: string): Promise<string> {
    const { path } = await createWorktree({ repoRoot: repoDir, sha: baseSha, sessionId, env });
    return path;
  }

  test("auto ALWAYS runs a frozen install, even with byte-identical lockfiles, and never symlinks", async () => {
    // The worktree is at the same commit as the main checkout, so bun.lock is
    // byte-identical; decision 0008 forbids the symlink fast path anyway.
    const path = await freshWorktree("sess-auto");
    rmSync(recorderLog, { force: true });
    const result = await installWorktreeDeps({
      path,
      strategy: "auto",
      env: { ...env, [MONAD_BUN_BIN_ENV]: recorderBin },
    });
    expect(result.installStrategy).toBe("install");
    expect(result.installMs).toBeGreaterThanOrEqual(0);
    expect(result.warnings).toEqual([]);
    const calls = recordedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${realpathSync(path)} install --frozen-lockfile`);
    // No node_modules symlink was planted.
    expect(() => lstatSync(join(path, "node_modules"))).toThrow();
    await removeWorktree({ repoRoot: repoDir, path });
  });

  test('config "symlink" warns citing decision 0008 and installs', async () => {
    const path = await freshWorktree("sess-symlink");
    rmSync(recorderLog, { force: true });
    const result = await installWorktreeDeps({
      path,
      strategy: "symlink",
      env: { ...env, [MONAD_BUN_BIN_ENV]: recorderBin },
    });
    expect(result.installStrategy).toBe("install");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("0008");
    expect(recordedCalls()).toHaveLength(1);
    expect(() => lstatSync(join(path, "node_modules"))).toThrow();
    await removeWorktree({ repoRoot: repoDir, path });
  });

  test('"none" skips the installer entirely', async () => {
    const path = await freshWorktree("sess-none");
    rmSync(recorderLog, { force: true });
    const result = await installWorktreeDeps({
      path,
      strategy: "none",
      env: { ...env, [MONAD_BUN_BIN_ENV]: recorderBin },
    });
    expect(result).toEqual({ installStrategy: "none", installMs: 0, warnings: [] });
    expect(recordedCalls()).toHaveLength(0);
    await removeWorktree({ repoRoot: repoDir, path });
  });

  test("a repo without package.json implies none", async () => {
    const bareDir = join(scratch, "non-js");
    execFileSync("git", ["init", "-q", "-b", "main", bareDir]);
    writeFileSync(join(bareDir, "notes.txt"), "no js here\n");
    git(bareDir, "add", "-A");
    git(bareDir, "commit", "-q", "-m", "chore: non-js");
    const sha = git(bareDir, "rev-parse", "HEAD");
    const { path } = await createWorktree({
      repoRoot: bareDir,
      sha,
      sessionId: "sess-nonjs",
      env,
    });
    rmSync(recorderLog, { force: true });
    const result = await installWorktreeDeps({
      path,
      strategy: "install",
      env: { ...env, [MONAD_BUN_BIN_ENV]: recorderBin },
    });
    expect(result.installStrategy).toBe("none");
    expect(recordedCalls()).toHaveLength(0);
    await removeWorktree({ repoRoot: bareDir, path });
  });

  test("a frozen-install failure surfaces as a loud error, not a mutated install", async () => {
    const path = await freshWorktree("sess-frozen-fail");
    expect(
      installWorktreeDeps({
        path,
        strategy: "install",
        env: { ...env, [MONAD_BUN_BIN_ENV]: failingBin },
      }),
    ).rejects.toThrow(/frozen-lockfile.*lockfile had changes/s);
    await removeWorktree({ repoRoot: repoDir, path });
  });
});

describe("gcWorktrees", () => {
  test("removes only closed sessions' worktrees past the cutoff", async () => {
    const closed = await createWorktree({
      repoRoot: repoDir,
      sha: baseSha,
      sessionId: "sess-gc-closed",
      env,
    });
    const open = await createWorktree({
      repoRoot: repoDir,
      sha: baseSha,
      sessionId: "sess-gc-open",
      env,
    });
    // Everything qualifies age-wise (cutoff is "now"); the closed predicate
    // is the only gate under test.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { removed } = await gcWorktrees({
      olderThanDays: 0,
      isSessionClosed: (sessionId) => sessionId === "sess-gc-closed",
      env,
    });
    expect(removed).toEqual([closed.path]);
    expect(existsSync(closed.path)).toBe(false);
    expect(existsSync(open.path)).toBe(true);
    // The closed worktree was deregistered from the main repo too.
    expect(git(repoDir, "worktree", "list")).not.toContain("sess-gc-closed");
    expect(git(repoDir, "worktree", "list")).toContain("sess-gc-open");
    await removeWorktree({ repoRoot: repoDir, path: open.path });
  });

  test("a young worktree survives even when its session is closed", async () => {
    const young = await createWorktree({
      repoRoot: repoDir,
      sha: baseSha,
      sessionId: "sess-gc-young",
      env,
    });
    const { removed } = await gcWorktrees({
      olderThanDays: 7,
      isSessionClosed: () => true,
      env,
    });
    expect(removed).toEqual([]);
    expect(existsSync(young.path)).toBe(true);
    await removeWorktree({ repoRoot: repoDir, path: young.path });
  });
});
