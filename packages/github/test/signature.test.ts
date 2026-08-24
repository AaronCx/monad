import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "../src/signature.ts";

/**
 * Ported from LastGate's apps/web/lib/github/__tests__/webhooks.test.ts,
 * plus the truncated-signature case M3's brief asks for. The function is
 * byte-identical to the one those tests covered, so a behavior change shows
 * up here.
 */

const SECRET = "test-webhook-secret-123";

function sign(payload: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  test("a valid delivery is accepted", () => {
    const payload = '{"action":"opened","number":1}';
    expect(verifyWebhookSignature(payload, sign(payload), SECRET)).toBe(true);
  });

  test("a tampered body is rejected", () => {
    const original = '{"action":"opened","number":1}';
    const signature = sign(original);
    expect(verifyWebhookSignature('{"action":"opened","number":2}', signature, SECRET)).toBe(false);
  });

  test("a truncated signature is rejected on the length guard", () => {
    const payload = '{"action":"opened","number":1}';
    const full = sign(payload);
    expect(verifyWebhookSignature(payload, full.slice(0, full.length - 1), SECRET)).toBe(false);
  });

  test("a signature with trailing bytes is rejected", () => {
    const payload = '{"action":"opened","number":1}';
    expect(verifyWebhookSignature(payload, `${sign(payload)}0`, SECRET)).toBe(false);
  });

  test("a missing header (empty string) is rejected", () => {
    expect(verifyWebhookSignature('{"action":"opened"}', "", SECRET)).toBe(false);
  });

  test("the wrong secret is rejected", () => {
    const payload = '{"action":"opened"}';
    expect(verifyWebhookSignature(payload, sign(payload, "wrong-secret"), SECRET)).toBe(false);
  });

  test("a bare hex digest with no sha256= prefix is rejected", () => {
    const payload = '{"test":true}';
    const bare = createHmac("sha256", SECRET).update(payload, "utf8").digest("hex");
    expect(verifyWebhookSignature(payload, bare, SECRET)).toBe(false);
  });

  test("an empty body still verifies against its own signature", () => {
    expect(verifyWebhookSignature("", sign(""), SECRET)).toBe(true);
    expect(verifyWebhookSignature("", "sha256=wrong", SECRET)).toBe(false);
  });

  test("every header name is the lower-cased form Bun.serve exposes", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
    expect(DELIVERY_HEADER).toBe("x-github-delivery");
    expect(EVENT_HEADER).toBe("x-github-event");
  });
});
