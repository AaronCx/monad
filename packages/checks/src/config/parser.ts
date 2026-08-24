import YAML from "yaml";
import type { PipelineConfig } from "../types";
import { getDefaultConfig } from "./defaults";
import { collectUnknownKeyWarnings, validateConfig } from "./schema";
import { deepMerge } from "./merge";
import { resolveExtends } from "./extends";

export interface ParsedConfig {
  config: PipelineConfig;
  /** One entry per unknown or removed key found anywhere in the file. */
  warnings: string[];
}

/**
 * Parse a YAML config document into a validated PipelineConfig plus warnings.
 * Unknown keys anywhere in the document warn by name instead of being silently
 * stripped (LastGate's behavior, which let dead keys ship unnoticed).
 */
export function parseConfigWithWarnings(yaml: string): ParsedConfig {
  const raw = YAML.parse(yaml);

  if (!raw || typeof raw !== "object") {
    return { config: getDefaultConfig(), warnings: [] };
  }

  const rawObj = raw as Record<string, unknown>;
  const warnings = collectUnknownKeyWarnings(rawObj);

  // 1. Resolve any `extends:` packs into a single merged base config. Built-in
  //    packs resolve offline; circular / unknown packs throw with a clear
  //    message. The `extends` key itself is not part of the schema, so strip it
  //    before validating the local layer below.
  const packBase = resolveExtends(rawObj);
  const { extends: _extends, ...localRaw } = rawObj;

  // 2. Validate the local file on its own so per-field errors point at the
  //    user's YAML, not the merged blob. We DISCARD the parsed result for the
  //    merge: validateConfig applies every Zod .default(), and merging that
  //    defaults-filled object over the packs would clobber pack values the user
  //    never touched (e.g. re-enabling a check the pack disabled the moment the
  //    user tweaks a sibling field). Defaults are applied exactly once, on the
  //    final merged result in step 4.
  validateConfig(localRaw);

  // 3. Layer in merge order: defaults (bottom) -> packs -> local file (top).
  //    Merge the RAW local keys so only what the user actually wrote overrides
  //    the packs. Removed/unknown keys were reported above; step 4's schema
  //    parse strips them from the final result.
  const defaults = getDefaultConfig() as unknown as Record<string, unknown>;
  const withPacks = deepMerge(defaults, packBase);
  const merged = deepMerge(withPacks, localRaw);

  // 4. Validate the fully merged result so a pack can never produce an invalid
  //    PipelineConfig (e.g. an out-of-range entropy threshold).
  return { config: validateConfig(merged), warnings };
}

export function parseConfig(yaml: string): PipelineConfig {
  return parseConfigWithWarnings(yaml).config;
}
