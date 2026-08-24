export type CheckStatus = "pass" | "warn" | "fail";
export type CheckType =
  | "secrets"
  | "lint"
  | "typecheck"
  | "build"
  | "test"
  | "dependencies"
  | "file_patterns"
  | "agent_patterns";

export interface CheckResult {
  type: CheckType;
  status: CheckStatus;
  title: string;
  summary?: string;
  details: Record<string, unknown>;
  duration_ms?: number;
}

/**
 * Provenance for a check run: which engine + resolved config produced this
 * result. Stamped into every run so a stale deployment can't be misdiagnosed —
 * the output says exactly what judged it.
 */
export interface CheckRunMeta {
  /** Engine package version that ran the checks. */
  engineVersion: string;
  /** The entropy threshold actually applied (resolved config, not the default). */
  entropyThreshold: number;
  /** Whether this engine honors inline ignore suppressions. */
  inlineIgnore: boolean;
  /** Versioned ruleset identifier, when rulesets are versioned. */
  rulesetVersion?: string;
}

export interface CheckRunResults {
  checks: CheckResult[];
  hasFailures: boolean;
  hasWarnings: boolean;
  failureCount: number;
  warningCount: number;
  summary: string;
  annotations: Annotation[];
  /** Engine + resolved-config provenance (see CheckRunMeta). */
  meta: CheckRunMeta;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string;
}

export interface AddedLine {
  lineNo: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  /** Real post-change file content. Must NOT be set to the raw patch — that's the legacy bug. */
  content: string;
  /** Raw unified-diff patch, kept for reference and for fallback addedLines derivation. */
  patch?: string;
  /**
   * Real new-file line numbers of added lines. Derive via parseAddedLines(patch) at the producer
   * boundary (CLI / playbook). Optional for backward compat: checks fall back to deriving from
   * `patch`, or as a last resort scanning `content` as fully-added (correct for status=added).
   */
  addedLines?: AddedLine[];
  status: "added" | "modified" | "removed" | "renamed";
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";

/**
 * Run profile selector.
 *  - `fast` — pre-commit / interactive loop. Skips heavy operations like full builds.
 *  - `full`: pre-push / CI. Runs everything including the build verifier and test runner.
 */
export type CheckProfile = "fast" | "full";

/**
 * Canonical finding shape for content-scanning checks. Existing checks may keep their bespoke
 * detail shapes for now; statusFromFindings() consumes this severity.
 */
export interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: FindingSeverity;
  match?: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export interface PipelineConfig {
  version?: number;
  checks: {
    secrets?: SecretCheckConfig;
    lint?: LintCheckConfig;
    typecheck?: TypecheckCheckConfig;
    build?: BuildCheckConfig;
    test?: TestCheckConfig;
    dependencies?: DependencyCheckConfig;
    file_patterns?: FilePatternCheckConfig;
    agent_patterns?: AgentPatternCheckConfig;
  };
  /** Top-level path allowlist applied to every content-scanning check. */
  allow?: string[];
  /** Path to the baseline file holding accepted finding fingerprints. */
  baseline?: string;
  protected_branches?: string[];
  /** Review session settings consumed by the engine's review playbook. */
  review?: ReviewConfig;
}

export interface ReviewConfig {
  /** Which check profile a review runs. Default "fast". */
  profile?: CheckProfile;
  /** Worktree dependency-install strategy. Default "auto". */
  install?: "auto" | "symlink" | "install" | "none";
  /** Cap on findings kept in a ReviewReport. Default 25. */
  max_findings?: number;
  /** Per-repo review prompt override path. */
  prompt?: string;
}

export interface SecretCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  /** Shannon entropy threshold for the entropy-only scanner. Default 4.8. */
  entropy_threshold?: number;
  /** Severity tier applied to entropy-only findings. Default "medium" — caps at warn. */
  entropy_severity?: FindingSeverity;
  /** Path globs to silence (in addition to the top-level `allow`). */
  allow?: string[];
  /** Override which run profile this check participates in. Default: "fast". */
  profile?: CheckProfile;
  custom_patterns?: Array<{
    name: string;
    pattern: string;
    severity?: "high" | "critical";
  }>;
}

/**
 * Optional runtime context handed to checks alongside their config. Carries cross-cutting state
 * (baseline fingerprints, merged allowlists) so checks don't have to re-load it themselves.
 */
export interface CheckContext {
  /** Pre-loaded fingerprints from the baseline file. */
  baseline?: Set<string>;
  /** Merged path allowlist (top-level + check-specific). */
  allow?: string[];
}

export interface LintCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  command?: string;
  profile?: CheckProfile;
}

export interface TypecheckCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  command?: string;
  /** Seconds. Default 300. */
  timeout?: number;
  profile?: CheckProfile;
}

export interface BuildCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  command?: string;
  timeout?: number;
  /** Default profile is "full" — only runs in the pre-push / CI loop. */
  profile?: CheckProfile;
}

export interface TestCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  command?: string;
  /** Seconds. Default 600. */
  timeout?: number;
  /** Default profile is "full". */
  profile?: CheckProfile;
}

export interface DependencyCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  fail_on?: "critical" | "high" | "moderate" | "low";
  profile?: CheckProfile;
}

export interface FilePatternCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  block?: string[];
  allow?: string[];
  profile?: CheckProfile;
}

export interface AgentPatternCheckConfig {
  enabled: boolean;
  severity: "fail" | "warn";
  profile?: CheckProfile;
}
