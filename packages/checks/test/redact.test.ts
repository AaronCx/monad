import { describe, expect, test } from "bun:test";
import { findSecretSpans, redactSecrets, redactSecretsInWindow } from "../src/index";

/**
 * redactSecrets feeds the session search index and every monad Link result
 * (decision record 0012). Two failure modes matter equally: a token surviving
 * (the index or another session ends up holding it) and prose being mangled
 * (search stops finding what people actually wrote).
 */

// Built at runtime from short pieces so this file never carries a literal that
// the repo's own secrets check (pattern or entropy), or GitHub push
// protection, would flag on the diff.
const j = (...parts: string[]) => parts.join("");
const GITHUB_TOKEN = j("ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5");
const AWS_KEY_ID = j("AKIA", "IOSFODNN7", "EXAMPLE");
const ANTHROPIC_KEY = j("sk-ant-", "api03-Xy7Qw2", "Er9Ty4Ui8Op3", "As6Df1Gh5Jk0Lz");
const OPENAI_KEY = j("sk-", "Qw2Er9Ty4Ui8", "Op3As6Df1Gh5", "Jk0LzXc7Vb");
const RANDOM_KEY = j("8f3Kq9ZpL2mX", "7vR4tY1wB6nC", "0eH5jDs2");
const PRIVATE_KEY = [
  j("-----BEGIN ", "RSA PRIVATE", " KEY-----"),
  j("MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIB", "AQC7VJTUt9Us8cKj"),
  j("MzEfYyjiWA4R4/M2", "bS1GB4t7NXp98C3S", "C6dVMvDuictGeurT", "8jNbvJZHtCSuYEvu"),
  j("-----END ", "RSA PRIVATE", " KEY-----"),
].join("\n");

describe("redactSecrets", () => {
  test("a GitHub token is replaced with its pattern id", () => {
    const { text, redactions } = redactSecrets(`export GH_TOKEN ${GITHUB_TOKEN} then push`);
    expect(text).toBe("export GH_TOKEN [REDACTED:github-personal-access-token] then push");
    expect(text).not.toContain("ghp_");
    expect(redactions).toBe(1);
  });

  test("an AWS access key id is replaced", () => {
    const { text } = redactSecrets(`key=${AWS_KEY_ID}`);
    expect(text).not.toContain(AWS_KEY_ID);
    expect(text).toContain("[REDACTED:aws-access-key-id]");
  });

  test("Anthropic and OpenAI style keys are replaced", () => {
    const { text, redactions } = redactSecrets(`first ${ANTHROPIC_KEY} second ${OPENAI_KEY}.`);
    expect(text).toBe("first [REDACTED:anthropic-api-key] second [REDACTED:openai-api-key].");
    expect(redactions).toBe(2);
  });

  test("a private key block is removed whole, body included", () => {
    const { text } = redactSecrets(`before\n${PRIVATE_KEY}\nafter`);
    expect(text).toBe("before\n[REDACTED:private-key]\nafter");
  });

  test("a private key block cut off before its END line is redacted to the end", () => {
    const truncated = PRIVATE_KEY.split("\n").slice(0, 2).join("\n");
    const { text } = redactSecrets(`here it is:\n${truncated}`);
    expect(text).toBe("here it is:\n[REDACTED:private-key]");
  });

  test("every occurrence is replaced, not just the first", () => {
    const { text, redactions } = redactSecrets(`${GITHUB_TOKEN} and again ${GITHUB_TOKEN}`);
    expect(text).not.toContain("ghp_");
    expect(redactions).toBe(2);
  });

  test("an unnamed high-entropy key falls to the entropy pass", () => {
    const { text } = redactSecrets(`the value is ${RANDOM_KEY} ok`);
    expect(text).toBe("the value is [REDACTED:high-entropy] ok");
  });

  test("redacting twice is the same as redacting once", () => {
    const once = redactSecrets(`${GITHUB_TOKEN} ${PRIVATE_KEY} ${ANTHROPIC_KEY}`).text;
    const twice = redactSecrets(once);
    expect(twice.text).toBe(once);
    expect(twice.redactions).toBe(0);
  });

  test("prose, paths, uuids, shas and identifiers come back unchanged", () => {
    const prose = [
      "The meshyy scrolling bug had four reports. Build 72 clamps the status row,",
      "and two divergences were deferred. See /private/tmp/claude-501/-Users-acx/",
      "a9f9ea07-2748-4af6-a37d-8eb019af6689/scratchpad/link-design.md and commit",
      "2fc172f0b1c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5 in packages/engine/src/store.ts.",
      "createChecksMcpServerWithBinding1 and Uint8ArrayFromBase64StringDecoder2 are",
      "identifiers; MONAD_HANDOFF_IDLE_MS is a constant; the token budget is fine.",
      "A password policy and an api key rotation are words, not secrets.",
    ].join("\n");
    const result = redactSecrets(prose);
    expect(result.text).toBe(prose);
    expect(result.redactions).toBe(0);
  });

  test("runs in linear time on a pathological input", () => {
    // Long runs that almost match: no pattern may backtrack polynomially.
    const nearMiss = `${"a".repeat(200_000)} ${"-----BEGIN PRIVATE KEY-----".repeat(1)} ${"token = '".repeat(20_000)}`;
    const started = performance.now();
    redactSecrets(nearMiss);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("redactSecretsInWindow", () => {
  test("a window that cuts a token in two redacts each half to the placeholder", () => {
    const text = `push with ${GITHUB_TOKEN} now`;
    const cut = text.indexOf(GITHUB_TOKEN) + 18;
    const head = redactSecretsInWindow(text, 0, cut).text;
    const tail = redactSecretsInWindow(text, cut).text;
    expect(head).toBe("push with [REDACTED:github-personal-access-token]");
    expect(tail).toBe("[REDACTED:github-personal-access-token] now");
    // Redacted alone, each half would have survived.
    expect(redactSecrets(text.slice(0, cut)).text).toContain(GITHUB_TOKEN.slice(4, 18));
  });

  test("a key body whose BEGIN header is outside the window is still redacted", () => {
    const text = `prose\n${PRIVATE_KEY}\nafter`;
    const body = text.indexOf("MzEf");
    expect(redactSecretsInWindow(text, body).text).toBe("[REDACTED:private-key]\nafter");
  });

  test("an assignment whose name is outside the window is still redacted", () => {
    const value = j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY");
    const text = `aws_secret_access_key = ${value} end`;
    const window = redactSecretsInWindow(text, text.indexOf(value)).text;
    expect(window).toBe("[REDACTED:aws-secret-access-key] end");
  });

  test("the whole text as the window is exactly redactSecrets", () => {
    const text = `a ${GITHUB_TOKEN} b ${PRIVATE_KEY} c ${RANDOM_KEY} d`;
    expect(redactSecretsInWindow(text, 0)).toEqual(redactSecrets(text));
    expect(redactSecretsInWindow(text, 2, 2).text).toBe("");
  });

  test("spans are sorted, non-overlapping and name the pattern that found them", () => {
    const text = `x ${GITHUB_TOKEN} y ${RANDOM_KEY}`;
    const spans = findSecretSpans(text);
    expect(spans.map((span) => span.id)).toEqual(["github-personal-access-token", "high-entropy"]);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(GITHUB_TOKEN);
    expect(spans[0]!.end).toBeLessThan(spans[1]!.start);
  });
});
