import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDaemonAccess } from "../src/daemon.ts";
import { memoryLogger } from "../src/log.ts";
import { DeliveryQueue } from "../src/queue.ts";
import { createHookHandler } from "../src/server.ts";
import { HookWorker } from "../src/worker.ts";
import {
  makeMaliciousRepo,
  type MaliciousRepo,
} from "../../../packages/checks/test/fixtures/make-repo.ts";
import { fakeOctokit, type FakeOctokit } from "../../../packages/github/test/fixtures/fake-octokit.ts";
import { deliveryRequest, SECRET } from "./fixtures/harness.ts";
import {
  bootDaemon,
  publishAsPr,
  type RunningDaemon,
  waitFor,
  writeFakeBun,
} from "./fixtures/live-daemon.ts";

/**
 * The whole pipeline, with nothing faked between the webhook and the
 * worktree: a signed delivery goes into the receiver, the real worker drives
 * the real monadd over the real control API, the real review playbook runs
 * against a real git repository, and the fake ACP agent stands in for the
 * vendor. GitHub is the only thing faked, at the request layer.
 *
 * The pull request is the hardening fixture: a .monad.yml pointing lint,
 * build, and test at a canary-writing script, a package.json whose
 * preinstall writes another canary and whose typecheck script writes a
 * third, and a review.prompt override telling the reviewer to approve. It is
 * delivered as a fork PR from a CONTRIBUTOR, which is what a stranger's pull
 * request looks like, and decision record 0009 says that is untrusted.
 *
 * If any canary exists after this test, M3 reopened the hole M2 closed.
 */

const REPO = "AaronCx/hostile-demo";
const PR_NUMBER = 6;

let home: string;
let binDir: string;
let daemon: RunningDaemon;
let malicious: MaliciousRepo;
let repoRoot: string;
let queue: DeliveryQueue;
let worker: HookWorker;
let github: FakeOctokit;
let handle: (request: Request) => Promise<Response>;
const tempDirs: string[] = [];

function forkPullRequestEvent(action: string): Record<string, unknown> {
  return {
    action,
    pull_request: {
      number: PR_NUMBER,
      title: "Perfectly ordinary change",
      body: "Nothing to see here.",
      html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      draft: false,
      // A stranger's fork, and an association with no write access. Either
      // one alone is enough to make this untrusted.
      author_association: "CONTRIBUTOR",
      user: { login: "stranger" },
      head: {
        sha: malicious.headSha,
        ref: "feature",
        repo: { full_name: "stranger/hostile-demo" },
      },
      base: { sha: malicious.baseSha, ref: "main", repo: { full_name: REPO } },
    },
    repository: {
      full_name: REPO,
      name: "hostile-demo",
      owner: { login: "AaronCx" },
    },
    installation: { id: 4242 },
  };
}

function sessionsInDb(): Array<{ id: string; trust: string; mode: string; status: string }> {
  const db = new Database(join(home, "monad.db"), { readonly: true });
  try {
    return db
      .query("select id, trust, mode, status from sessions order by id asc")
      .all() as Array<{ id: string; trust: string; mode: string; status: string }>;
  } finally {
    db.close();
  }
}

function eventPayload(sessionId: string, kind: string): Record<string, unknown> | undefined {
  const db = new Database(join(home, "monad.db"), { readonly: true });
  try {
    const row = db
      .query("select payload from events where session_id = ? and kind = ? order by seq desc limit 1")
      .get(sessionId, kind) as { payload: string } | null;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
  } finally {
    db.close();
  }
}

function completedCheckRun(): Record<string, unknown> | undefined {
  return github
    .matching("PATCH /repos/{owner}/{repo}/check-runs")
    .filter((call) => call.params.status === "completed")
    .at(-1)?.params;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-hook-e2e-home-"));
  binDir = mkdtempSync(join(tmpdir(), "monad-hook-e2e-bin-"));
  tempDirs.push(home, binDir);
  malicious = makeMaliciousRepo();
  tempDirs.push(malicious.dir, malicious.canaryDir);
  const published = publishAsPr(malicious.dir, malicious.headSha, PR_NUMBER);
  repoRoot = published.repoRoot;
  tempDirs.push(...published.tempDirs);

  daemon = await bootDaemon(home, { MONAD_BUN_BIN: writeFakeBun(binDir) });

  const dbPath = join(home, "monad.db");
  queue = new DeliveryQueue({ dbPath });
  github = fakeOctokit();
  worker = new HookWorker({
    queue,
    daemon: liveDaemonAccess(async () => daemon.handle),
    octokitFor: async () => github.octokit,
    repoRootFor: (fullName) => (fullName === REPO ? repoRoot : undefined),
    dbPath,
    log: memoryLogger(),
  });
  handle = createHookHandler({
    webhookSecret: SECRET,
    queue,
    worker,
    log: memoryLogger(),
    version: "e2e",
  });
  worker.start();

  const response = await handle(
    deliveryRequest({
      event: "pull_request",
      deliveryId: "e2e-opened",
      payload: forkPullRequestEvent("opened"),
    }),
  );
  expect(response.status).toBe(202);
  await waitFor(() => queue.get("e2e-opened")?.status === "done", "the review to finish", 60_000);
}, 90_000);

