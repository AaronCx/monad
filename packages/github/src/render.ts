import {
  findingLocation,
  findingMessage,
  findingRule,
  formatChecksMarkdown,
} from "@aaroncx/checks";
import type { CheckResult, CheckRunResults } from "@aaroncx/checks";
import type { ReviewReport, UnstructuredReport } from "@aaroncx/protocol";
import type { CheckRunConclusion, CheckRunOutput } from "./check-runs.ts";
import type { TrustDecision } from "./trust.ts";

/**
 * Rendering a finished review into a Check Run.
 *
 * Ported from LastGate's apps/web/lib/github/comments.ts buildPRComment and
 * renderCheckFindings, minus the dashboard URL (monad has no dashboard) and
 * minus the agent-feedback section (the review report is the feedback, and
 * an agent-instructions block written by the renderer is a second engine).
 *
 * monad's own packages/checks formatChecksMarkdown is the base for the
 * checks half, because it already normalizes the heterogeneous finding
 * shapes the ported checks emit. What LastGate had that it lacks is a
 * columned table per failing check and the one genuinely actionable line in
 * the whole renderer, the instruction to rotate a leaked key. Both are here;
 * nothing else came across.
 *
 * Nothing in this file decides anything. The verdict comes from the engine,
 * the check statuses come from packages/checks, and the trust level was
 * resolved from the signed payload before the session opened.
 */

export function isUnstructuredReport(
  report: ReviewReport | UnstructuredReport,
): report is UnstructuredReport {
  return (report as UnstructuredReport).structured === false;
}

/**
 * The Check Run conclusion, per the M3 brief's step 5:
 *
 * - action_required when the report failed to parse, because a human should
 *   look rather than a bot claiming a verdict it did not produce;
 * - failure when any check failed or the verdict is needs_changes;
 * - neutral for comment with no check failures;
 * - success for looks_good with none.
 *
 * A failed check outranks a happy verdict deliberately. The verdict is a
 * model's opinion; a failed check is a program that ran and did not like
 * what it found.
 */
