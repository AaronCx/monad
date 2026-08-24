import { z } from "zod";
import type { PipelineConfig } from "../types";

const severitySchema = z.enum(["fail", "warn"]).optional();
const findingSeveritySchema = z.enum(["critical", "high", "medium", "low"]).optional();
const profileSchema = z.enum(["fast", "full"]).optional();

// An allow glob matches "everything" when, after stripping wildcards and path
// separators, no concrete literal remains — e.g. a lone "**", a double-star
// followed by "/*", a single "*", etc. A single such entry silenced both
// secret-scanning and dangerous-file blocking for the entire diff, and was
// settable from a PR's own config file. Allow lists must name a concrete
// path or prefix.
function isUnboundedAllowGlob(glob: string): boolean {
  return glob.trim().replace(/[*?/.\\]/g, "").length === 0;
}

const allowGlobArray = z
  .array(
    z.string().refine((g) => !isUnboundedAllowGlob(g), {
      message:
        "allow glob is too broad (it matches every path); name a concrete path or prefix instead of '**'",
    }),
  )
  .optional();

const secretsCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  // Configurable entropy floor + severity tag for entropy-only findings.
  entropy_threshold: z.number().min(0).max(10).optional(),
  entropy_severity: findingSeveritySchema,
  // Per-check path allowlist (merged with the top-level `allow`).
  allow: allowGlobArray,
  // Run profile override.
  profile: profileSchema,
  custom_patterns: z.array(z.object({
    name: z.string(),
    pattern: z.string(),
    severity: z.enum(["high", "critical"]).optional(),
  })).optional(),
}).optional();

const lintCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  command: z.string().optional(),
  profile: profileSchema,
}).optional();

const typecheckCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  command: z.string().optional(),
  timeout: z.number().min(1).max(3600).default(300),
  profile: profileSchema,
}).optional();

const buildCheckSchema = z.object({
  // Off by default (matches getDefaultConfig + the policy packs). The build
  // verifier is full-profile-only, so it must not silently turn on just
  // because a user sets a sibling field like `command`.
  enabled: z.boolean().default(false),
  severity: severitySchema,
  command: z.string().optional(),
  timeout: z.number().min(1).max(3600).default(120),
  profile: profileSchema,
}).optional();

const testCheckSchema = z.object({
  enabled: z.boolean().default(false),
  severity: severitySchema,
  command: z.string().optional(),
  timeout: z.number().min(1).max(3600).default(600),
  profile: profileSchema,
}).optional();

const dependenciesCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  fail_on: z.enum(["low", "moderate", "high", "critical"]).default("critical"),
  profile: profileSchema,
}).optional();

const filePatternsCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  block: z.array(z.string()).optional(),
  allow: allowGlobArray,
  profile: profileSchema,
}).optional();

const agentPatternsCheckSchema = z.object({
  enabled: z.boolean().default(true),
  severity: severitySchema,
  profile: profileSchema,
}).optional();

const reviewSchema = z.object({
  profile: profileSchema,
  install: z.enum(["auto", "symlink", "install", "none"]).default("auto"),
  max_findings: z.number().min(1).max(500).default(25),
  prompt: z.string().optional(),
}).optional();

const pipelineConfigSchema = z.object({
  version: z.number().optional(),
  checks: z.object({
    secrets: secretsCheckSchema,
    lint: lintCheckSchema,
    typecheck: typecheckCheckSchema,
    build: buildCheckSchema,
    test: testCheckSchema,
    dependencies: dependenciesCheckSchema,
    file_patterns: filePatternsCheckSchema,
    agent_patterns: agentPatternsCheckSchema,
  }).optional(),
  // Top-level path allowlist applied to every content-scanning check.
  allow: allowGlobArray,
  // Path to the baseline file holding accepted finding fingerprints.
  baseline: z.string().optional(),
  protected_branches: z.array(z.string()).optional(),
  review: reviewSchema,
});

export function validateConfig(data: unknown): PipelineConfig {
  const parsed = pipelineConfigSchema.parse(data);
  return parsed as PipelineConfig;
}

/**
 * Check config keys LastGate had that monad removed. A config that still sets
 * them is read, but each key is ignored with a warning instead of silently
 * stripped.
 */
export const REMOVED_KEYS = ["commit_message", "duplicates", "notifications", "agent_feedback"] as const;

/**
 * The tree of keys the schema knows about, used to warn on unknown keys
 * anywhere in a config file. LastGate's Zod config silently stripped unknown
 * keys, which is exactly how a repo shipped a config with three dead keys; the
 * loader walks the raw document against this tree instead so every unknown key
 * warns by name. A value of null means "any shape below here is accepted".
 */
type KeyTree = { [key: string]: KeyTree | null };

const CHECK_COMMON: KeyTree = {
  enabled: null,
  severity: null,
  profile: null,
};

const KNOWN_KEY_TREE: KeyTree = {
  version: null,
  extends: null,
  allow: null,
  baseline: null,
  protected_branches: null,
  checks: {
    secrets: {
      ...CHECK_COMMON,
      entropy_threshold: null,
      entropy_severity: null,
      allow: null,
      custom_patterns: null,
    },
    lint: { ...CHECK_COMMON, command: null },
    typecheck: { ...CHECK_COMMON, command: null, timeout: null },
    build: { ...CHECK_COMMON, command: null, timeout: null },
    test: { ...CHECK_COMMON, command: null, timeout: null },
    dependencies: { ...CHECK_COMMON, fail_on: null },
    file_patterns: { ...CHECK_COMMON, block: null, allow: null },
    agent_patterns: { ...CHECK_COMMON },
  },
  review: {
    profile: null,
    install: null,
    max_findings: null,
    prompt: null,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walk a raw parsed config document and return a warning per key the schema
 * does not know, naming the key's full dotted path. Removed LastGate keys get
 * a dedicated ignored-with-warning message.
 */
export function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return warnings;

  const removed = new Set<string>(REMOVED_KEYS);

  const walk = (node: Record<string, unknown>, tree: KeyTree, path: string[]): void => {
    for (const key of Object.keys(node)) {
      const sub = tree[key];
      const dotted = [...path, key].join(".");
      if (sub === undefined) {
        if (removed.has(key)) {
          warnings.push(`config key "${dotted}" was removed in monad and is ignored`);
        } else {
          warnings.push(`unknown config key "${dotted}" is ignored`);
        }
        continue;
      }
      if (sub !== null && isPlainObject(node[key])) {
        walk(node[key] as Record<string, unknown>, sub, [...path, key]);
      }
    }
  };

  walk(raw, KNOWN_KEY_TREE, []);
  return warnings;
}