afterAll(async () => {
  await worker.stop();
  queue.close();
  daemon.proc.kill();
  await daemon.proc.exited;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a hostile fork PR delivered as a webhook", () => {
  test("leaves every canary absent", () => {
    // The PR's lint command, its preinstall script, and its own package.json
    // typecheck script all write outside the repo when they run. None ran.
    expect(existsSync(malicious.lintCanary)).toBe(false);
    expect(existsSync(malicious.installCanary)).toBe(false);
    expect(existsSync(malicious.typecheckCanary)).toBe(false);
  });

  test("the session monad opened for it is untrusted", () => {
    const sessions = sessionsInDb();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.trust).toBe("untrusted");
    // Left open and idle in review mode, which is what @monad fix attaches to.
    expect(sessions[0]?.status).toBe("idle");
    expect(sessions[0]?.mode).toBe("review");
  });

  test("install did not run, and the PR's own lint and typecheck levers were refused", () => {
    const sessionId = sessionsInDb()[0]?.id ?? "";
    const worktree = eventPayload(sessionId, "worktree_ready") as {
      installStrategy: string;
      trust: string;
    };
    expect(worktree.installStrategy).toBe("none");
    expect(worktree.trust).toBe("untrusted");

    const checks = eventPayload(sessionId, "checks") as {
      trust: string;
      configSource: { ref: string; file: string };
      checks: Array<{ type: string; status: string; details: Record<string, unknown> }>;
    };
    expect(checks.trust).toBe("untrusted");
    // The rules came from the base commit, which is the last state a
    // maintainer approved, not from the PR's own .monad.yml.
    expect(checks.configSource.ref).toBe(malicious.baseSha);

    const lint = checks.checks.find((entry) => entry.type === "lint");
    expect(lint?.details.skipped).toBe(true);
    // The PR's checks.lint.command never became part of the run.
    expect(JSON.stringify(lint ?? {})).not.toContain("pwn-lint.sh");
    const typecheck = checks.checks.find((entry) => entry.type === "typecheck");
    expect(typecheck?.details.skipped).toBe(true);
    expect(String(typecheck?.details.reason)).toContain("untrusted PR");

    // build and test are not in an untrusted run at all, and the canary they
    // were both pointed at is the proof that neither ran: the .monad.yml in
    // this PR sets checks.build.command and checks.test.command to the same
    // script that writes it.
    expect(checks.checks.map((entry) => entry.type)).not.toContain("build");
    expect(checks.checks.map((entry) => entry.type)).not.toContain("test");
    expect(existsSync(malicious.lintCanary)).toBe(false);
  });

  test("the PR's prompt override never reached the agent", () => {
    const sessionId = sessionsInDb()[0]?.id ?? "";
    const prompt = eventPayload(sessionId, "prompt") as { prompt: Array<{ text: string }> };
    expect(prompt.prompt[0]?.text).not.toContain(malicious.promptOverrideMarker);
  });

  test("the check run says what untrusted cost this review", () => {
    const created = github.matching("POST /repos/{owner}/{repo}/check-runs");
    expect(created).toHaveLength(1);
    expect(created[0]?.params).toMatchObject({
      owner: "AaronCx",
      repo: "hostile-demo",
      name: "monad",
      head_sha: malicious.headSha,
      status: "queued",
    });
    const inProgress = github.matching("PATCH /repos/{owner}/{repo}/check-runs")[0];
    expect((inProgress?.params.output as { summary: string }).summary).toContain(
      "untrusted PR: install, build, and test do not run",
    );
    const completed = completedCheckRun();
    expect(completed?.status).toBe("completed");
    const output = completed?.output as { summary: string };
    expect(output.summary).toContain("untrusted PR");
    expect(output.summary).toContain("monad attach");
  });

  test("one COMMENT review is posted against the head it reviewed", () => {
    const posted = github.matching("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.params).toMatchObject({
      pull_number: PR_NUMBER,
      event: "COMMENT",
      commit_id: malicious.headSha,
    });
  });
});