export function checkRunConclusion(input: {
  report: ReviewReport | UnstructuredReport;
  checksFailed: boolean;
}): CheckRunConclusion {
  if (isUnstructuredReport(input.report)) {
    return "action_required";
  }
  if (input.checksFailed || input.report.verdict === "needs_changes") {
    return "failure";
  }
  return input.report.verdict === "comment" ? "neutral" : "success";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The verdict plus counts, which is all output.title has room for. */
export function checkRunTitle(input: {
  report: ReviewReport | UnstructuredReport;
  results: CheckRunResults;
}): string {
  const checks =
    input.results.failureCount === 0
      ? "all checks passed"
      : `${plural(input.results.failureCount, "check")} failed`;
  if (isUnstructuredReport(input.report)) {
    return `the review report could not be parsed, ${checks}`;
  }
  const findings =
    input.report.findings.length === 0
      ? "no findings"
      : plural(input.report.findings.length, "finding");
  return `${input.report.verdict}: ${findings}, ${checks}`;
}

/** The one-line summary the in_progress update carries. */
export function trustSummaryLine(decision: TrustDecision): string {
  return decision.trust === "untrusted"
    ? `untrusted PR: install, build, and test do not run (${decision.reason})`
    : `trusted PR: the repo's own toolchain runs (${decision.reason})`;
}

/** The output for the check run created the moment a delivery is queued. */
export function queuedCheckRunOutput(): CheckRunOutput {
  return {
    title: "queued",
    summary: "monad has queued a review of this pull request.",
  };
}

/** The output for the update sent once the review session opens. */
export function inProgressCheckRunOutput(decision: TrustDecision): CheckRunOutput {
  return { title: "reviewing", summary: trustSummaryLine(decision) };
}

/** `monad attach <id>` is the whole point of leaving the session open. */
export function sessionFooter(sessionId: string): string {
  return `Session \`${sessionId}\`. Run \`monad attach ${sessionId}\` to pick it up.`;
}

type RawFinding = Record<string, unknown>;

function findingsOf(result: CheckResult): RawFinding[] {
  const raw = result.details?.findings;
  return Array.isArray(raw) ? (raw as RawFinding[]) : [];
}

/**
 * One markdown table cell, built from a finding a model wrote after reading
 * the pull request, so the content is not monad's.
 *
 * Backslashes are escaped first and pipes second, which is the order that
 * matters. Escaping only the pipe leaves a backslash the input supplied
 * sitting in front of monad's own escape, markdown reads that pair as one
 * literal backslash, and the pipe behind it splits the row. Escaping the
 * backslash first makes monad's escape the only one markdown can consume.
 * Every replacement here is a single character class with no quantifier, so
 * there is nothing to backtrack on either.
 */
function cell(value: string | undefined): string {
  const text = value === undefined || value.length === 0 ? "-" : value;
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * LastGate's renderCheckFindings, generalized. It had one branch per check
 * type because each check's findings had their own field names; monad
 * normalizes those in packages/checks (findingLocation, findingRule,
 * findingMessage), so one table serves every check.
 */
export function formatCheckFindings(results: CheckRunResults): string {
  const sections: string[] = [];
  for (const result of results.checks) {
    const findings = findingsOf(result);
    if (result.status === "pass" || findings.length === 0) {
      continue;
    }
    const label = result.status === "fail" ? "FAIL" : "warn";
    const rows = findings.map(
      (finding) =>
        `| ${cell(findingLocation(finding))} | ${cell(findingRule(finding))} | ${cell(findingMessage(finding))} |`,
    );
    sections.push(
      [
        `### ${label} ${result.type}`,
        result.title,
        "",
        "| where | rule | message |",
        "| --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * The one line from LastGate's renderer worth keeping verbatim in spirit: a
 * leaked credential is already leaked, and rotating it is the only thing
 * that helps.
 */
export function secretsWarning(results: CheckRunResults): string | undefined {
  const secrets = results.checks.find(
    (result) => result.type === "secrets" && findingsOf(result).length > 0,
  );
  if (secrets === undefined) {
    return undefined;
  }
  return (
    "Rotate any exposed key now: it is in the pull request's history whether or not " +
    "this is merged. Move the value to an environment variable or a secret store."
  );
}

export interface CheckRunSummaryInput {
  report: ReviewReport | UnstructuredReport;
  results: CheckRunResults;
  trust: TrustDecision;
  /** Leaving the session open is the product; naming it is how it is reached. */
  sessionId?: string;
}

/**
 * output.summary: the trust line, the report summary and verdict, and the
 * checks table with its findings. LastGate put a dashboard link here; monad
 * puts the session id, because there is no dashboard and there is a session.
 */
export function checkRunSummary(input: CheckRunSummaryInput): string {
  const sections: string[] = [trustSummaryLine(input.trust)];
  if (isUnstructuredReport(input.report)) {
    sections.push(
      "The review agent's final message had no parsable report block, so monad has no " +
        "verdict for this pull request. The raw message is in the session transcript.",
    );
  } else {
    sections.push(input.report.summary, `**Verdict:** ${input.report.verdict}`);
  }
  const warning = secretsWarning(input.results);
  if (warning !== undefined) {
    sections.push(warning);
  }
  sections.push("### Checks", formatChecksMarkdown(input.results));
  if (input.sessionId !== undefined) {
    sections.push(sessionFooter(input.sessionId));
  }
  return sections.join("\n\n");
}

/** output.text: the per-check detail tables, when there is anything to show. */
export function checkRunText(results: CheckRunResults): string | undefined {
  const detail = formatCheckFindings(results);
  return detail.length === 0 ? undefined : detail;
}

/** Everything a completed check run needs, in one call. */
export function renderCompletedCheckRun(input: CheckRunSummaryInput & { checksFailed?: boolean }): {
  conclusion: CheckRunConclusion;
  title: string;
  summary: string;
  text?: string;
} {
  const checksFailed = input.checksFailed ?? input.results.hasFailures;
  return {
    conclusion: checkRunConclusion({ report: input.report, checksFailed }),
    title: checkRunTitle({ report: input.report, results: input.results }),
    summary: checkRunSummary(input),
    text: checkRunText(input.results),
  };
}
