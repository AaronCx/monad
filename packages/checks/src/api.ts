import { CHECK_ORDER, defaultProfileFor, runCheckPipeline } from "./pipeline";
import { commitsBetween } from "./git/diff";
import { getDefaultConfig } from "./config/defaults";
import { deepMerge } from "./config/merge";
import type {
  ChangedFile,
  CheckProfile,
  CheckRunResults,
  CheckType,
  CommitInfo,
  PipelineConfig,
} from "./types";

export interface RunChecksInput {
  /** Worktree or repo root. */
  cwd: string;
  /** From diffBetween / getStagedDiff. */
  files: ChangedFile[];
  base?: string;
  head?: string;
  config?: Partial<PipelineConfig>;
  /** Default "fast". */
  profile?: CheckProfile;
  only?: CheckType[];
  /**
   * Commits feeding the agent_patterns check. When omitted and both base and
   * head are set, they are derived via `git log base..head` in cwd; a staged
   * run passes an empty list (or nothing).
   */
  commits?: CommitInfo[];
}

export async function runChecks(input: RunChecksInput): Promise<CheckRunResults> {
  let commits = input.commits;
  if (commits === undefined) {
    commits =
      input.base && input.head
        ? await commitsBetween(input.base, input.head, input.cwd).catch(() => [])
        : [];
  }

  return runCheckPipeline(
    {
      files: input.files,
      commits,
      cwd: input.cwd,
      config: input.config,
    },
    {
      profile: input.profile ?? "fast",
      only: input.only,
    },
  );
}

export interface CheckListing {
  key: CheckType;
  enabled: boolean;
  severity: "fail" | "warn";
  profile: CheckProfile;
}

/**
 * The pipeline's entry table resolved against a config: every known check with
 * its effective enabled flag, severity, and run profile, in execution order.
 */
export function listChecks(config: Partial<PipelineConfig>): CheckListing[] {
  const merged = deepMerge(
    getDefaultConfig() as unknown as Record<string, unknown>,
    (config ?? {}) as Record<string, unknown>,
  ) as unknown as PipelineConfig;

  return CHECK_ORDER.map((key) => {
    const checkConfig = merged.checks[key];
    return {
      key: key as CheckType,
      enabled: checkConfig?.enabled ?? false,
      severity: checkConfig?.severity ?? "warn",
      profile: checkConfig?.profile ?? defaultProfileFor(key),
    };
  });
}
