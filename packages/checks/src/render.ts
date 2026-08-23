import type { CheckResult, CheckRunResults, Finding } from "./types";

/**
 * Compact human-readable rendering of a check run: one markdown table line
 * per check (status, title, finding count) followed by every finding with
 * its file:line. Shared by the MCP run_checks tool and the CLI table.
 */

function findingsOf(result: CheckResult): Finding[] {
  const raw = result.details?.findings;
  return Array.isArray(raw) ? (raw as Finding[]) : [];
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
      findingLines.push(
        `- ${finding.file}:${finding.line} [${result.type}/${finding.rule}] ${finding.severity}: ${finding.message}`,
      );
    }
  }
  if (findingLines.length > 0) {
    sections.push(["Findings:", ...findingLines].join("\n"));
  }
  sections.push(results.summary);
  return sections.join("\n\n");
}
