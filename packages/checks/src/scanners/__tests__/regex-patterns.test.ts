import { describe, test, expect } from "bun:test";
import { SECRET_PATTERNS } from "../regex-patterns";

describe("Regex Patterns", () => {
  test("all patterns are defined and have required fields", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(15);
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.name).toBeTruthy();
      expect(pattern.pattern).toBeInstanceOf(RegExp);
      expect(["critical", "high", "medium", "low"]).toContain(pattern.severity);
    }
  });

  // AWS Access Key
  test("AWS Access Key matches AKIA + 16 alphanumeric", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "AWS Access Key ID")!;
    expect(p.pattern.test("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("AWS Access Key does NOT match AKIA + only 10 chars", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "AWS Access Key ID")!;
    expect(p.pattern.test("AKIA12345678")).toBe(false);
  });

  // GitHub PAT
  test("GitHub PAT matches ghp_ + 36+ chars", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "GitHub Personal Access Token")!;
    const token = `ghp_${"A".repeat(36)}`;
    expect(p.pattern.test(token)).toBe(true);
  });

  test("GitHub PAT does NOT match ghp_ + short string", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "GitHub Personal Access Token")!;
    expect(p.pattern.test("ghp_short")).toBe(false);
  });

  // OpenAI
  test("OpenAI API Key matches sk- + 20+ chars", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "OpenAI API Key")!;
    const key = `sk-${"A".repeat(48)}`;
    expect(p.pattern.test(key)).toBe(true);
  });

  test("OpenAI Project Key matches sk-proj- prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "OpenAI Project Key")!;
    const key = `sk-proj-${"A".repeat(40)}`;
    expect(p.pattern.test(key)).toBe(true);
  });

  // Anthropic
  test("Anthropic API Key matches sk-ant- prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Anthropic API Key")!;
    const key = `sk-ant-${"A".repeat(40)}`;
    expect(p.pattern.test(key)).toBe(true);
  });

  // Stripe
  test("Stripe Live Key matches sk_live_ prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Stripe Live Secret Key")!;
    const key = `sk_live_${"A".repeat(24)}`;
    expect(p.pattern.test(key)).toBe(true);
  });

  test("Stripe Test Key matches sk_test_ prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Stripe Test Secret Key")!;
    const key = `sk_test_${"A".repeat(24)}`;
    expect(p.pattern.test(key)).toBe(true);
  });

  // Private Key
  test("Private Key Header matches RSA private key", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Private Key Header")!;
    expect(p.pattern.test("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  test("Private Key Header matches EC private key", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Private Key Header")!;
    expect(p.pattern.test("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
  });

  // Connection Strings
  test("PostgreSQL connection string matches", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "PostgreSQL Connection String")!;
    expect(p.pattern.test("postgres://user:pass@host:5432/db")).toBe(true);
  });

  test("PostgreSQL connection string does NOT match partial", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "PostgreSQL Connection String")!;
    expect(p.pattern.test("postgres")).toBe(false);
  });

  test("MongoDB connection string matches", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "MongoDB Connection String")!;
    expect(p.pattern.test("mongodb+srv://cluster.example.invalid/db")).toBe(true);
  });

  // Generic patterns
  test("Generic Password matches password assignment", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Generic Password Assignment")!;
    expect(p.pattern.test('password = "my_super_secret_123!"')).toBe(true);
  });

  test("Generic Password does NOT match short password", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Generic Password Assignment")!;
    expect(p.pattern.test('password = "abc"')).toBe(false);
  });

  test("Generic Token matches token assignment", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Generic Token Assignment")!;
    expect(p.pattern.test('token = "abcdefghijklmnop"')).toBe(true);
  });

  test("Generic API Key matches apiKey assignment", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Generic API Key Assignment")!;
    expect(p.pattern.test('api_key = "abcdefghijklmnop"')).toBe(true);
  });

  // Supabase JWT
  test("Supabase JWT matches standard format", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "Supabase JWT")!;
    // Synthetic value: real header literal required by the regex, followed by
    // redacted placeholders so no token-shaped secret is embedded in source.
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.REDACTED_TEST_PAYLOAD.REDACTED_TEST_SIGNATURE";
    expect(p.pattern.test(jwt)).toBe(true);
  });

  // GitHub variants
  test("GitHub OAuth Token matches gho_ prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "GitHub OAuth Token")!;
    const token = `gho_${"A".repeat(36)}`;
    expect(p.pattern.test(token)).toBe(true);
  });

  test("GitHub Fine-grained PAT matches github_pat_ prefix", () => {
    const p = SECRET_PATTERNS.find(p => p.name === "GitHub Fine-grained PAT")!;
    const token = `github_pat_${"A".repeat(22)}`;
    expect(p.pattern.test(token)).toBe(true);
  });
});
