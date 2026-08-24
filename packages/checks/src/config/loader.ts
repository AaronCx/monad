import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../types";
import { getDefaultConfig } from "./defaults";
import { parseConfigWithWarnings } from "./parser";

export type ConfigSource = ".monad.yml" | ".lastgate.yml" | "defaults";

export interface LoadedConfig {
  config: PipelineConfig;
  source: ConfigSource;
  warnings: string[];
}

export const LASTGATE_RENAME_NOTICE = "reading .lastgate.yml; rename it to .monad.yml";

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Load the repo's check configuration from `cwd`.
 *
 * Rules, in order: `.monad.yml` if present; else `.lastgate.yml` with a
 * one-line rename notice, its removed LastGate keys ignored with a warning
 * each; else defaults. Unknown keys anywhere produce a warning naming the key.
 * The rename notice is both printed to stderr and returned in `warnings` so
 * non-CLI callers surface it too.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const monadYaml = await readIfExists(join(cwd, ".monad.yml"));
  if (monadYaml !== undefined) {
    const { config, warnings } = parseConfigWithWarnings(monadYaml);
    return { config, source: ".monad.yml", warnings };
  }

  const lastgateYaml = await readIfExists(join(cwd, ".lastgate.yml"));
  if (lastgateYaml !== undefined) {
    console.error(LASTGATE_RENAME_NOTICE);
    const { config, warnings } = parseConfigWithWarnings(lastgateYaml);
    return {
      config,
      source: ".lastgate.yml",
      warnings: [LASTGATE_RENAME_NOTICE, ...warnings],
    };
  }

  return { config: getDefaultConfig(), source: "defaults", warnings: [] };
}
