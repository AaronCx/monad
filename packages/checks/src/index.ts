// Public API
export { runChecks, listChecks } from "./api";
export type { RunChecksInput, CheckListing } from "./api";
export {
  loadConfig,
  loadConfigAtRef,
  sanitizeUntrustedConfig,
  describeDroppedConfigFields,
  UNTRUSTED_CONFIG_FIELDS,
  LASTGATE_RENAME_NOTICE,
} from "./config/loader";
export type { LoadedConfig, ConfigSource, SanitizedConfig, TrustLevel } from "./config/loader";

// Pipeline internals (steppers, meta)
export {
  runCheckPipeline,
  runChecksIterable,
  runSingleCheck,
  resolveMeta,
  formatMetaFooter,
  defaultProfileFor,
  CHECK_ORDER,
  UNTRUSTED_SKIP_REASON,
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
  detectDefaultBranch,
} from "./git/diff";

// Session-bound MCP surface and shared rendering
export { createChecksMcpServer } from "./mcp";
export type { ChecksMcpBinding, ChecksMcpServer } from "./mcp";
export {
  formatChecksTable,
  formatChecksMarkdown,
  describeFinding,
  findingLocation,
  findingMessage,
  findingRule,
} from "./render";

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
