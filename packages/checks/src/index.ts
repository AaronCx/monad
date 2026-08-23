// Public API
export { runChecks, listChecks } from "./api";
export type { RunChecksInput, CheckListing } from "./api";
export { loadConfig, LASTGATE_RENAME_NOTICE } from "./config/loader";
export type { LoadedConfig, ConfigSource } from "./config/loader";

// Pipeline internals (steppers, meta)
export {
  runCheckPipeline,
  runChecksIterable,
  runSingleCheck,
  resolveMeta,
  formatMetaFooter,
  defaultProfileFor,
  CHECK_ORDER,
} from "./pipeline";
export type { PipelineInput, PipelineOptions } from "./pipeline";
export { ENGINE_VERSION } from "./version";

// Config
export { parseConfig, parseConfigWithWarnings } from "./config/parser";
export type { ParsedConfig } from "./config/parser";
export { getDefaultConfig } from "./config/defaults";
export { resolveExtends } from "./config/extends";
export { collectUnknownKeyWarnings, REMOVED_KEYS, validateConfig } from "./config/schema";
export {
  parsePackRef,
  resolveBuiltinPack,
  BUILTIN_PACK_NAMES,
} from "./config/packs";
export type { PolicyPack, PackRef, PackResolver } from "./config/packs";
export {
  isPathAllowed,
  isLineIgnored,
  fingerprint,
  loadBaseline,
  writeBaseline,
  DEFAULT_BASELINE_PATH,
  LEGACY_BASELINE_PATH,
} from "./config/allowlist";

// Diff + git helpers
export { parseAddedLines } from "./diff/parse";
export {
  diffBetween,
  getBranchDiff,
  getStagedDiff,
  splitPatchByFile,
  commitsBetween,
} from "./git/diff";

// Checks
export { statusFromFindings } from "./checks/status";
export { detectLinter } from "./checks/lint";
export { parseTscOutput } from "./checks/typecheck";
export { parseTestCounts } from "./checks/test";

// Types
export type {
  CheckResult,
  CheckRunResults,
  CheckRunMeta,
  PipelineConfig,
  ReviewConfig,
  ChangedFile,
  CommitInfo,
  CheckStatus,
  CheckType,
  CheckProfile,
  CheckContext,
  Annotation,
  AddedLine,
  Finding,
  FindingSeverity,
} from "./types";
