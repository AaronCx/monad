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

/**
 * How much of a worktree monad is willing to obey (decision record 0009).
 * Structurally identical to the protocol's TrustLevel; duplicated here so
 * packages/checks keeps its zero dependency on the protocol package.
 */
export type TrustLevel = "trusted" | "untrusted";

/** Config file names, in the order the loaders probe them. */
const CONFIG_FILES = [".monad.yml", ".lastgate.yml"] as const;

/**
 * git refuses to disambiguate a ref that starts with a dash from an option,
 * and `git show <ref>:<path>` is a single argv entry, so a ref like
 * `--upload-pack=...` would be read as an option. Refs reaching here come
 * from PR metadata monad did not write; validate before they hit argv.
 */
function assertRef(ref: string): string {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/^~-]{0,254}$/.test(ref) || ref.includes("..")) {
    throw new Error(`not a usable git ref: ${ref}`);
  }
  return ref;
}

/** stderr shapes git uses for "that path is not in that commit". */
function isMissingPathError(stderr: string): boolean {
  return (
    /does not exist in/.test(stderr) ||
    /exists on disk, but not in/.test(stderr) ||
    /^fatal: path .* does not exist/m.test(stderr)
  );
}

/** Runs git and resolves with stdout, or rejects with the trimmed stderr. */
function runGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    void import("node:child_process").then(({ execFile }) => {
      execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(String(stderr).trim() || String(error)));
        } else {
          resolvePromise({ stdout });
        }
      });
    });
  });
}

/**
 * Fails loudly when a ref does not resolve. git show cannot be trusted to
 * report that on its own: for a bad ref whose path exists in the WORKING
 * TREE it says "path X exists on disk, but not in <ref>", which is
 * indistinguishable from a genuine absence. Resolving the ref first turns
 * that ambiguity into two clean cases.
 */
async function assertRefResolves(cwd: string, ref: string): Promise<void> {
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (error) {
    throw new Error(
      `cannot read config at ${ref}: the ref does not resolve in ${cwd} (${String(
        error instanceof Error ? error.message : error,
      )})`,
    );
  }
}

/**
 * `git show <ref>:<path>`, distinguishing "the commit has no such file" from
 * every other failure. A missing path returns undefined; a non-repository or
 * a broken git throws, because silently falling back to defaults there would
 * hide the fact that monad never read the rules it claimed to read.
 */
async function showAtRef(cwd: string, ref: string, path: string): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string | undefined>((resolve, reject) => {
    execFile(
      "git",
      ["show", `${ref}:${path}`],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const message = String(stderr).trim();
        if (isMissingPathError(message)) {
          resolve(undefined);
          return;
        }
        reject(new Error(`git show ${ref}:${path} failed: ${message || String(error)}`));
      },
    );
  });
}

/**
 * Load the check configuration as it exists at a git ref rather than in the
 * working tree. This is how an untrusted review reads its rules: the PR base
 * is the last state a repo maintainer approved, so a PR cannot change the
 * config that judges it (decision record 0009).
 *
 * Same probe order and same parser as loadConfig, so a config behaves
 * identically whichever way it was read.
 */
export async function loadConfigAtRef(cwd: string, ref: string): Promise<LoadedConfig> {
  assertRef(ref);
  await assertRefResolves(cwd, ref);
  for (const file of CONFIG_FILES) {
    const yaml = await showAtRef(cwd, ref, file);
    if (yaml === undefined) {
      continue;
    }
    const { config, warnings } = parseConfigWithWarnings(yaml);
    if (file === ".lastgate.yml") {
      console.error(LASTGATE_RENAME_NOTICE);
      return {
        config,
        source: ".lastgate.yml",
        warnings: [LASTGATE_RENAME_NOTICE, ...warnings],
      };
    }
    return { config, source: file, warnings };
  }
  return { config: getDefaultConfig(), source: "defaults", warnings: [] };
}

/** The config fields an untrusted worktree may never supply, dotted. */
export const UNTRUSTED_CONFIG_FIELDS = [
  "checks.lint.command",
  "checks.typecheck.command",
  "checks.build.command",
  "checks.test.command",
  "checks.secrets.custom_patterns",
  "review.prompt",
  "extends",
] as const;

/** A copy of `record` without `key`. Never mutates the input. */
function omitKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

export interface SanitizedConfig {
  config: PipelineConfig;
  /** Dotted paths actually removed, for the warning channel. */
  dropped: string[];
}

/**
 * Strips every config field that decides what monad executes or what monad's
 * own prompt says, leaving the fields that only describe what to look for.
 * Applied to any config an untrusted session got from a worktree, and to the
 * base config of an untrusted review so lint and typecheck run the DETECTED
 * toolchain rather than a supplied command line (decision record 0009).
 *
 * `checks.secrets.custom_patterns` goes too: arbitrary regexes from a PR are
 * a ReDoS lever even with the scanner's execution bound. `extends` is already
 * resolved and stripped by parseConfigWithWarnings, so dropping it here is
 * defense in depth against a future file-or-URL PackResolver.
 *
 * The input is never mutated.
 */
export function sanitizeUntrustedConfig(config: PipelineConfig): SanitizedConfig {
  const dropped: string[] = [];
  const source = config as unknown as Record<string, unknown>;

  // Rebuilt rather than mutated: the caller's object is left exactly as it
  // was, and a dropped key is genuinely absent rather than set to undefined,
  // so a later deepMerge cannot resurrect it.
  const checksIn = (source.checks ?? {}) as Record<string, unknown>;
  const checksOut: Record<string, unknown> = { ...checksIn };
  for (const key of ["lint", "typecheck", "build", "test"] as const) {
    const check = checksIn[key] as Record<string, unknown> | undefined;
    if (check?.command !== undefined) {
      checksOut[key] = omitKey(check, "command");
      dropped.push(`checks.${key}.command`);
    }
  }
  const secrets = checksIn.secrets as Record<string, unknown> | undefined;
  if (secrets?.custom_patterns !== undefined) {
    checksOut.secrets = omitKey(secrets, "custom_patterns");
    dropped.push("checks.secrets.custom_patterns");
  }

  let out: Record<string, unknown> = { ...source, checks: checksOut };
  const review = source.review as Record<string, unknown> | undefined;
  if (review?.prompt !== undefined) {
    out.review = omitKey(review, "prompt");
    dropped.push("review.prompt");
  }
  for (const key of ["extends", "packs"]) {
    if (out[key] !== undefined) {
      out = omitKey(out, key);
      dropped.push(key);
    }
  }

  return { config: out as unknown as PipelineConfig, dropped };
}

/** One line naming what an untrusted config lost, or undefined when nothing did. */
export function describeDroppedConfigFields(dropped: string[]): string | undefined {
  if (dropped.length === 0) {
    return undefined;
  }
  return `untrusted session: dropped config field(s) ${dropped.join(", ")} (decision record 0009)`;
}
