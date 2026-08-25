import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { DaemonHandle } from "@aaroncx/engine";

/**
 * A real monadd with the fake ACP agent, and a real repository published as
 * a pull request through a local bare origin (refs/pull/<n>/head, exactly
 * like GitHub's). No gh, no network, no vendor.
 *
 * Modeled on apps/daemon/test/review.test.ts, which proved this shape works;
 * what the hook's end-to-end test adds is the webhook in front of it.
 */

const DAEMON_MAIN = new URL("../../../daemon/src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL(
  "../../../../packages/backends/test/fixtures/fake-agent.ts",
  import.meta.url,
).pathname;

export function git(cwd: string, ...args: string[]): string {
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

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface RunningDaemon {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  handle: DaemonHandle;
  home: string;
}

export async function bootDaemon(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<RunningDaemon> {
  const infoPath = join(home, "monadd.json");
  rmSync(infoPath, { force: true });
  const proc = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT, "--review"].join(" "),
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(infoPath), "monadd.json to appear");
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as {
    port: number;
    pid: number;
    startedAt: string;
  };
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return {
    proc,
    home,
    handle: { url: `http://127.0.0.1:${info.port}`, token, info },
  };
}

/**
 * A stand-in for bun that runs the manifest's preinstall script, the way a
 * real install does. Pointed at through MONAD_BUN_BIN so an install still
 * executes the PR's own code if one ever happens.
 */
export function writeFakeBun(dir: string): string {
  const path = join(dir, "fake-bun.sh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `script=$(sed -n 's/.*"preinstall": "\\(.*\\)".*/\\1/p' package.json 2>/dev/null)`,
      'if [ -n "$script" ]; then sh -c "$script"; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

/** Wraps a repo as a pull request: a bare origin carrying refs/pull/<n>/head. */
export function publishAsPr(
  seed: string,
  headSha: string,
  number: number,
): { repoRoot: string; tempDirs: string[] } {
  const bareParent = mkdtempSync(join(tmpdir(), "monad-hook-origin-"));
  const bare = join(bareParent, "origin.git");
  git(bareParent, "clone", "-q", "--bare", seed, bare);
  git(bare, "update-ref", `refs/pull/${number}/head`, headSha);
  const branches = git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  for (const branch of branches.split("\n").map((line) => line.trim())) {
    if (branch && branch !== "main") {
      git(bare, "branch", "-q", "-D", branch);
    }
  }
  const cloneParent = mkdtempSync(join(tmpdir(), "monad-hook-clone-"));
  const repoRoot = join(cloneParent, "checkout");
  git(cloneParent, "clone", "-q", bare, repoRoot);
  return { repoRoot, tempDirs: [bareParent, cloneParent] };
}
