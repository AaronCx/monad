import {
  DELIVERY_HEADER,
  describeDelivery,
  EVENT_HEADER,
  resolveWebhookIntent,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "@aaroncx/github";
import type { Logger } from "./log.ts";
import type { DeliveryQueue } from "./queue.ts";

/**
 * The receiver: two routes, and an order that matters.
 *
 * The signature is verified against the RAW body before anything is parsed.
 * Re-serializing a parsed object changes key order and whitespace and would
 * fail verification, so this is not a preference; it is the only way the
 * check works. A delivery that fails it is 401 and the log line carries the
 * delivery id and nothing else: not the body, not the header, not a hint of
 * what was expected.
 *
 * A verified delivery is written to the queue and answered 202 immediately.
 * GitHub's delivery timeout is measured in seconds and a review takes a
 * minute or more, so the work cannot happen inside the request. Because the
 * row is committed before the answer, a crash right after the 202 loses
 * nothing.
 *
 * Anything monad does not subscribe to is answered 200 and dropped. A
 * receiver that errors on events it did not ask for gets its deliveries
 * disabled by GitHub, which is a worse failure than doing nothing.
 */

export interface HookServerDeps {
  webhookSecret: string;
  queue: DeliveryQueue;
  /** Told when a delivery worth working on lands. */
  worker: { wake(): void };
  log: Logger;
  version: string;
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The Bun.serve fetch handler, separated so tests can drive it over a socket. */
export function createHookHandler(deps: HookServerDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Nothing here is a secret: counts by status and the version.
      return json(200, {
        ok: true,
        version: deps.version,
        deliveries: deps.queue.counts(),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return json(404, { error: "not found" });
    }

    const deliveryId = request.headers.get(DELIVERY_HEADER) ?? "";
    const raw = await request.text();
    if (!verifyWebhookSignature(raw, request.headers.get(SIGNATURE_HEADER) ?? "", deps.webhookSecret)) {
      deps.log.warn(`delivery=${deliveryId || "(none)"} rejected: signature did not verify`);
      return json(401, { error: "signature did not verify" });
    }
    if (deliveryId.length === 0) {
      // Verified but unidentifiable: the delivery id is the idempotency key,
      // and without it a redelivery would run a second review.
      deps.log.warn(`a verified delivery carried no ${DELIVERY_HEADER}; refused`);
      return json(400, { error: `missing ${DELIVERY_HEADER}` });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      deps.log.warn(`delivery=${deliveryId} rejected: the body is not JSON`);
      return json(400, { error: "the body is not JSON" });
    }

    const intent = resolveWebhookIntent({
      event: request.headers.get(EVENT_HEADER) ?? "",
      deliveryId,
      payload,
    });
    if (intent.kind === "ignored") {
      deps.log.info(`${describeDelivery(intent.delivery)} ignored: ${intent.reason}`);
      return json(200, { ignored: intent.reason });
    }

    // An installation event is recorded and worked on by nobody: monad opens
    // no review when it is installed.
    const recordOnly = intent.kind === "record";
    const { inserted, row } = deps.queue.enqueue(intent, {
      status: recordOnly ? "skipped" : "queued",
      error: recordOnly ? "installation event recorded; monad reviews nothing on it" : undefined,
    });
    deps.log.info(
      `${describeDelivery(intent.delivery)} ${inserted ? "queued" : "already seen"}` +
        `${recordOnly ? " (recorded only)" : ""}`,
    );
    if (inserted && !recordOnly) {
      deps.worker.wake();
    }
    return json(202, {
      accepted: true,
      delivery: row.deliveryId,
      // A redelivery is a no-op, and saying so makes that visible from the
      // GitHub delivery page rather than only in the log.
      duplicate: !inserted,
      kind: row.kind,
    });
  };
}
