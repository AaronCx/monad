import { describe, test, expect } from "bun:test";
import { validateConfig } from "../schema";

describe("Zod Schema Validation", () => {
  test("valid complete config passes validation", () => {
    const data = {
      checks: {
        secrets: { enabled: true, severity: "fail" },
        duplicates: { enabled: true, severity: "warn", lookback: 10 },
        lint: { enabled: true, severity: "fail" },
        build: { enabled: true, severity: "fail", timeout: 120 },
        dependencies: { enabled: true, severity: "warn", fail_on: "critical" },
        file_patterns: { enabled: true, severity: "fail" },
        commit_message: { enabled: true, severity: "warn", require_conventional: true },
        agent_patterns: { enabled: true, severity: "warn" },
      },
      protected_branches: ["main", "production"],
      agent_feedback: { format: "structured" },
    };
    const result = validateConfig(data);
    expect(result.checks?.secrets?.enabled).toBe(true);
    expect(result.protected_branches).toContain("main");
  });

  test("missing optional fields pass with defaults", () => {
    const data = {
      checks: {
        secrets: { enabled: true },
      },
    };
    const result = validateConfig(data);
    expect(result.checks?.secrets?.enabled).toBe(true);
  });

  test("invalid types fail (enabled: 'yes' instead of true)", () => {
    const data = {
      checks: {
        secrets: { enabled: "yes" },
      },
    };
    expect(() => validateConfig(data)).toThrow();
  });

  test("extra unknown fields are stripped (no crash)", () => {
    const data = {
      checks: {
        secrets: { enabled: true, severity: "fail" },
      },
      unknown_field: "should be ignored",
    };
    // Zod in strict mode might strip; let's verify it doesn't crash
    const result = validateConfig(data);
    expect(result.checks?.secrets?.enabled).toBe(true);
  });

  test("timeout must be a positive integer", () => {
    const data = {
      checks: {
        build: { enabled: true, timeout: -5 },
      },
    };
    expect(() => validateConfig(data)).toThrow();
  });

  test("protected_branches must be an array of strings", () => {
    const data = {
      protected_branches: ["main", "develop"],
    };
    const result = validateConfig(data);
    expect(result.protected_branches).toEqual(["main", "develop"]);
  });

  test("invalid severity value fails", () => {
    const data = {
      checks: {
        secrets: { enabled: true, severity: "critical" },
      },
    };
    expect(() => validateConfig(data)).toThrow();
  });

  test("invalid fail_on value fails", () => {
    const data = {
      checks: {
        dependencies: { enabled: true, fail_on: "ultra" },
      },
    };
    expect(() => validateConfig(data)).toThrow();
  });

  test("valid empty checks object passes", () => {
    const data = { checks: {} };
    const result = validateConfig(data);
    expect(result).toBeDefined();
  });
});
