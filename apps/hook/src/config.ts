import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { monadStateDir } from "@aaroncx/engine";
import { z } from "zod";

/**
 * monad-hook's configuration: ~/.monad/github.json, plus environment
 * overrides for supervisors that inject secrets.
 *
 * Two rules shape this file, and both are about the private key.
 *
 * The key is read from a FILE, never from an environment variable holding
 * the key body, so a `privateKey` field is refused rather than quietly
 * honored. An environment variable holding a PEM ends up in the process
 * table of everything that inherits it, in supervisor logs, and in crash
 * reports; a path does not.
 *
 * Nothing here is ever logged. The webhook secret and the key path go
 * straight into the App handle, and no function in this file formats a
 * config into a string. What monad-hook prints about its configuration is
 * the app id and the repositories it is bound to.
 */

/** Environment overrides. Set means "use this", and it wins over the file. */
export const APP_ID_ENV = "MONAD_GITHUB_APP_ID";
export const PRIVATE_KEY_PATH_ENV = "MONAD_GITHUB_PRIVATE_KEY_PATH";
export const WEBHOOK_SECRET_ENV = "MONAD_WEBHOOK_SECRET";

/** The file name under $MONAD_HOME. */
export const CONFIG_FILE = "github.json";

export type Env = Record<string, string | undefined>;

/** Default config path: $MONAD_HOME/github.json (that is ~/.monad/github.json). */
export function hookConfigPath(env: Env = process.env): string {
  return join(monadStateDir(env), CONFIG_FILE);
}

/** One repository the App may review, and where it lives on this machine. */
export interface RepoBinding {
  /**
   * The local checkout review worktrees are created from. It must be a git
   * repository whose origin is the repository the delivery names: the
   * playbook fetches refs/pull/<n>/head from origin into it.
   */
  repoRoot: string;
}

export interface HookConfig {
  appId: string;
  /** Absolute path of the App private key PEM. */
  privateKeyPath: string;
  webhookSecret: string;
  /** owner/name to the local checkout. A repo with no entry is not reviewed. */
  installations: Record<string, RepoBinding>;
  /** Where the values came from, for error messages. Carries no secret. */
  source: string;
}

const RepoBindingSchema = z.object({
  repoRoot: z.string().min(1),
});

const HookConfigFileSchema = z.object({
  appId: z.union([z.string(), z.number()]).optional(),
  privateKeyPath: z.string().optional(),
  webhookSecret: z.string().optional(),
  installations: z.record(z.string(), RepoBindingSchema).default({}),
});

/** A leading ~ is expanded; everything else is left exactly as written. */
export function expandHome(path: string, env: Env = process.env): string {
  if (path === "~") {
    return home(env);
  }
  if (path.startsWith("~/")) {
    return join(home(env), path.slice(2));
  }
  return path;
}

function home(env: Env): string {
  const override = env.HOME?.trim();
  return override && override.length > 0 ? override : homedir();
}

/**
 * Refuses a config file any other user on this machine can read. It holds
 * the webhook secret, which is the only thing standing between the internet
 * and a review run, so a permissive mode is a stop rather than a warning.
 */
export function assertPrivateMode(path: string): void {
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is mode ${mode.toString(8).padStart(4, "0")} and holds the webhook secret; ` +
        `run chmod 600 ${path}`,
    );
  }
}

function readConfigFile(path: string): z.infer<typeof HookConfigFileSchema> {
  assertPrivateMode(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw !== null && typeof raw === "object" && "privateKey" in raw) {
    throw new Error(
      `${path} carries a privateKey field. monad reads the App key from a file: set ` +
        `privateKeyPath instead and keep the PEM out of ${CONFIG_FILE}`,
    );
  }
  const parsed = HookConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} does not match monad's github.json shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

export interface LoadHookConfigOptions {
  /** Overrides the config path (--config, tests). */
  path?: string;
  env?: Env;
}

/**
 * Reads the App configuration. The file is optional when all three values
 * arrive through the environment; anything less than a complete set is an
 * error naming what is missing, never a partially configured App.
 */
export function loadHookConfig(options: LoadHookConfigOptions = {}): HookConfig {
  const env = options.env ?? process.env;
  const path = options.path ? expandHome(options.path, env) : hookConfigPath(env);
  let file: z.infer<typeof HookConfigFileSchema> = { installations: {} };
  let source = "the environment";
  if (fileExists(path)) {
    file = readConfigFile(path);
    source = path;
  }

  const appId = (env[APP_ID_ENV] ?? (file.appId === undefined ? "" : String(file.appId))).trim();
  const privateKeyPath = (env[PRIVATE_KEY_PATH_ENV] ?? file.privateKeyPath ?? "").trim();
  const webhookSecret = env[WEBHOOK_SECRET_ENV] ?? file.webhookSecret ?? "";

  const missing: string[] = [];
  if (appId.length === 0) {
    missing.push(`appId (or ${APP_ID_ENV})`);
  }
  if (privateKeyPath.length === 0) {
    missing.push(`privateKeyPath (or ${PRIVATE_KEY_PATH_ENV})`);
  }
  if (webhookSecret.length === 0) {
    missing.push(`webhookSecret (or ${WEBHOOK_SECRET_ENV})`);
  }
  if (missing.length > 0) {
    throw new Error(`${path} is incomplete; monad-hook needs ${missing.join(", ")}`);
  }

  const installations: Record<string, RepoBinding> = {};
  for (const [repo, binding] of Object.entries(file.installations)) {
    installations[repo] = { repoRoot: expandHome(binding.repoRoot, env) };
  }

  return {
    appId,
    privateKeyPath: absolute(expandHome(privateKeyPath, env), env),
    webhookSecret,
    installations,
    source,
  };
}

function absolute(path: string, env: Env): string {
  return isAbsolute(path) ? path : join(monadStateDir(env), path);
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The local checkout for a repository, or undefined when it has no binding. */
export function repoRootFor(config: HookConfig, fullName: string): string | undefined {
  return config.installations[fullName]?.repoRoot;
}
