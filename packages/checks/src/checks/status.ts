import type { CheckStatus, FindingSeverity } from "../types";

interface SeverityCarrier {
  severity: FindingSeverity;
}

/**
 * Derive a CheckStatus from a list of findings and the check's configured severity.
 *
 * Rules:
 *  - No findings → "pass".
 *  - Any "critical" or "high" finding → respect cfg.severity ("fail" or "warn").
 *  - Only "medium"/"low" findings → cap at "warn" regardless of cfg.severity. This stops
 *    low-confidence entropy guesses from hard-blocking commits while still surfacing them.
 *
 * Crashes inside the check itself should still produce "fail" — that's the check's call,
 * not this helper's.
 */
export function statusFromFindings(
  findings: SeverityCarrier[],
  cfg: { severity: "fail" | "warn" },
): CheckStatus {
  if (findings.length === 0) return "pass";
  const hasHigh = findings.some(
    (f) => f.severity === "critical" || f.severity === "high",
  );
  if (hasHigh) {
    return cfg.severity === "fail" ? "fail" : "warn";
  }
  return "warn";
}
