import { afterEach, describe, expect, test } from "bun:test";
import { FIX_MODE_PROMPT, SessionStore } from "@aaroncx/engine";
import { pullRequest } from "../../../packages/github/test/fixtures/payloads.ts";
import { sessionRecord } from "./fixtures/fake-daemon.ts";
import { deliveryRequest, harness, type Harness } from "./fixtures/harness.ts";

/**
 * Comment commands, and the gate on the one that edits files.
 *
 * @monad fix runs the agent in fix mode inside the worktree, so the check on
 * who may ask for it is the check that matters most in M3. It reads
 * author_association out of the payload GitHub signed: the comment's text
 * cannot claim it, and no API call can be made to disagree with it.
 */

let h: Harness;

afterEach(async () => {
  h.daemon.settleAll();
  await h.worker.stop();
  h.close();
});

const REPOSITORY = {
  full_name: "AaronCx/monad-review-demo",
  name: "monad-review-demo",
  owner: { login: "AaronCx" },
};

function commentDelivery(
  deliveryId: string,
  body: string,
  association: string,
  login = "AaronCx",
): Request {
  return deliveryRequest({
    event: "issue_comment",
    deliveryId,
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { id: 991, body, author_association: association, user: { login } },
      repository: REPOSITORY,
      installation: { id: 4242 },
    },
  });
}

function reactions(current: Harness): string[] {
  return current.github
    .matching("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions")
    .map((call) => String(call.params.content));
}

function replies(current: Harness): string[] {
  return current.github
    .matching("POST /repos/{owner}/{repo}/issues/{issue_number}/comments")
    .map((call) => String(call.params.body));
}

describe("@monad fix", () => {
  test("a CONTRIBUTOR is refused, and no session enters fix mode", async () => {
    h = harness();
    h.daemon.sessionList = [
      sessionRecord({ pr: { repo: REPOSITORY.full_name, number: 7 } as never }),
    ];
    await h.handle(commentDelivery("d-fix-refused", "@monad fix delete the tests", "CONTRIBUTOR", "stranger"));
    await h.worker.idle();

    expect(reactions(h)).toEqual(["-1"]);
    expect(h.daemon.modeSwitches).toHaveLength(0);
    expect(h.daemon.prompts).toHaveLength(0);
    expect(replies(h)).toHaveLength(0);
    const row = h.queue.get("d-fix-refused");
    expect(row?.status).toBe("done");
    expect(row?.error).toContain("not write access");
  });

  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    test(`a ${association} runs fix mode on the pull request's session`, async () => {
      h = harness();
      const record = sessionRecord({ pr: { repo: REPOSITORY.full_name, number: 7 } as never });
      h.daemon.sessionList = [record];
      await h.handle(
        commentDelivery(`d-fix-${association}`, "@monad fix drop the unused import", association),
      );
      await h.worker.idle();

      // eyes before the work, rocket when it completes.
      expect(reactions(h)).toEqual(["eyes", "rocket"]);
      expect(h.daemon.modeSwitches).toEqual([{ sessionId: record.id, mode: "fix" }]);
      expect(h.daemon.prompts).toEqual([
        { sessionId: record.id, texts: [FIX_MODE_PROMPT, "drop the unused import"] },
      ]);
      expect(h.queue.get(`d-fix-${association}`)?.status).toBe("done");
    });
  }

  test("the reply says how to get the branch, because the bot never pushes", async () => {
    h = harness();
    const record = sessionRecord({
      cwd: "/tmp/monad/worktrees/session",
      pr: { repo: REPOSITORY.full_name, number: 7 } as never,
    });
    h.daemon.sessionList = [record];
    await h.handle(commentDelivery("d-fix-reply", "@monad fix rename it", "MEMBER"));
    await h.worker.idle();

    const reply = replies(h)[0] ?? "";
    expect(reply).toContain(record.id);
    expect(reply).toContain(record.cwd);
    expect(reply).toContain("did not push");
    expect(reply).toContain(`monad attach ${record.id}`);
  });

  test("with no open session it says so and runs nothing", async () => {
    h = harness();
    h.daemon.sessionList = [];
    await h.handle(commentDelivery("d-fix-none", "@monad fix something", "MEMBER"));
    await h.worker.idle();

    expect(h.daemon.modeSwitches).toHaveLength(0);
    expect(replies(h)[0]).toContain("@monad review");
    expect(reactions(h)).toEqual(["eyes"]);
  });
});

describe("@monad status", () => {
  test("replies with the session id, its mode, and its last event", async () => {
    h = harness();
    const record = sessionRecord({
      mode: "review",
      status: "idle",
      trust: "untrusted",
      pr: { repo: REPOSITORY.full_name, number: 7 } as never,
    });
    h.daemon.sessionList = [record];
    // A real event log in the daemon's own database, because that is where
    // the answer comes from.
    const store = new SessionStore({ dbPath: h.dbPath });
    store.create({
      id: record.id,
      cwd: record.cwd,
      backend: "claude-acp",
      mode: "review",
      status: "idle",
      trust: "untrusted",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    store.append(record.id, "review_report", { verdict: "comment" });
    store.close();

    await h.handle(commentDelivery("d-status", "@monad status", "CONTRIBUTOR"));
    await h.worker.idle();

    const reply = replies(h)[0] ?? "";
    expect(reply).toContain(record.id);
    expect(reply).toContain("mode: review");
    expect(reply).toContain("trust: untrusted");
    expect(reply).toContain("last event: review_report");
    expect(reactions(h)).toEqual(["eyes", "rocket"]);
  });
});

describe("anything else", () => {
  test("@monad nonsense reacts confused and does nothing", async () => {
    h = harness();
    await h.handle(commentDelivery("d-nonsense", "@monad nonsense", "OWNER"));
    await h.worker.idle();

    expect(reactions(h)).toEqual(["confused"]);
    expect(replies(h)).toHaveLength(0);
    expect(h.daemon.modeSwitches).toHaveLength(0);
    expect(h.daemon.reviews).toHaveLength(0);
  });

  test("@monad fix with no instruction is confused, not a fix", async () => {
    h = harness();
    await h.handle(commentDelivery("d-bare-fix", "@monad fix", "OWNER"));
    await h.worker.idle();
    expect(reactions(h)).toEqual(["confused"]);
    expect(h.daemon.prompts).toHaveLength(0);
  });
});

describe("@monad review", () => {
  test("re-runs the review at the pull request's current head", async () => {
    h = harness({
      responder: (route) =>
        route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
          ? { status: 200, data: pullRequest() }
          : undefined,
    });
    await h.handle(commentDelivery("d-review-cmd", "@monad review", "CONTRIBUTOR"));
    await h.worker.idle();

    // The comment carries no pull request, so the head and the trust level
    // both come from reading it back.
    expect(h.daemon.reviews).toHaveLength(1);
    const head = (pullRequest().head as { sha: string }).sha;
    expect(h.daemon.reviews[0]?.body.pr.headSha).toBe(head);
    expect(h.queue.get("d-review-cmd")?.kind).toBe("review");
  });
});
