import type {
  CheckContext,
  CheckProfile,
  CheckResult,
  CheckRunMeta,
  CheckRunResults,
  ChangedFile,
  CommitInfo,
  PipelineConfig,
  Annotation,
} from "./types";
import { ENGINE_VERSION } from "./version";
import { checkSecrets } from "./checks/secrets";

// Mirrors the secrets check's default (kept local so resolveMeta doesn't have to
// import from the secrets module). The secrets check remains the authority for
// applying it; this is only for reporting the resolved value in meta.
const DEFAULT_ENTROPY_THRESHOLD = 4.8;
import { checkLint } from "./checks/lint";
import { checkTypecheck } from "./checks/typecheck";
import { checkBuild } from "./checks/build";
import { checkTest } from "./checks/test";
import { checkDependencies } from "./checks/dependencies";
import { checkFilePatterns } from "./checks/file-patterns";
import { checkAgentPatterns } from "./checks/agent-patterns";
import { getDefaultConfig } from "./config/defaults";
import { deepMerge } from "./config/merge";
import { DEFAULT_BASELINE_PATH, loadBaseline } from "./config/allowlist";

export interface PipelineInput {
  files: ChangedFile[];
  commits: CommitInfo[];
  /** Repo or worktree root the command-running checks execute in. Defaults to process.cwd(). */
  cwd?: string;
  config?: Partial<PipelineConfig>;
  previousCommits?: CommitInfo[];
}

export interface PipelineOptions {
  /**
   * Run profile.
   *  - "fast" (default) — pre-commit / interactive loop. Skips checks whose default or
   *    configured profile is "full" (the build verifier and the test runner).
   *  - "full" — pre-push / CI. Runs every enabled check.
   */
  profile?: CheckProfile;
  /** Restrict the run to these check keys (still subject to enabled + profile). */
  only?: Array<keyof PipelineConfig["checks"]>;
}

/** Default profile per check key. `build` and `test` are `full` only; everything else runs in `fast`. */
const DEFAULT_PROFILE_BY_CHECK: Record<keyof PipelineConfig["checks"], CheckProfile> = {
  secrets: "fast",
  file_patterns: "fast",
  lint: "fast",
  typecheck: "fast",
  build: "full",
  test: "full",
  dependencies: "fast",
  agent_patterns: "fast",
};

export function defaultProfileFor(checkKey: keyof PipelineConfig["checks"]): CheckProfile {
  return DEFAULT_PROFILE_BY_CHECK[checkKey];
}

function checkRunsInProfile(
  checkKey: keyof PipelineConfig["checks"],
  configProfile: CheckProfile | undefined,
  runProfile: CheckProfile,
): boolean {
  const effective: CheckProfile = configProfile ?? DEFAULT_PROFILE_BY_CHECK[checkKey];
  // A "fast" check always runs in "full". A "full" check only runs in "full".
  if (runProfile === "full") return true;
  return effective === "fast";
}

interface CheckEntry {
  key: keyof PipelineConfig["checks"];
  /** `priorResults` holds the results of checks that already ran this pass. */
  fn: (priorResults: CheckResult[]) => Promise<CheckResult>;
}

/** Order of the pipeline's entry table, exported for listChecks. */
export const CHECK_ORDER: ReadonlyArray<keyof PipelineConfig["checks"]> = [
  "secrets",
  "file_patterns",
  "agent_patterns",
  "lint",
  "typecheck",
  "dependencies",
  "build",
  "test",
];

/**
 * Set up the cheap → expensive list of enabled-and-in-profile checks plus a runner that times +
 * crash-traps each call. Returns the entries the iterable and the batch runner share.
 */
async function buildCheckEntries(
  input: PipelineInput,
  opts: PipelineOptions,
): Promise<{
  entries: CheckEntry[];
  runEntry: (entry: CheckEntry, priorResults?: CheckResult[]) => Promise<CheckResult>;
}> {
  const runProfile: CheckProfile = opts.profile ?? "fast";
  // Deep-merge so a partial caller config (e.g. one that sets only some
  // `checks` keys) layers field-by-field over the defaults instead of replacing
  // the whole `checks` object. A shallow spread here silently dropped every
  // unset check and stripped `severity` from the ones present — downgrading real
  // secret leaks from blocking `fail` to non-blocking `warn`.
  const config = deepMerge(
    getDefaultConfig() as unknown as Record<string, unknown>,
    (input.config ?? {}) as Record<string, unknown>,
  ) as unknown as PipelineConfig;

  const cwd = input.cwd ?? process.cwd();
  const baselinePath = config.baseline ?? DEFAULT_BASELINE_PATH;
  const baseline = await loadBaseline(baselinePath, cwd);
  const sharedContext: CheckContext = { baseline, allow: config.allow };

  // Command-running checks read their cwd off the config object; inject the
  // pipeline's cwd so they run in the worktree, never the daemon's cwd.
  const withCwd = <T extends object>(c: T): T & { cwd: string } => ({ ...c, cwd });

  const all: CheckEntry[] = [
    { key: "secrets", fn: () => checkSecrets(input.files, config.checks.secrets!, sharedContext) },
    { key: "file_patterns", fn: () => checkFilePatterns(input.files, config.checks.file_patterns!) },
    {
      key: "agent_patterns",
      fn: () =>
        checkAgentPatterns(
          input.commits,
          input.files,
          input.previousCommits || [],
          config.checks.agent_patterns!,
        ),
    },
    { key: "lint", fn: () => checkLint(input.files, withCwd(config.checks.lint!)) },
    { key: "typecheck", fn: () => checkTypecheck(withCwd(config.checks.typecheck!)) },
    { key: "dependencies", fn: () => checkDependencies(input.files, withCwd(config.checks.dependencies!)) },
    { key: "build", fn: () => checkBuild(withCwd(config.checks.build!)) },
    { key: "test", fn: () => checkTest(withCwd(config.checks.test!)) },
  ];

  const entries = all.filter((entry) => {
    if (opts.only && !opts.only.includes(entry.key)) return false;
    const checkConfig = config.checks[entry.key];
    if (!checkConfig || !checkConfig.enabled) return false;
    return checkRunsInProfile(entry.key, checkConfig.profile, runProfile);
  });

  const runEntry = async (entry: CheckEntry, priorResults: CheckResult[] = []): Promise<CheckResult> => {
    const start = performance.now();
    try {
      const result = await entry.fn(priorResults);
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    } catch (error) {
      return {
        type: entry.key as CheckResult["type"],
        status: "fail",
        title: `Check "${entry.key}" crashed`,
        summary: error instanceof Error ? error.message : String(error),
        details: { error: String(error) },
        duration_ms: Math.round(performance.now() - start),
      };
    }
  };

  return { entries, runEntry };
}