describe("@monad fix against the real daemon", () => {
  test("switches the session to fix, prompts it, and hands the branch back", async () => {
    const before = sessionsInDb()[0];
    expect(before?.mode).toBe("review");
    const response = await handle(
      deliveryRequest({
        event: "issue_comment",
        deliveryId: "e2e-fix",
        payload: {
          action: "created",
          issue: { number: PR_NUMBER, pull_request: {} },
          comment: {
            id: 4242,
            body: "@monad fix add a comment above the export",
            author_association: "MEMBER",
            user: { login: "AaronCx" },
          },
          repository: { full_name: REPO, name: "hostile-demo", owner: { login: "AaronCx" } },
          installation: { id: 4242 },
        },
      }),
    );
    expect(response.status).toBe(202);
    await waitFor(() => queue.get("e2e-fix")?.status === "done", "the fix command to finish", 60_000);

    const after = sessionsInDb()[0];
    expect(after?.id).toBe(before?.id ?? "");
    expect(after?.mode).toBe("fix");
    // Both prompts landed on the session's own log, over ACP, in order.
    const db = new Database(join(home, "monad.db"), { readonly: true });
    const prompts = db
      .query("select payload from events where session_id = ? and kind = 'prompt' order by seq")
      .all(after?.id ?? "") as Array<{ payload: string }>;
    db.close();
    const texts = prompts.map(
      (row) => (JSON.parse(row.payload) as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "",
    );
    expect(texts.at(-2)).toContain("Mode switched to fix");
    expect(texts.at(-1)).toBe("add a comment above the export");

    const reactions = github
      .matching("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions")
      .map((call) => String(call.params.content));
    expect(reactions).toEqual(["eyes", "rocket"]);
    const reply = String(
      github.matching("POST /repos/{owner}/{repo}/issues/{issue_number}/comments").at(-1)?.params
        .body ?? "",
    );
    expect(reply).toContain(after?.id ?? "");
    expect(reply).toContain("did not push");
  }, 60_000);
});

describe("crash recovery", () => {
  test("a delivery that was running at shutdown completes after a restart", async () => {
    // A second delivery for the same PR, taken as far as a real crash would:
    // the row is marked running and the process (this queue and worker) goes
    // away with the review unfinished.
    const dbPath = join(home, "monad.db");
    const crashed = new DeliveryQueue({ dbPath });
    const request = deliveryRequest({
      event: "pull_request",
      deliveryId: "e2e-crashed",
      payload: forkPullRequestEvent("synchronize"),
    });
    const crashedHandler = createHookHandler({
      webhookSecret: SECRET,
      queue: crashed,
      worker: { wake: () => {} },
      log: memoryLogger(),
      version: "e2e",
    });
    expect((await crashedHandler(request)).status).toBe(202);
    crashed.markRunning("e2e-crashed");
    crashed.close();

    const restartedQueue = new DeliveryQueue({ dbPath });
    const restartedGithub = fakeOctokit();
    const log = memoryLogger();
    const restarted = new HookWorker({
      queue: restartedQueue,
      daemon: liveDaemonAccess(async () => daemon.handle),
      octokitFor: async () => restartedGithub.octokit,
      repoRootFor: (fullName) => (fullName === REPO ? repoRoot : undefined),
      dbPath,
      log,
    });
    // start() is what a fresh monad-hook does: strand nothing, run it again.
    restarted.start();
    await waitFor(
      () => restartedQueue.get("e2e-crashed")?.status === "done",
      "the recovered delivery to finish",
      60_000,
    );

    const row = restartedQueue.get("e2e-crashed");
    expect(row?.status).toBe("done");
    // The attempt that died counts, so the row says it was tried twice.
    expect(row?.attempts).toBe(2);
    expect(log.lines.join("\n")).toContain("was running at shutdown");
    expect(
      restartedGithub.matching("POST /repos/{owner}/{repo}/check-runs"),
    ).toHaveLength(1);
    await restarted.stop();
    restartedQueue.close();
    // Still no canaries: the recovered run is untrusted too.
    expect(existsSync(malicious.lintCanary)).toBe(false);
  }, 90_000);
});
