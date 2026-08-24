import type { CheckResult, CheckRunResults } from "./types";

/**
 * Compact human-readable rendering of a check run: one markdown table line
 * per check (status, title, finding count) followed by every finding with
 * its file:line. Shared by the MCP run_checks tool, the CLI table, and the
 * review prompt.
 *
 * Finding objects are NOT uniform: the ported checks keep their own detail
 * shapes (secrets emits { file, line, pattern, match }, file_patterns
 * { file, pattern }, agent_patterns { pattern, details }, dependencies
 * { package, title, url }, typecheck the canonical { file, line, rule,
 * message }). Rendering therefore normalizes the same way the pipeline's
 * annotation builder does instead of assuming one shape, which is what
 * printed "[secrets/undefined] critical: undefined" before.
 */

type RawFinding = Record<string, unknown>;

function findingsOf(result: CheckResult): RawFinding[] {
  const raw = result.details?.findings;
  return Array.isArray(raw) ? (raw as RawFinding[]) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** file:line when the finding has one, else the package name, else nothing. */
export function findingLocation(finding: RawFinding): string | undefined {
  const file = text(finding.file);
  if (file !== undefined) {
    return typeof finding.line === "number" ? `${file}:${finding.line}` : file;
  }
  return text(finding.package);
}

/** The rule-ish label: rule, else the pattern name, else the package. */
export function findingRule(finding: RawFinding): string {
  return text(finding.rule) ?? text(finding.pattern) ?? text(finding.package) ?? "finding";
}

/** The human sentence: message, else title, else details, else the match. */
export function findingMessage(finding: RawFinding): string {
  return (
    text(finding.message) ??
    text(finding.title) ??
    text(finding.details) ??
    text(finding.match) ??
    ""
  );
}

/** One line for one finding: location, [check/rule], severity, message. */
export function describeFinding(checkType: string, finding: RawFinding): string {
  const parts: string[] = [];
  const location = findingLocation(finding);
  if (location !== undefined) {
    parts.push(location);
  }
  parts.push(`[${checkType}/${findingRule(finding)}]`);
  const severity = text(finding.severity);
  const message = findingMessage(finding);
  const tail = [severity !== undefined ? `${severity}:` : undefined, message]
    .filter((piece) => piece !== undefined && piece.length > 0)
    .join(" ");
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts.join(" ");
}

const STATUS_LABEL: Record<CheckResult["status"], string> = {
  pass: "pass",
  warn: "warn",
  fail: "FAIL",
};

/** One markdown table line per check: status, title, finding count. */
export function formatChecksTable(results: CheckRunResults): string {
  const lines = ["| check | status | findings |", "| --- | --- | --- |"];
  for (const result of results.checks) {
    const count = findingsOf(result).length;
    lines.push(`| ${result.title} | ${STATUS_LABEL[result.status]} | ${count} |`);
  }
  return lines.join("\n");
}

/**
 * The table plus a findings list (file:line, rule, message per finding) and
 * the run summary. This is the text content of the run_checks tool result.
 */
export function formatChecksMarkdown(results: CheckRunResults): string {
  const sections = [formatChecksTable(results)];
  const findingLines: string[] = [];
  for (const result of results.checks) {
    for (const finding of findingsOf(result)) {
      findingLines.push(`- ${describeFinding(result.type, finding)}`);
    }
  }
  if (findingLines.length > 0) {
    sections.push(["Findings:", ...findingLines].join("\n"));
  }
  sections.push(results.summary);
  return sections.join("\n\n");
}
