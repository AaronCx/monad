import { describe, expect, test } from "bun:test";
import type { CheckResult, CheckRunResults } from "@aaroncx/checks";
import type { CheckRunConclusion } from "../src/check-runs.ts";
import type { ReviewReport, UnstructuredReport } from "@aaroncx/protocol";
import {
  checkRunConclusion,
  checkRunSummary,
  checkRunText,
  checkRunTitle,
  formatCheckFindings,
  inProgressCheckRunOutput,
  isUnstructuredReport,
  queuedCheckRunOutput,
  renderCompletedCheckRun,
  secretsWarning,
  sessionFooter,
  trustSummaryLine,
} from "../src/render.ts";
import type { TrustDecision } from "../src/trust.ts";

/**
 * The verdict-and-failure matrix from the brief's step 5, plus the summary
 * content. Nothing here calls GitHub; rendering is a pure function of the
 * engine's output, which is the point of the App being a renderer.
 */

function results(overrides: Partial<CheckRunResults> = {}): CheckRunResults {
  const checks: CheckResult[] = overrides.checks ?? [
    { type: "secrets", status: "pass", title: "No secrets found", details: {} },
  ];
  const failureCount = overrides.failureCount ?? checks.filter((c) => c.status === "fail").length;
  const warningCount = overrides.warningCount ?? checks.filter((c) => c.status === "warn").length;
  return {
    checks,
    hasFailures: failureCount > 0,
    hasWarnings: warningCount > 0,
    failureCount,
    warningCount,
    summary: overrides.summary ?? "1 check ran",
    annotations: overrides.annotations ?? [],
    meta: { engineVersion: "0.1.0", entropyThreshold: 4.8, inlineIgnore: true },
    ...overrides,
  };
}

function report(verdict: ReviewReport["verdict"], findings = 0): ReviewReport {
  return {
    summary: "The change is mostly fine.",
    verdict,
    checks_acknowledged: true,
    findings: Array.from({ length: findings }, (_, index) => ({
      path: "src/a.ts",
      line: index + 1,
      severity: "medium" as const,
      title: `finding ${index}`,
      body: "body",
    })),
  };
}

const UNSTRUCTURED: UnstructuredReport = { structured: false, raw: "I could not decide." };

const TRUSTED: TrustDecision = { trust: "trusted", reason: "AaronCx is MEMBER" };
const UNTRUSTED: TrustDecision = { trust: "untrusted", reason: "the head is on a fork" };

describe("checkRunConclusion", () => {
  const cases: Array<[ReviewReport["verdict"], boolean, CheckRunConclusion]> = [
    ["looks_good", false, "success"],
    ["looks_good", true, "failure"],
    ["comment", false, "neutral"],
    ["comment", true, "failure"],
    ["needs_changes", false, "failure"],
    ["needs_changes", true, "failure"],
  ];
  for (const [verdict, checksFailed, expected] of cases) {
    test(`${verdict} with ${checksFailed ? "a failed check" : "no failed check"} is ${expected}`, () => {
      expect(checkRunConclusion({ report: report(verdict), checksFailed })).toBe(expected);
    });
  }

  test("a report that failed to parse is action_required", () => {
    expect(checkRunConclusion({ report: UNSTRUCTURED, checksFailed: false })).toBe(
      "action_required",
    );
  });

  test("a report that failed to parse stays action_required even with a failed check", () => {
    expect(checkRunConclusion({ report: UNSTRUCTURED, checksFailed: true })).toBe(
      "action_required",
    );
  });

  test("isUnstructuredReport tells the two shapes apart", () => {
    expect(isUnstructuredReport(UNSTRUCTURED)).toBe(true);
    expect(isUnstructuredReport(report("comment"))).toBe(false);
  });
});

describe("checkRunTitle", () => {
  test("names the verdict and both counts", () => {
    expect(checkRunTitle({ report: report("needs_changes", 3), results: results({ failureCount: 1 }) })).toBe(
      "needs_changes: 3 findings, 1 check failed",
    );
  });

  test("singular and plural are both right", () => {
    expect(checkRunTitle({ report: report("comment", 1), results: results({ failureCount: 2 }) })).toBe(
      "comment: 1 finding, 2 checks failed",
    );
  });

  test("a clean run says so", () => {
    expect(checkRunTitle({ report: report("looks_good"), results: results() })).toBe(
      "looks_good: no findings, all checks passed",
    );
  });

  test("an unparsable report says that instead of a verdict", () => {
    expect(checkRunTitle({ report: UNSTRUCTURED, results: results() })).toBe(
      "the review report could not be parsed, all checks passed",
    );
  });
});

describe("trust rendering", () => {
  test("untrusted names what does not run", () => {
    expect(trustSummaryLine(UNTRUSTED)).toBe(
      "untrusted PR: install, build, and test do not run (the head is on a fork)",
    );
  });

  test("trusted names what does", () => {
    expect(trustSummaryLine(TRUSTED)).toContain("trusted PR: the repo's own toolchain runs");
  });

  test("the queued output says nothing it cannot know yet", () => {
    expect(queuedCheckRunOutput()).toEqual({
      title: "queued",
      summary: "monad has queued a review of this pull request.",
    });
  });

  test("the in_progress output carries the trust line", () => {
    expect(inProgressCheckRunOutput(UNTRUSTED)).toEqual({
      title: "reviewing",
      summary: trustSummaryLine(UNTRUSTED),
    });
  });
});

