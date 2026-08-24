import { describe, expect, test } from "bun:test";
import { describeFinding, formatChecksMarkdown, formatChecksTable } from "../src/index";
import type { CheckRunResults } from "../src/index";

/**
 * Findings are not one shape: every ported check kept its own detail object.
 * The renderer feeds the CLI table, the MCP run_checks text, and the review
 * prompt, so a check whose findings lack `rule` or `message` must still read
 * as a sentence rather than "[secrets/undefined] critical: undefined".
 */

describe("describeFinding", () => {
  test("secrets: file:line, the pattern name, severity, and the redacted match", () => {
    expect(
      describeFinding("secrets", {
        file: "src/config.ts",
        line: 12,
        pattern: "Generic API Key Assignment",
        match: "api_key = ****",
        severity: "critical",
      }),
    ).toBe("src/config.ts:12 [secrets/Generic API Key Assignment] critical: api_key = ****");
  });

  test("file_patterns: a file with no line and no severity", () => {
    expect(describeFinding("file_patterns", { file: ".env", pattern: "**/.env" })).toBe(
      ".env [file_patterns/**/.env]",
    );
  });

  test("agent_patterns: no file at all, the detail sentence carries it", () => {
    expect(
      describeFinding("agent_patterns", {
        pattern: "Wide Scope",
        details: "Changeset touches 9 top-level directories",
        severity: "low",
      }),
    ).toBe("[agent_patterns/Wide Scope] low: Changeset touches 9 top-level directories");
  });

  test("dependencies: the package stands in for the location", () => {
    expect(
      describeFinding("dependencies", {
        package: "leftpad",
        severity: "high",
        title: "Vulnerability in leftpad",
      }),
    ).toBe("leftpad [dependencies/leftpad] high: Vulnerability in leftpad");
  });

  test("typecheck: the canonical shape is unchanged", () => {
    expect(
      describeFinding("typecheck", {
        file: "src/a.ts",
        line: 3,
        rule: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        severity: "high",
      }),
    ).toBe(
      "src/a.ts:3 [typecheck/TS2322] high: Type 'string' is not assignable to type 'number'.",
    );
  });

  test("an empty finding still names the check", () => {
    expect(describeFinding("lint", {})).toBe("[lint/finding]");
  });
});

const RESULTS: CheckRunResults = {
  checks: [
    {
      type: "secrets",
      status: "fail",
      title: "Secret Scanner",
      details: {
        findings: [
          { file: "src/a.ts", line: 2, pattern: "Generic API Key Assignment", severity: "critical" },
        ],
      },
    },
    { type: "lint", status: "pass", title: "Lint & Type Check", details: {} },
  ],
  hasFailures: true,
  hasWarnings: false,
  failureCount: 1,
  warningCount: 0,
  summary: "1 failure",
  annotations: [],
  meta: { engineVersion: "test", entropyThreshold: 4.8, inlineIgnore: true },
};

describe("formatChecksTable and formatChecksMarkdown", () => {
  test("the table is one line per check with its finding count", () => {
    expect(formatChecksTable(RESULTS).split("\n")).toEqual([
      "| check | status | findings |",
      "| --- | --- | --- |",
      "| Secret Scanner | FAIL | 1 |",
      "| Lint & Type Check | pass | 0 |",
    ]);
  });

  test("the markdown adds the findings list and the summary", () => {
    const markdown = formatChecksMarkdown(RESULTS);
    expect(markdown).toContain("| Secret Scanner | FAIL | 1 |");
    expect(markdown).toContain(
      "- src/a.ts:2 [secrets/Generic API Key Assignment] critical:",
    );
    expect(markdown).not.toContain("undefined");
    expect(markdown.endsWith("1 failure")).toBe(true);
  });
});
