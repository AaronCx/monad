import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "@aaroncx/protocol";
import { buildReviewPrompt, capFindings, parseReviewReport } from "../src/playbooks/review.ts";

function finding(severity: ReviewFinding["severity"], title: string): ReviewFinding {
  return { path: "src/a.ts", severity, title, body: "b" };
}

const VALID_REPORT = {
  summary: "fine",
  verdict: "comment",
  findings: [
    { path: "src/a.ts", line: 3, severity: "high", title: "t", body: "b" },
  ],
  checks_acknowledged: true,
};

describe("parseReviewReport", () => {
  test("parses the LAST fenced json block", () => {
    const text = [
      "Earlier draft:",
      "```json",
      JSON.stringify({ ...VALID_REPORT, summary: "draft" }),
      "```",
      "Final:",
      "```json",
      JSON.stringify(VALID_REPORT),
      "```",
    ].join("\n");
    const report = parseReviewReport(text);
    expect(report?.summary).toBe("fine");
    expect(report?.verdict).toBe("comment");
  });

  test("returns undefined with no json block", () => {
    expect(parseReviewReport("no fences here")).toBeUndefined();
  });

  test("returns undefined for malformed json", () => {
    expect(parseReviewReport("```json\n{ nope\n```")).toBeUndefined();
  });

  test("returns undefined for a block that fails the schema", () => {
    expect(parseReviewReport('```json\n{"summary": "x"}\n```')).toBeUndefined();
  });
});

describe("capFindings", () => {
  test("keeps the highest severities, preserving order among kept", () => {
    const findings = [
      finding("low", "l1"),
      finding("critical", "c1"),
      finding("nit", "n1"),
      finding("high", "h1"),
      finding("medium", "m1"),
    ];
    const capped = capFindings(findings, 3);
    expect(capped.map((f) => f.title)).toEqual(["c1", "h1", "m1"]);
  });

  test("returns everything when under the cap", () => {
    const findings = [finding("nit", "n1"), finding("low", "l1")];
    expect(capFindings(findings, 25)).toEqual(findings);
  });

  test("ties keep original order", () => {
    const findings = [finding("high", "h1"), finding("high", "h2"), finding("high", "h3")];
    expect(capFindings(findings, 2).map((f) => f.title)).toEqual(["h1", "h2"]);
  });
});

describe("buildReviewPrompt", () => {
  test("substitutes every known placeholder and leaves unknown ones", () => {
    const out = buildReviewPrompt("a {{PR_TITLE}} b {{UNKNOWN_VAR}} c {{PR_TITLE}}", {
      PR_TITLE: "T",
    });
    expect(out).toBe("a T b {{UNKNOWN_VAR}} c T");
  });
});
