import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelSession, streamReview } from "@aaroncx/engine";
import { liveDaemonAccess } from "../src/daemon.ts";
import { memoryLogger } from "../src/log.ts";
import { DeliveryQueue } from "../src/queue.ts";
import { createHookHandler } from "../src/server.ts";
import { HookWorker } from "../src/worker.ts";
import { fakeOctokit, type FakeOctokit } from "../../../packages/github/test/fixtures/fake-octokit.ts";
import { deliveryRequest, SECRET } from "./fixtures/harness.ts";
import { bootDaemon, git, publishAsPr, type RunningDaemon, waitFor } from "./fixtures/live-daemon.ts";

/**
 * Fix mode from a webhook never pushes, proved rather than asserted from the
 * reply text.
 *
 * The M2 policy forwards a permission request it cannot decide (git push
 * above all) to the attached human and holds it when nobody is attached.
 * monad-hook connects over ACP to send the fix prompt, which would make it
 * the attached client, so it answers no permission request at all: its
 * handler rejects, the daemon treats that like a client that vanished, and
 * the request is held for whoever runs `monad attach <id>`.
 *
 * The fake agent asks for permission when a prompt mentions "perm", so this
 * drives the whole path: the session goes to waiting_for_permission, the log
 * shows the request and no resolution, and nothing ran. Cancelling is what
 * releases it, exactly as it would be for a real push.
 */

const REPO = "AaronCx/hold-demo";
const PR_NUMBER = 3;

let home: string;
let daemon: RunningDaemon;
let queue: DeliveryQueue;
let worker: HookWorker;
let github: FakeOctokit;
let handle: (request: Request) => Promise<Response>;
let sessionId: string;
const tempDirs: string[] = [];

function events(kind: string): unknown[] {
  const db = new Database(join(home, "monad.db"), { readonly: true });
  try {
    return db
      .query("select payload from events where session_id = ? and kind = ?")
      .all(sessionId, kind);
  } finally {
    db.close();
  }
}

async function sessionStatus(): Promise<string> {
  const response = await fetch(`${daemon.handle.url}/v1/sessions`, {
    headers: { Authorization: `Bearer ${daemon.handle.token}` },
  });
  const { sessions } = (await response.json()) as Array<never> & {
    sessions: Array<{ id: string; status: string; mode: string }>;
  };
  return sessions.find((record) => record.id === sessionId)?.status ?? "gone";
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-hook-hold-home-"));
  tempDirs.push(home);
  const seed = mkdtempSync(join(tmpdir(), "monad-hook-hold-repo-"));
  tempDirs.push(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# hold fixture\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "chore: base");
  git(seed, "checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "app.txt"), "one\ntwo\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "feat: add app");
  const headSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");
  const published = publishAsPr(seed, headSha, PR_NUMBER);
  tempDirs.push(...published.tempDirs);

  // The plain fake agent, not --review: this test is about a permission
  // request, and the review behavior never issues one.
  daemon = await bootDaemon(home, {
    MONAD_BACKEND_CMD: [
      process.execPath,
      new URL("../../../packages/backends/test/fixtures/fake-agent.ts", import.meta.url).pathname,
    ].join(" "),
  });

  const result = await streamReview(
    daemon.handle,
    {
      repoRoot: published.repoRoot,
      pr: {
        repo: REPO,
        number: PR_NUMBER,
        url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
        title: "Add app",
        headSha,
        baseRef: "main",
      },
      trust: "untrusted",
    },
    () => {},
  );
  sessionId = result.sessionId;

  const dbPath = join(home, "monad.db");
  queue = new DeliveryQueue({ dbPath });
  github = fakeOctokit();
  worker = new HookWorker({
    queue,
    daemon: liveDaemonAccess(async () => daemon.handle),
    octokitFor: async () => github.octokit,
    repoRootFor: () => published.repoRoot,
    dbPath,
    log: memoryLogger(),
  });
  handle = createHookHandler({
    webhookSecret: SECRET,
    queue,
    worker,
    log: memoryLogger(),
    version: "hold",
  });
  worker.start();
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

test("a permission request from a webhook-run fix session is held, not answered", async () => {
  const response = await handle(
    deliveryRequest({
      event: "issue_comment",
      deliveryId: "hold-fix",
      payload: {
        action: "created",
        issue: { number: PR_NUMBER, pull_request: {} },
        comment: {
          id: 77,
          // "perm" is what makes the fake agent ask for permission.
          body: "@monad fix rewrite the perm handling",
          author_association: "OWNER",
          user: { login: "AaronCx" },
        },
        repository: { full_name: REPO, name: "hold-demo", owner: { login: "AaronCx" } },
        installation: { id: 4242 },
      },
    }),
  );
  expect(response.status).toBe(202);

  await waitFor(async () => (await sessionStatus()) === "waiting_for_permission", "the hold");

  // Asked, and left unanswered: nobody is attached, and monad-hook is not a
  // substitute for one.
  expect(events("permission_requested")).toHaveLength(1);
  expect(events("permission_resolved")).toHaveLength(0);
  // The command is still in flight, exactly as a held push would be.
  expect(queue.get("hold-fix")?.status).toBe("running");

  // Cancelling releases the hold, which is what a human answering (or
  // walking away) does.
  await cancelSession(daemon.handle, sessionId);
  await waitFor(
    () => queue.get("hold-fix")?.status !== "running",
    "the command to finish after the cancel",
  );
  expect(events("permission_resolved")).toHaveLength(1);
}, 60_000);
