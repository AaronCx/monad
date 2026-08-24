import {
  CHECK_ORDER,
  describeDroppedConfigFields,
  detectDefaultBranch,
  formatChecksMarkdown,
  getBranchDiff,
  getStagedDiff,
  LASTGATE_RENAME_NOTICE,
  loadConfig,
  runChecks,
  sanitizeUntrustedConfig,
  type ChangedFile,
  type CheckRunResults,
  type CheckType,
} from "@aaroncx/checks";

/**
 * monad checks: the LastGate CLI replacement and the pre-commit hook entry
 * point (see docs/checks.md). No daemon, no session, no vendor agent; the
 * check engine runs in this process against the current repo.
 */

export interface ChecksFlags {
  staged: boolean;
  /** Undefined means "the repo's default branch", resolved at run time. */
  base?: string;
  only?: CheckType[];
  full: boolean;
  json: boolean;
  /**
   * --untrusted: treat this checkout as somebody else's code (decision
   * record 0009). Drops the config's command fields, custom secret patterns,
   * and review.prompt, and refuses to run build and test. The default is
   * trusted, because you cd'd here.
   */
  untrusted?: boolean;
}

const KNOWN_CHECKS = CHECK_ORDER as ReadonlyArray<CheckType>;

export function parseChecksFlags(argv: string[]): ChecksFlags {
  const flags: ChecksFlags = { staged: false, full: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--staged") {
      flags.staged = true;
    } else if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--base needs a ref");
      }
      flags.base = value;
    } else if (arg === "--only") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--only needs a comma-separated list of check names");
      }
      const names = value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length === 0) {
        throw new Error("--only needs at least one check name");
      }
      for (const name of names) {
        if (!KNOWN_CHECKS.includes(name as CheckType)) {
          throw new Error(`unknown check ${name}; known checks: ${KNOWN_CHECKS.join(", ")}`);
        }
      }
      flags.only = names as CheckType[];
    } else if (arg === "--full") {
      flags.full = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--untrusted") {
      flags.untrusted = true;
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  if (flags.staged && flags.base !== undefined) {
    throw new Error("--staged and --base are mutually exclusive");
  }
  return flags;
}

export interface ChecksScope {
  files: ChangedFile[];
  /** Commit range bounds for agent_patterns; a staged run has no commits. */
  base?: string;
  head?: string;
  label: string;
}

/**
 * Resolves what to check: the staged diff, or the diff against a base ref
 * (defaulting to the repo's default branch).
 */
export async function resolveScope(flags: ChecksFlags, cwd: string): Promise<ChecksScope> {
  if (flags.staged) {
    return { files: await getStagedDiff(cwd), label: "staged changes" };
  }
  const base = flags.base ?? (await detectDefaultBranch(cwd));
  if (base === undefined) {
    throw new Error("cannot detect the repo's default branch; pass --base <ref>");
  }
  return {
    files: await getBranchDiff(base, cwd),
    base,
    head: "HEAD",
    label: `HEAD against ${base}`,
  };
}

export interface ChecksOutcome {
  results: CheckRunResults;
  /** Exit code: 1 when any check failed. */
  code: 0 | 1;
}

export async function runChecksCommand(flags: ChecksFlags, cwd: string): Promise<ChecksOutcome> {
  const loaded = await loadConfig(cwd);
  const trust = flags.untrusted ? "untrusted" : "trusted";
  const sanitized = flags.untrusted
    ? sanitizeUntrustedConfig(loaded.config)
    : { config: loaded.config, dropped: [] as string[] };
  // The loader already printed the rename notice itself; the rest of the
  // warnings (removed keys, unknown keys) are this command's to surface.
  const droppedNote = describeDroppedConfigFields(sanitized.dropped);
  for (const warning of [
    ...loaded.warnings.filter((w) => w !== LASTGATE_RENAME_NOTICE),
    ...(droppedNote ? [droppedNote] : []),
  ]) {
    console.error(`monad checks: ${warning}`);
  }
  const scope = await resolveScope(flags, cwd);
  const results = await runChecks({
    cwd,
    files: scope.files,
    base: scope.base,
    head: scope.head,
    config: sanitized.config,
    profile: flags.full ? "full" : "fast",
    only: flags.only,
    trust,
    commits: scope.base === undefined ? [] : undefined,
  });
  const failed = results.checks.some((check) => check.status === "fail");
  return { results, code: failed ? 1 : 0 };
}

export async function cmdChecks(argv: string[]): Promise<void> {
  const flags = parseChecksFlags(argv);
  const cwd = process.cwd();
  const outcome = await runChecksCommand(flags, cwd);
  if (flags.json) {
    console.log(JSON.stringify(outcome.results, null, 2));
  } else {
    console.log(formatChecksMarkdown(outcome.results));
  }
  process.exit(outcome.code);
}