/**
 * Stream check results one at a time, in cheap → expensive order.
 * Consumers can pause after each yielded result (e.g. to prompt the user) before the next check fires.
 */
export async function* runChecksIterable(
  input: PipelineInput,
  opts: PipelineOptions = {},
): AsyncGenerator<CheckResult> {
  const { entries, runEntry } = await buildCheckEntries(input, opts);
  const priorResults: CheckResult[] = [];
  for (const entry of entries) {
    const result = await runEntry(entry, priorResults);
    priorResults.push(result);
    yield result;
  }
}

/**
 * Re-run a single check by key against current state. Used by steppers to re-check after
 * a fix has been applied or a baseline entry added.
 */
export async function runSingleCheck(
  input: PipelineInput,
  opts: PipelineOptions,
  key: keyof PipelineConfig["checks"],
): Promise<CheckResult | undefined> {
  const { entries, runEntry } = await buildCheckEntries(input, opts);
  const entry = entries.find((e) => e.key === key);
  if (!entry) return undefined;
  return runEntry(entry);
}

/** Resolve the run's provenance metadata from the merged config. */
export function resolveMeta(config: Partial<PipelineConfig> | undefined): CheckRunMeta {
  const merged = deepMerge(
    getDefaultConfig() as unknown as Record<string, unknown>,
    (config ?? {}) as Record<string, unknown>,
  ) as unknown as PipelineConfig;
  return {
    engineVersion: ENGINE_VERSION,
    entropyThreshold: merged.checks.secrets?.entropy_threshold ?? DEFAULT_ENTROPY_THRESHOLD,
    inlineIgnore: true,
  };
}

/** One-line provenance footer, e.g. `engine v0.1.0 · entropy 4.8 · inline-ignore on`. */
export function formatMetaFooter(meta: CheckRunMeta): string {
  const parts = [
    `engine v${meta.engineVersion}`,
    `entropy ${meta.entropyThreshold}`,
    `inline-ignore ${meta.inlineIgnore ? "on" : "off"}`,
  ];
  if (meta.rulesetVersion) parts.push(`ruleset ${meta.rulesetVersion}`);
  return parts.join(" · ");
}

export async function runCheckPipeline(
  input: PipelineInput,
  opts: PipelineOptions = {},
): Promise<CheckRunResults> {
  const results: CheckResult[] = [];
  for await (const r of runChecksIterable(input, opts)) {
    results.push(r);
  }

  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");
  const annotations = buildAnnotations(results);

  const meta = resolveMeta(input.config);
  const summary = buildSummary(results, meta);

  return {
    checks: results,
    hasFailures: failures.length > 0,
    hasWarnings: warnings.length > 0,
    failureCount: failures.length,
    warningCount: warnings.length,
    summary,
    annotations,
    meta,
  };
}

function buildAnnotations(results: CheckResult[]): Annotation[] {
  const annotations: Annotation[] = [];

  for (const result of results) {
    const findings = (result.details.findings as Array<Record<string, unknown>>) || [];
    for (const finding of findings) {
      if (finding.file && finding.line) {
        annotations.push({
          path: finding.file as string,
          start_line: finding.line as number,
          end_line: finding.line as number,
          annotation_level:
            result.status === "fail" ? "failure" : "warning",
          message: (finding.message as string) || (finding.pattern as string) || result.title,
          title: `${result.type}: ${(finding.pattern as string) || result.title}`,
        });
      }
    }
  }

  return annotations;
}

function buildSummary(results: CheckResult[], meta?: CheckRunMeta): string {
  const lines: string[] = [];
  lines.push("## monad Check Results\n");

  for (const result of results) {
    const icon =
      result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
    const duration = result.duration_ms ? ` (${result.duration_ms}ms)` : "";
    lines.push(`${icon} **${result.type}**: ${result.title}${duration}`);

    if (result.summary) {
      lines.push(`   ${result.summary}`);
    }
  }

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const passes = results.filter((r) => r.status === "pass").length;

  lines.push("");
  lines.push("---");
  lines.push(
    `**${passes} passed**, **${warnings} warnings**, **${failures} failures**`
  );

  // Provenance footer — so a PR author sees which engine + threshold judged them.
  if (meta) {
    lines.push("");
    lines.push(`_${formatMetaFooter(meta)}_`);
  }

  return lines.join("\n");
}
