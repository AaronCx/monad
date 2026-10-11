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

/**
 * Replaces every secret-shaped span in `text` with `[REDACTED:<id>]`.
 *
 * Regex patterns run first, then a conservative entropy pass for keys no
 * pattern names (`[REDACTED:high-entropy]`). Prose, paths, uuids, git shas
 * and ordinary identifiers come back unchanged.
 */
export function redactSecrets(text: string): RedactionResult {
  let out = text;
  let redactions = 0;
  for (const { id, pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(out)) {
      continue;
    }
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      redactions += 1;
      return `[REDACTED:${id}]`;
    });
  }
  ENTROPY_CANDIDATE.lastIndex = 0;
  out = out.replace(ENTROPY_CANDIDATE, (token) => {
    if (!looksRandom(token)) {
      return token;
    }
    redactions += 1;
    return "[REDACTED:high-entropy]";
  });
  return { text: out, redactions };
}
