import { afterEach, describe, expect, test } from "bun:test";
import { DELIVERY_HEADER, SIGNATURE_HEADER } from "@aaroncx/github";
import {
  checkRunEvent,
  issueCommentEvent,
  pullRequestEvent,
} from "../../../packages/github/test/fixtures/payloads.ts";
import {
  deliveryRequest,
  harness,
  type Harness,
  signature,
  waitFor,
} from "./fixtures/harness.ts";

/**
 * The receiver. What is asserted here is the order of operations: the
 * signature is checked against the raw body before anything is parsed, the
 * delivery is durable before the answer, and the answer comes back without
 * waiting for the review.
 */

let h: Harness;

afterEach(async () => {
  h.daemon.settleAll();
  await h.worker.stop();
  h.close();
});

describe("POST /webhook signature", () => {
  test("a valid delivery is accepted, queued, and answered 202", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-ok",
        payload: pullRequestEvent("opened"),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, kind: "review" });
    expect(h.queue.get("d-ok")?.status).not.toBeUndefined();
  });

  test("a tampered body is 401 and nothing is queued", async () => {
    h = harness();
    const payload = pullRequestEvent("opened");
    const honest = JSON.stringify(payload);
    const request = new Request("http://127.0.0.1/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        [DELIVERY_HEADER]: "d-tampered",
        [SIGNATURE_HEADER]: signature(honest),
      },
      // The same fields, re-serialized with one changed: exactly the attack
      // the raw-body rule exists for.
      body: JSON.stringify({ ...payload, action: "closed" }),
    });
    const response = await h.handle(request);
    expect(response.status).toBe(401);
    expect(h.queue.list()).toHaveLength(0);
  });

  test("a truncated signature is 401", async () => {
    h = harness();
    const body = JSON.stringify(pullRequestEvent("opened"));
    const response = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-short",
        payload: pullRequestEvent("opened"),
        signatureHeader: signature(body).slice(0, 40),
      }),
    );
    expect(response.status).toBe(401);
    expect(h.queue.list()).toHaveLength(0);
  });

  test("a missing signature header is 401", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-none",
        payload: pullRequestEvent("opened"),
        signatureHeader: null,
      }),
    );
    expect(response.status).toBe(401);
  });

  test("another secret is 401", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-wrong-secret",
        payload: pullRequestEvent("opened"),
        secret: "not the secret",
      }),
    );
    expect(response.status).toBe(401);
  });

  test("a rejected delivery logs the delivery id and nothing else", async () => {
    h = harness();
    await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-quiet",
        payload: pullRequestEvent("opened", { title: "a title nobody should see in a log" }),
        signatureHeader: "sha256=deadbeef",
      }),
    );
    const line = h.log.lines.find((entry) => entry.includes("d-quiet")) ?? "";
    expect(line).toContain("signature did not verify");
    expect(line).not.toContain("a title nobody should see in a log");
    expect(h.log.lines.join("\n")).not.toContain("pull_request\":");
  });

  test("a verified delivery with no delivery id is refused", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({ event: "pull_request", deliveryId: "", payload: pullRequestEvent("opened") }),
    );
    expect(response.status).toBe(400);
    expect(h.queue.list()).toHaveLength(0);
  });
});

describe("POST /webhook narrowing", () => {
  test("a pull_request monad does not act on is 200 and queues nothing", async () => {
    h = harness();
    for (const action of ["labeled", "closed", "assigned"]) {
      const response = await h.handle(
        deliveryRequest({
          event: "pull_request",
          deliveryId: `d-${action}`,
          payload: pullRequestEvent(action),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ignored: expect.any(String) });
    }
    expect(h.queue.list()).toHaveLength(0);
  });

  test("a draft pull request waits for ready_for_review", async () => {
    h = harness();
    const draft = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-draft",
        payload: pullRequestEvent("opened", { draft: true }),
      }),
    );
    expect(draft.status).toBe(200);
    const ready = await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-ready",
        payload: pullRequestEvent("ready_for_review", { draft: true }),
      }),
    );
    expect(ready.status).toBe(202);
    expect(h.queue.list().map((row) => row.deliveryId)).toEqual(["d-ready"]);
  });

  test("an event monad does not subscribe to is 200", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({ event: "push", deliveryId: "d-push", payload: { ref: "refs/heads/main" } }),
    );
    expect(response.status).toBe(200);
    expect(h.queue.list()).toHaveLength(0);
  });

  test("a check_run rerequest is queued as a review", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "check_run",
        deliveryId: "d-rerun",
        payload: checkRunEvent("rerequested"),
      }),
    );
    expect(response.status).toBe(202);
    expect(h.queue.get("d-rerun")?.kind).toBe("review");
  });

  test("an installation delivery is recorded and worked on by nobody", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "installation",
        deliveryId: "d-install",
        payload: {
          action: "created",
          installation: { id: 4242 },
          repositories: [{ full_name: "AaronCx/monad" }],
        },
      }),
    );
    expect(response.status).toBe(202);
    const row = h.queue.get("d-install");
    expect(row?.kind).toBe("record");
    expect(row?.status).toBe("skipped");
    expect(h.daemon.reviews).toHaveLength(0);
  });

  test("a comment that does not address monad is 200", async () => {
    h = harness();
    const response = await h.handle(
      deliveryRequest({
        event: "issue_comment",
        deliveryId: "d-chat",
        payload: issueCommentEvent("looks good to me"),
      }),
    );
    expect(response.status).toBe(200);
    expect(h.queue.list()).toHaveLength(0);
  });
});

describe("idempotency", () => {
  test("the same delivery id twice runs one review", async () => {
    h = harness();
    const payload = pullRequestEvent("opened");
    const first = await h.handle(
      deliveryRequest({ event: "pull_request", deliveryId: "d-same", payload }),
    );
    const second = await h.handle(
      deliveryRequest({ event: "pull_request", deliveryId: "d-same", payload }),
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ duplicate: true });
    await h.worker.idle();
    expect(h.queue.list()).toHaveLength(1);
    expect(h.daemon.reviews).toHaveLength(1);
    expect(h.queue.get("d-same")?.status).toBe("done");
    expect(h.queue.get("d-same")?.attempts).toBe(1);
    // And exactly one check run: created once, updated, completed.
    expect(h.github.matching("POST /repos/{owner}/{repo}/check-runs")).toHaveLength(1);
  });
});

describe("GET /healthz", () => {
  test("answers with counts and carries no secret", async () => {
    h = harness();
    await h.handle(
      deliveryRequest({
        event: "pull_request",
        deliveryId: "d-health",
        payload: pullRequestEvent("opened"),
      }),
    );
    const response = await h.handle(
      new Request("http://127.0.0.1/healthz", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: true, version: "test" });
    expect(body).not.toContain("a shared webhook secret");
  });

  test("an unknown route is 404", async () => {
    h = harness();
    const response = await h.handle(new Request("http://127.0.0.1/", { method: "GET" }));
    expect(response.status).toBe(404);
  });
});
