import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification, ported from LastGate's
 * apps/web/lib/github/webhooks.ts unchanged.
 *
 * This is the only thing standing between the internet and a review run, so
 * the two properties it claims are worth stating rather than assuming:
 *
 * - Constant time. The comparison is crypto.timingSafeEqual, which reads
 *   every byte of both buffers whatever it finds. A byte-by-byte === would
 *   return on the first mismatch and leak the expected digest one character
 *   at a time to an attacker who can time deliveries.
 * - Length guarded. timingSafeEqual THROWS a RangeError on buffers of
 *   different lengths rather than returning false, so the explicit length
 *   check in front of it is load-bearing, not decorative. It leaks the
 *   length of the header monad expected, which is a constant (71 bytes for
 *   "sha256=" plus a hex SHA-256) and not a secret.
 *
 * The header is compared with its "sha256=" prefix attached, so a bare hex
 * digest with no prefix is rejected on the length guard. The try/catch is
 * the last resort: any throw (a non-string secret, an allocation failure)
 * reads as "not verified" rather than propagating.
 */

/** The header GitHub signs the raw body with. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/** The header carrying the delivery guid, which is the idempotency key. */
export const DELIVERY_HEADER = "x-github-delivery";

/** The header carrying the event name. */
export const EVENT_HEADER = "x-github-event";

/**
 * Verify a GitHub webhook signature (HMAC SHA-256 over the RAW body).
 *
 * The payload must be the exact bytes GitHub sent. Re-serializing a parsed
 * object changes key order and whitespace and fails here, correctly, which
 * is why the receiver verifies before it parses.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const expectedSignature = `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;

    const sigBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
