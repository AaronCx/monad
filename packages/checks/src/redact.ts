import { calculateEntropy } from "./scanners/entropy";
import { SECRET_PATTERNS } from "./scanners/regex-patterns";

/**
 * Secret redaction for text monad hands to something other than the check
 * that found it: the session search index and every result monad Link returns
 * to another session (decision record 0012). The secrets CHECK reports where a
 * secret is; this removes it, so a session reading another session's history,
 * or the full-text index on disk, never holds the token itself.
 *
 * Built on the same SECRET_PATTERNS the secrets check uses, so a pattern added
 * there is redacted here too. Each match becomes `[REDACTED:<pattern id>]`,
 * where the id is a slug of the pattern name. No id contains `=`, `:` or a URL
 * scheme, so a placeholder never matches a pattern itself and redacting twice
 * is the same as redacting once.
 *
 * Every pattern is linear-time: literal prefixes plus single character-class
 * runs, no nested quantifiers (CodeQL flagged polynomial regexes in this repo
 * before). The one multi-line pattern, a whole private key block, is anchored
 * on its literal BEGIN header and stops at the first END line.
 *
 * Every pattern runs over the ORIGINAL text and the matches merge into spans
 * (findSecretSpans), so a caller can redact one window of a longer text with
 * the text around it as context (redactSecretsInWindow).
 */

export interface RedactionResult {
  text: string;
  /** How many spans were replaced. Zero means `text` is the input verbatim. */
  redactions: number;
}

interface RedactionPattern {
  id: string;
  /** Global flag always set, so replace() covers every occurrence. */
  pattern: RegExp;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function globalCopy(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/**
 * The secrets check only needs the BEGIN line to flag a key; redaction has to
 * remove the body too. A block with no END line (cut off mid-stream) is
 * redacted to the end of the text, because the body is the secret.
 */
const PRIVATE_KEY_BLOCK: RedactionPattern = {
  id: "private-key",
  pattern:
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g,
};

const REDACTION_PATTERNS: RedactionPattern[] = [
  PRIVATE_KEY_BLOCK,
  ...SECRET_PATTERNS.map((p) => ({ id: slug(p.name), pattern: globalCopy(p.pattern) })),
];

/**
 * Candidate runs for the entropy pass. `/`, `.`, `_` and `-` are deliberately
 * NOT in the class: they are what paths, uuids, dotted names and snake or
 * kebab identifiers are made of, and a long path scores as "random" as a key
 * does (a scratchpad path measures 4.69 bits/char, a real base64 key 4.69 too).
 * Splitting on them keeps paths and ids out of the candidate set entirely.
 */
const ENTROPY_CANDIDATE = /[A-Za-z0-9+=]{24,}/g;

/**
 * Bits per character a candidate needs before it is treated as a secret. A
 * 40-char git sha (hex, at most 4.0) and camelCase identifiers with a digit
 * (4.1 to 4.3) stay under it; random base62/base64 keys of 24+ characters
 * score 4.5 and up. The shorter tier starts lower because a short string has
 * a lower entropy ceiling (log2 of its length).
 */
function entropyFloor(length: number): number {
  return length >= 32 ? 4.5 : 4.25;
}

function looksRandom(token: string): boolean {
  // Mixed case plus a digit: true of generated keys, false of prose words,
  // ALL_CAPS constants and hex digests.
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) {
    return false;
  }
  return calculateEntropy(token) >= entropyFloor(token.length);
}

/** One secret-shaped span of a text, in the text's own coordinates. */
export interface SecretSpan {
  start: number;
  end: number;
  /** The pattern id that names it (`high-entropy` for the entropy pass). */
  id: string;
}

/**
 * Every secret-shaped span of `text`, sorted and non-overlapping. Each
 * pattern runs over the original text; spans that overlap or touch merge into
 * one, named by the span that starts first (on a tie, the earlier pattern,
 * so a named pattern beats the entropy pass).
 */
export function findSecretSpans(text: string): SecretSpan[] {
  const found: Array<SecretSpan & { order: number }> = [];
  REDACTION_PATTERNS.forEach(({ id, pattern }, order) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      found.push({ start: match.index, end: match.index + match[0].length, id, order });
    }
  });
  const entropyOrder = REDACTION_PATTERNS.length;
  ENTROPY_CANDIDATE.lastIndex = 0;
  for (let match = ENTROPY_CANDIDATE.exec(text); match !== null; match = ENTROPY_CANDIDATE.exec(text)) {
    if (looksRandom(match[0])) {
      found.push({ start: match.index, end: match.index + match[0].length, id: "high-entropy", order: entropyOrder });
    }
  }
  found.sort((a, b) => a.start - b.start || a.order - b.order);
  const spans: SecretSpan[] = [];
  for (const span of found) {
    const last = spans[spans.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    spans.push({ start: span.start, end: span.end, id: span.id });
  }
  return spans;
}

/**
 * Replaces every secret-shaped span in `text` with `[REDACTED:<id>]`.
 *
 * Regex patterns name what they find, and a conservative entropy pass
 * catches keys no pattern names (`[REDACTED:high-entropy]`). Prose, paths,
 * uuids, git shas and ordinary identifiers come back unchanged.
 */
export function redactSecrets(text: string): RedactionResult {
  return redactSecretsInWindow(text, 0, text.length);
}

/**
 * Redacts the window `text[start, end)` with the REST of `text` as context:
 * patterns run over the whole text, and only the window is returned. A span
 * that crosses an edge of the window becomes its placeholder at that edge,
 * so a secret cut by the window is redacted whole, never half.
 *
 * This is what lets a caller split a long text into pieces (the session
 * index splits a long agent turn into rows) without a piece holding half a
 * token: redacted alone, neither half of a split token matches a pattern.
 */
export function redactSecretsInWindow(text: string, start: number, end: number = text.length): RedactionResult {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  let out = "";
  let cursor = from;
  let redactions = 0;
  for (const span of findSecretSpans(text)) {
    if (span.end <= from || span.start >= to) {
      continue;
    }
    out += text.slice(cursor, Math.max(cursor, span.start));
    out += `[REDACTED:${span.id}]`;
    redactions += 1;
    cursor = Math.min(span.end, to);
  }
  out += text.slice(cursor, to);
  return { text: out, redactions };
}