describe("checkRunSummary", () => {
  test("carries the trust line, the report summary, the verdict, and the checks table", () => {
    const summary = checkRunSummary({
      report: report("comment", 1),
      results: results(),
      trust: UNTRUSTED,
    });
    expect(summary).toContain("untrusted PR:");
    expect(summary).toContain("The change is mostly fine.");
    expect(summary).toContain("**Verdict:** comment");
    expect(summary).toContain("| check | status | findings |");
  });

  test("an unparsable report says a human should look, and claims no verdict", () => {
    const summary = checkRunSummary({ report: UNSTRUCTURED, results: results(), trust: TRUSTED });
    expect(summary).toContain("no parsable report block");
    expect(summary).not.toContain("**Verdict:**");
    // The raw text stays in the transcript rather than being republished.
    expect(summary).not.toContain("I could not decide.");
  });

  test("the session id is a footer when there is one", () => {
    const summary = checkRunSummary({
      report: report("looks_good"),
      results: results(),
      trust: TRUSTED,
      sessionId: "s-abc",
    });
    expect(summary).toContain(sessionFooter("s-abc"));
    expect(summary).toContain("monad attach s-abc");
  });

  test("no session id means no footer", () => {
    expect(
      checkRunSummary({ report: report("looks_good"), results: results(), trust: TRUSTED }),
    ).not.toContain("monad attach");
  });

  test("no dashboard link survived the port", () => {
    const summary = checkRunSummary({
      report: report("comment"),
      results: results(),
      trust: TRUSTED,
      sessionId: "s-abc",
    });
    expect(summary).not.toContain("http");
    expect(summary).not.toContain("Agent Instructions");
  });
});

describe("secrets findings", () => {
  const leaky = results({
    checks: [
      {
        type: "secrets",
        status: "fail",
        title: "1 secret found",
        details: {
          findings: [
            {
              file: "src/config.ts",
              line: 14,
              rule: "aws_access_key",
              message: "AWS access key",
              severity: "critical",
            },
          ],
        },
      },
    ],
  });

  test("the summary tells you to rotate the key", () => {
    expect(secretsWarning(leaky)).toContain("Rotate any exposed key now");
    expect(checkRunSummary({ report: report("needs_changes", 1), results: leaky, trust: TRUSTED })).toContain(
      "Rotate any exposed key now",
    );
  });

  test("a clean run says nothing about rotation", () => {
    expect(secretsWarning(results())).toBeUndefined();
  });

  test("the detail table names the location, the rule, and the message", () => {
    const text = formatCheckFindings(leaky);
    expect(text).toContain("### FAIL secrets");
    expect(text).toContain("| where | rule | message |");
    expect(text).toContain("| src/config.ts:14 | aws_access_key | AWS access key |");
  });

  test("checkRunText is undefined when nothing failed", () => {
    expect(checkRunText(results())).toBeUndefined();
  });

  test("a pipe in a finding cannot break the table", () => {
    const piped = results({
      checks: [
        {
          type: "lint",
          status: "warn",
          title: "1 problem",
          details: { findings: [{ file: "a.ts", line: 1, rule: "r", message: "a | b\nc" }] },
        },
      ],
    });
    const text = formatCheckFindings(piped);
    expect(text).toContain("| a.ts:1 | r | a \\| b c |");
    expect(text.split("\n").filter((line) => line.startsWith("| a.ts"))).toHaveLength(1);
  });

  test("a backslash in front of a pipe cannot break the table either", () => {
    // Escaping the pipe alone leaves the input's own backslash in front of
    // monad's, markdown eats the pair, and the bare pipe splits the row.
    // Backslashes are escaped first, so this stays one cell.
    const sneaky = results({
      checks: [
        {
          type: "lint",
          status: "warn",
          title: "1 problem",
          details: {
            findings: [{ file: "a.ts", line: 1, rule: "r", message: "a \\| b | c" }],
          },
        },
      ],
    });
    const text = formatCheckFindings(sneaky);
    const row = text.split("\n").filter((line) => line.startsWith("| a.ts"));
    expect(row).toHaveLength(1);
    expect(row[0]).toBe("| a.ts:1 | r | a \\\\\\| b \\| c |");
  });
});

describe("renderCompletedCheckRun", () => {
  test("assembles the conclusion, the title, the summary, and the text in one call", () => {
    const rendered = renderCompletedCheckRun({
      report: report("needs_changes", 2),
      results: results({
        checks: [
          {
            type: "lint",
            status: "fail",
            title: "2 problems",
            details: { findings: [{ file: "a.ts", line: 1, rule: "r", message: "m" }] },
          },
        ],
      }),
      trust: UNTRUSTED,
      sessionId: "s-1",
    });
    expect(rendered.conclusion).toBe("failure");
    expect(rendered.title).toBe("needs_changes: 2 findings, 1 check failed");
    expect(rendered.summary).toContain("untrusted PR:");
    expect(rendered.text).toContain("### FAIL lint");
  });

  test("checksFailed defaults to the results' own hasFailures", () => {
    expect(
      renderCompletedCheckRun({ report: report("looks_good"), results: results(), trust: TRUSTED })
        .conclusion,
    ).toBe("success");
  });
});
