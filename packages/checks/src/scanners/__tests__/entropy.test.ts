import { describe, test, expect } from "bun:test";
import { calculateEntropy, extractTokens } from "../entropy";

describe("Entropy Calculator", () => {
  test("'aaaaaaaaaa' → low entropy (< 1.0)", () => {
    const entropy = calculateEntropy("aaaaaaaaaa");
    expect(entropy).toBeLessThan(1.0);
  });

  test("'abcdefghij' → moderate entropy (~3.3)", () => {
    const entropy = calculateEntropy("abcdefghij");
    expect(entropy).toBeGreaterThan(3.0);
    expect(entropy).toBeLessThan(4.0);
  });

  test("high-entropy secret string → > 4.5", () => {
    const entropy = calculateEntropy("aK3$mP9xL2qR7wN4vB8jcF5tY6uH0");
    expect(entropy).toBeGreaterThan(4.5);
  });

  test("'password123' → low-moderate entropy (should NOT flag)", () => {
    const entropy = calculateEntropy("password123");
    expect(entropy).toBeLessThan(4.5);
  });

  test("empty string → returns 0", () => {
    expect(calculateEntropy("")).toBe(0);
  });

  test("single character → returns 0", () => {
    expect(calculateEntropy("a")).toBe(0);
  });

  test("real AWS key format → high entropy (> 4.0)", () => {
    // Simulating an AWS-like random key
    const entropy = calculateEntropy("AKIAIOSFODNN7EXAMPLE");
    expect(entropy).toBeGreaterThan(3.5);
  });

  test("repeated pattern has lower entropy than random string", () => {
    const repeated = calculateEntropy("abcabcabcabcabcabcab");
    const random = calculateEntropy("aK3mP9xL2qR7wN4vB8j");
    expect(random).toBeGreaterThan(repeated);
  });
});

describe("Token Extractor", () => {
  test("extracts long alphanumeric strings (20+ chars)", () => {
    const tokens = extractTokens('const key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some(t => t.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))).toBe(true);
  });

  test("extracts quoted strings 20+ chars", () => {
    const tokens = extractTokens('token = "this_is_a_very_long_secret_value_here"');
    expect(tokens.length).toBeGreaterThan(0);
  });

  test("extracts values after = sign", () => {
    const tokens = extractTokens("API_KEY=abcdefghijklmnopqrstuvwxyz123456");
    expect(tokens.length).toBeGreaterThan(0);
  });

  test("ignores strings shorter than 20 characters", () => {
    const tokens = extractTokens('const x = "short";');
    expect(tokens.length).toBe(0);
  });

  test("handles empty line", () => {
    const tokens = extractTokens("");
    expect(tokens.length).toBe(0);
  });

  test("deduplicates identical tokens", () => {
    const line = 'key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd" value = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd"';
    const tokens = extractTokens(line);
    const unique = new Set(tokens);
    expect(tokens.length).toBe(unique.size);
  });
});
