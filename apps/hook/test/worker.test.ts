import { afterEach, describe, expect, test } from "bun:test";
import {
  checkRunEvent,
  HEAD_SHA,
  pullRequest,
  pullRequestEvent,
} from "../../../packages/github/test/fixtures/payloads.ts";
import { reviewResult } from "./fixtures/fake-daemon.ts";
import {
  checkResults,
  deliveryRequest,
  harness,
  type Harness,
  waitFor,
} from "./fixtures/harness.ts";

/**
 * The worker: the lifecycle a pull request sees, the trust it is reviewed
 * at, what a second push does to a review already running, and what a daemon
 * that is not there costs (nothing).
 */

let h: Harness;

afterEach(async () => {
  // A test may leave a review deliberately held open; answer it so the
  // worker can shut down rather than waiting on a promise nobody will keep.
  h.daemon.settleAll();
  await h.worker.stop();
  h.close();
});

function deliver(
  harnessUnderTest: Harness,
  deliveryId: string,
  payload: unknown,
  event = "pull_request",
): Promise<Response> {
  return harnessUnderTest.handle(deliveryRequest({ event, deliveryId, payload }));
}

const NEW_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

describe("the review lifecycle", () => {
  test("queued, then in_progress, then one completed check run", async () => {
    h = harness();
    await deliver(h, "d-1", pullRequestEvent("opened"));
    await h.worker.idle();

    const created = h.github.matching("POST /repos/{owner}/{repo}/check-runs");
    expect(created).toHaveLength(1);
    expect(created[0]?.params).toMatchObject({
      owner: "AaronCx",
      repo: "monad-review-demo",
      name: "monad",
      head_sha: HEAD_SHA,
      status: "queued",
    });

    const updates = h.github.matching("PATCH /repos/{owner}/{repo}/check-runs");
    expect(updates[0]?.params.status).toBe("in_progress");
    const completed = updates.at(-1);
    expect(completed?.params.status).toBe("completed");
    // The fixture's checks failed, so a happy verdict does not make it green.
    expect(completed?.params.conclusion).toBe("failure");
    const output = completed?.params.output as { summary: string; annotations: unknown[] };
    expect(output.annotations).toHaveLength(1);
    expect(h.queue.get("d-1")?.status).toBe("done");
  });

  test("one COMMENT review with the session id in its footer", async () => {
    h = harness();
    await deliver(h, "d-2", pullRequestEvent("opened"));
    await h.worker.idle();

    const posted = h.github.matching("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
    expect(posted).toHaveLength(1);
    const params = posted[0]?.params as { event: string; body: string; commit_id: string };
    expect(params.event).toBe("COMMENT");
    expect(params.commit_id).toBe(h.headSha);
    expect(params.body).toContain("monad attach");
    expect(params.body).toContain(h.daemon.reviews[0]?.sessionId ?? "no session");
  });

  test("an unparsable report is action_required and nothing is posted", async () => {
    h = harness();
    h.daemon.autoReview = (call) => {
      h.daemon.announce(call, checkResults({ hasFailures: false, failureCount: 0, checks: [] }));
      call.resolve(
        reviewResult({
          sessionId: call.sessionId,
          baseSha: h.baseSha,
          headSha: h.headSha,
          structured: false,
          report: { structured: false, raw: "the agent said something else" },
          checksFailed: false,
        }),
      );
    };
    await deliver(h, "d-3", pullRequestEvent("opened"));
    await h.worker.idle();

    const completed = h.github.matching("PATCH /repos/{owner}/{repo}/check-runs").at(-1);
    expect(completed?.params.conclusion).toBe("action_required");
    expect(h.github.matching("pulls/{pull_number}/reviews")).toHaveLength(0);
  });

  test("a repository with no local checkout is skipped, and monadd is never asked", async () => {
    h = harness();
    h.repoRoots.clear();
    await deliver(h, "d-4", pullRequestEvent("opened"));
    await h.worker.idle();

    expect(h.daemon.reviews).toHaveLength(0);
    expect(h.github.calls).toHaveLength(0);
    const row = h.queue.get("d-4");
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("no local checkout");
  });
});

describe("trust from the signed payload", () => {
  test("a MEMBER's branch on the repo itself is trusted", async () => {
    h = harness();
    await deliver(h, "d-trusted", pullRequestEvent("opened"));
    await h.worker.idle();
    expect(h.daemon.reviews[0]?.body.trust).toBe("trusted");
    const inProgress = h.github.matching("PATCH /repos/{owner}/{repo}/check-runs")[0];
    expect((inProgress?.params.output as { summary: string }).summary).toContain("trusted PR");
  });

  test("a fork PR is untrusted, and the check run says what that means", async () => {
    h = harness();
    await deliver(
      h,
      "d-fork",
      pullRequestEvent("opened", { author_association: "CONTRIBUTOR" }, "stranger/monad-review-demo"),
    );
    await h.worker.idle();
    expect(h.daemon.reviews[0]?.body.trust).toBe("untrusted");
    const summary = (
      h.github.matching("PATCH /repos/{owner}/{repo}/check-runs")[0]?.params.output as {
        summary: string;
      }
    ).summary;
    expect(summary).toContain("untrusted PR: install, build, and test do not run");
    expect(summary).toContain("a fork of");
  });

  test("a fork PR from an OWNER is still untrusted: the branch is what is trusted", async () => {
    h = harness();
    await deliver(
      h,
      "d-own-fork",
      pullRequestEvent("opened", { author_association: "OWNER" }, "AaronCx/fork-of-demo"),
    );
    await h.worker.idle();
    expect(h.daemon.reviews[0]?.body.trust).toBe("untrusted");
  });

  test("a check_run rerequest reads the pull request back and resolves trust from it", async () => {
    // The rerequest payload carries no pull request, so resolveTrustFromIntent
    // answers untrusted with a reason. The App's second step is what turns
    // that into a real answer, and it must be a fetch, never a fallback.
    h = harness({
      responder: (route) =>
        route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
          ? { status: 200, data: pullRequest() }
          : undefined,
    });
    await deliver(h, "d-rerun", checkRunEvent("rerequested"), "check_run");
    await h.worker.idle();

    const fetched = h.github.calls.filter(
      (call) => call.route === "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    );
    expect(fetched).toHaveLength(1);
    expect(h.daemon.reviews[0]?.body.trust).toBe("trusted");
    expect(h.queue.get("d-rerun")?.status).toBe("done");
  });

  test("a pull request the App cannot read stays unreviewed", async () => {
    h = harness({ responder: () => ({ status: 404, data: { message: "Not Found" } }) });
    await deliver(h, "d-gone", checkRunEvent("rerequested"), "check_run");
    await h.worker.idle();
    expect(h.daemon.reviews).toHaveLength(0);
    expect(h.queue.get("d-gone")?.status).toBe("failed");
  });
});

describe("supersede", () => {
  test("a push cancels the running review and reviews the new head", async () => {
    h = harness();
    h.daemon.autoReview = (call) => {
      // Hold the review open: the session exists, the answer does not.
      h.daemon.announce(call, checkResults());
    };
    await deliver(h, "d-first", pullRequestEvent("opened"));
    await waitFor(() => h.daemon.reviews.length === 1, "the first review to start");
    const first = h.daemon.reviews[0];

    // The second delivery answers straight away, so the assertions below are
    // about the first review being stopped rather than about timing.
    h.daemon.autoReview = (call) => {
      h.daemon.announce(call, checkResults());
      call.resolve(
        reviewResult({
          sessionId: call.sessionId,
          baseSha: h.baseSha,
          headSha: h.headSha,
        }),
      );
    };
    await deliver(
      h,
      "d-second",
      pullRequestEvent("synchronize", { head: { sha: NEW_HEAD, ref: "feature", repo: { full_name: "AaronCx/monad-review-demo" } } }),
    );
    await h.worker.idle();

    expect(h.daemon.cancels).toEqual([first?.sessionId ?? ""]);
    expect(first?.cancelled).toBe(true);
    const superseded = h.queue.get("d-first");
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.error).toContain("d-second");
    expect(h.queue.get("d-second")?.status).toBe("done");

    // Exactly one check run per head sha, and the superseded one is closed
    // rather than left hanging in_progress.
    const created = h.github.matching("POST /repos/{owner}/{repo}/check-runs");
    expect(created.map((call) => call.params.head_sha)).toEqual([HEAD_SHA, NEW_HEAD]);
    const completions = h.github
      .matching("PATCH /repos/{owner}/{repo}/check-runs")
      .filter((call) => call.params.status === "completed");
    expect(completions[0]?.params.conclusion).toBe("cancelled");
    expect((completions[0]?.params.output as { title: string }).title).toContain("superseded");
    expect(completions).toHaveLength(2);
    // And never two reviews at once for one pull request.
    expect(h.daemon.reviews).toHaveLength(2);
  });

  test("a command is not superseded by a push", async () => {
    h = harness();
    h.daemon.sessionsError = new Error("monadd is down");
    await h.handle(
      deliveryRequest({
        event: "issue_comment",
        deliveryId: "d-cmd",
        payload: {
          action: "created",
          issue: { number: 7, pull_request: {} },
          comment: { id: 1, body: "@monad status", author_association: "MEMBER", user: { login: "AaronCx" } },
          repository: {
            full_name: "AaronCx/monad-review-demo",
            name: "monad-review-demo",
            owner: { login: "AaronCx" },
          },
          installation: { id: 4242 },
        },
      }),
    );
    await h.worker.idle();
    // The command retried rather than being cancelled by anything.
    expect(h.daemon.cancels).toHaveLength(0);
  });
});

describe("a daemon that is not there", () => {
  test("leaves the delivery queued behind a backoff and touches no check run", async () => {
    h = harness({ backoffMs: () => 50 });
    h.daemon.ensureError = new Error("monadd did not come up");
    await deliver(h, "d-down", pullRequestEvent("opened"));
    await waitFor(() => h.queue.get("d-down")?.status === "queued", "the delivery to requeue");

    const row = h.queue.get("d-down");
    expect(row?.attempts).toBe(1);
    expect(row?.error).toContain("monadd is not available");
    expect(row?.nextAttemptAt).toBeDefined();
    expect(h.github.calls).toHaveLength(0);

    // And when monadd comes back, the same delivery completes.
    h.daemon.ensureError = undefined;
    h.worker.wake();
    await waitFor(() => h.queue.get("d-down")?.status === "done", "the retry to complete");
    expect(h.queue.get("d-down")?.attempts).toBe(2);
    expect(h.daemon.reviews).toHaveLength(1);
  });

  test("gives up after maxAttempts, with the reason on the row", async () => {
    h = harness({ backoffMs: () => 1, maxAttempts: 3 });
    h.daemon.ensureError = new Error("monadd did not come up");
    await deliver(h, "d-dead", pullRequestEvent("opened"));
    await waitFor(() => h.queue.get("d-dead")?.status === "failed", "the delivery to give up");
    const row = h.queue.get("d-dead");
    expect(row?.attempts).toBe(3);
    expect(row?.error).toContain("gave up after 3 attempts");
  });
});

describe("concurrency", () => {
  test("never more reviews at once than the cap", async () => {
    h = harness({ maxConcurrent: 1 });
    h.daemon.autoReview = (call) => {
      h.daemon.announce(call, checkResults());
    };
    for (const number of [11, 12, 13]) {
      await deliver(
        h,
        `d-pr-${number}`,
        pullRequestEvent("opened", { number }),
      );
    }
    await waitFor(() => h.daemon.reviews.length === 1, "the first review to start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.daemon.reviews).toHaveLength(1);

    // Finishing one lets exactly one more in.
    h.daemon.reviews[0]?.resolve(
      reviewResult({ sessionId: h.daemon.reviews[0]?.sessionId, baseSha: h.baseSha, headSha: h.headSha }),
    );
    await waitFor(() => h.daemon.reviews.length === 2, "the second review to start");
    expect(h.daemon.reviews).toHaveLength(2);
  });
});
