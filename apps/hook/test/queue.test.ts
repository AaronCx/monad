import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebhookIntent, type WebhookIntent } from "@aaroncx/github";
import { DeliveryQueue, prKeyOf } from "../src/queue.ts";
import {
  issueCommentEvent,
  pullRequestEvent,
} from "../../../packages/github/test/fixtures/payloads.ts";

const dirs: string[] = [];

function queue(): { queue: DeliveryQueue; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "monad-hook-queue-"));
  dirs.push(dir);
  const dbPath = join(dir, "monad.db");
  return { queue: new DeliveryQueue({ dbPath }), dbPath };
}

function reviewIntent(deliveryId: string, action = "opened"): WebhookIntent {
  return resolveWebhookIntent({
    event: "pull_request",
    deliveryId,
    payload: pullRequestEvent(action),
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DeliveryQueue", () => {
  test("the same delivery id twice inserts one row", () => {
    const { queue: q } = queue();
    const first = q.enqueue(reviewIntent("d-1"));
    const second = q.enqueue(reviewIntent("d-1"));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(q.list()).toHaveLength(1);
    q.close();
  });

  test("a row carries the log-safe delivery details and the narrowed intent", () => {
    const { queue: q } = queue();
    const { row } = q.enqueue(reviewIntent("d-2", "synchronize"));
    expect(row.event).toBe("pull_request");
    expect(row.action).toBe("synchronize");
    expect(row.kind).toBe("review");
    expect(row.repo).toBe("AaronCx/monad-review-demo");
    expect(row.number).toBe(7);
    expect(row.installationId).toBe(4242);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(prKeyOf(row)).toBe("AaronCx/monad-review-demo#7");
    expect(row.intent.kind).toBe("review");
    q.close();
  });

  test("a comment command is queued as a command, not a review", () => {
    const { queue: q } = queue();
    const intent = resolveWebhookIntent({
      event: "issue_comment",
      deliveryId: "d-3",
      payload: issueCommentEvent("@monad fix drop the unused import"),
    });
    const { row } = q.enqueue(intent);
    expect(row.kind).toBe("command");
    expect(row.headSha).toBeUndefined();
    q.close();
  });

  test("ready skips a row waiting out its backoff and returns it once due", () => {
    const { queue: q } = queue();
    q.enqueue(reviewIntent("d-4"));
    q.markRunning("d-4");
    expect(q.get("d-4")?.attempts).toBe(1);
    const later = new Date(Date.now() + 60_000);
    q.retryLater("d-4", "monadd is not answering", later);
    expect(q.ready(new Date())).toHaveLength(0);
    expect(q.ready(new Date(later.getTime() + 1))).toHaveLength(1);
    expect(q.get("d-4")?.error).toBe("monadd is not answering");
    q.close();
  });

  test("a running delivery returns to queued after a restart", () => {
    const { queue: q, dbPath } = queue();
    q.enqueue(reviewIntent("d-5"));
    q.markRunning("d-5");
    q.close();

    const restarted = new DeliveryQueue({ dbPath });
    const recovered = restarted.recoverRunning();
    expect(recovered.map((row) => row.deliveryId)).toEqual(["d-5"]);
    const row = restarted.get("d-5");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(row?.error).toContain("restarted");
    expect(restarted.ready()).toHaveLength(1);
    restarted.close();
  });

  test("terminal states record why", () => {
    const { queue: q } = queue();
    q.enqueue(reviewIntent("d-6"));
    q.finish("d-6", "superseded", "head 0123456 superseded by abcdef0");
    const row = q.get("d-6");
    expect(row?.status).toBe("superseded");
    expect(row?.error).toContain("superseded by");
    expect(row?.finishedAt).toBeDefined();
    expect(q.counts()).toEqual({ superseded: 1 });
    q.close();
  });
});
