/**
 * Calculate Shannon entropy of a string.
 * Higher entropy indicates more randomness, which is characteristic of secrets.
 */
export function calculateEntropy(str: string): number {
  if (str.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Extract potential secret tokens from a line of text.
 * Looks for:
 * - Alphanumeric strings 20+ characters long
 * - Quoted strings that could be secrets
 * - Values after = or : signs
 */
export function extractTokens(line: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  const addToken = (t: string) => {
    const trimmed = t.trim();
    if (trimmed.length >= 20 && !seen.has(trimmed)) {
      seen.add(trimmed);
      tokens.push(trimmed);
    }
  };

  // Match long alphanumeric strings (with common secret chars like +, /, =, -, _)
  const longAlphanumeric = /[A-Za-z0-9+/=_-]{20,}/g;
  let match: RegExpExecArray | null = longAlphanumeric.exec(line);
  while (match !== null) {
    addToken(match[0]);
    match = longAlphanumeric.exec(line);
  }

  // Match quoted strings
  const quotedStrings = /["']([^"']{20,})["']/g;
  match = quotedStrings.exec(line);
  while (match !== null) {
    addToken(match[1]);
    match = quotedStrings.exec(line);
  }

  // Match values after = or : (common in config files)
  const assignments = /[=:]\s*["']?([^\s"',;}{)]{20,})["']?/g;
  match = assignments.exec(line);
  while (match !== null) {
    addToken(match[1]);
    match = assignments.exec(line);
  }

  return tokens;
}
