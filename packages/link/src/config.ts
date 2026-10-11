import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, monadStateDir } from "@aaroncx/engine";
import { z } from "zod";

/**
 * ~/.monad/link.json: how far monad Link reaches (decision record 0012).
 *
 * The default is every trusted session on this daemon. monad is a single-user
 * daemon on loopback, and seamless is the point, so a missing file means "on,
 * everywhere". The file narrows that: `enabled: false` takes the
 * monad-sessions mount away from every session, and `repos` limits it (and
 * what Link returns to a session) to the listed repositories.
 *
 * A malformed file is NOT a crash and NOT a silent widening either: the
 * defaults apply and the daemon logs a warning naming the problem. The
 * defaults are the documented behavior with no file at all, so a typo can
 * never grant more than deleting the file would.
 */

export interface LinkLimits {
  /** Peer messages one session may send per minute (token bucket refill). */
  messagesPerMinute: number;
  /** Burst size of that bucket. */
  messageBurst: number;
  /** A message past this many session-to-session hops is dropped. */
  maxHops: number;
  /** Deepest spawn chain: a root session is depth 0, its child 1. */
  maxSpawnDepth: number;
  /** Spawned sessions running or waiting on a permission at once. */
  maxConcurrentSpawned: number;
}

export interface LinkConfig {
  enabled: boolean;
  /**
   * Repository roots Link is scoped to, `~` expanded. null means every
   * repository (the default).
   */
  repos: string[] | null;
  /** Phase 4 importer switches; read now so the file shape is stable. */
  import: { enabled: boolean; watch: boolean; roots: string[] };
  limits: LinkLimits;
}

export const DEFAULT_LINK_LIMITS: LinkLimits = {
  messagesPerMinute: 10,
  messageBurst: 5,
  maxHops: 4,
  maxSpawnDepth: 2,
  maxConcurrentSpawned: 3,
};

export function defaultLinkConfig(): LinkConfig {
  return {
    enabled: true,
    repos: null,
    import: { enabled: true, watch: false, roots: [] },
    limits: { ...DEFAULT_LINK_LIMITS },
  };
}

const positiveInt = z.number().int().positive();

const LinkConfigFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  repos: z.array(z.string().min(1)).nullable().optional(),
  import: z
    .strictObject({
      enabled: z.boolean().optional(),
      watch: z.boolean().optional(),
      roots: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      messagesPerMinute: positiveInt.optional(),
      messageBurst: positiveInt.optional(),
      maxHops: positiveInt.optional(),
      maxSpawnDepth: z.number().int().nonnegative().optional(),
      maxConcurrentSpawned: positiveInt.optional(),
    })
    .optional(),
});

export interface LoadedLinkConfig {
  config: LinkConfig;
  /** Present when the file was unreadable or malformed and defaults apply. */
  warning?: string;
  /** Where the config was read from, or would have been. */
  path: string;
}

export function defaultLinkConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(monadStateDir(env), "link.json");
}

/**
 * Parses link.json text. Exported for tests; loadLinkConfig is the entry
 * point. Unknown keys are refused rather than ignored, because an ignored
 * misspelling of `repos` would silently widen the scope.
 */
export function parseLinkConfig(text: string, home?: string): { config: LinkConfig; warning?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: defaultLinkConfig(),
      warning: `link.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); using defaults`,
    };
  }
  const parsed = LinkConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return {
      config: defaultLinkConfig(),
      warning: `link.json is invalid at ${where}: ${issue?.message ?? "unknown problem"}; using defaults`,
    };
  }
  const file = parsed.data;
  const defaults = defaultLinkConfig();
  return {
    config: {
      enabled: file.enabled ?? defaults.enabled,
      repos:
        file.repos === undefined || file.repos === null
          ? null
          : file.repos.map((repo) => expandHome(repo, home)),
      import: {
        enabled: file.import?.enabled ?? defaults.import.enabled,
        watch: file.import?.watch ?? defaults.import.watch,
        roots: (file.import?.roots ?? []).map((root) => expandHome(root, home)),
      },
      limits: { ...defaults.limits, ...file.limits },
    },
  };
}

/** Reads link.json. An absent file is the defaults with no warning. */
export function loadLinkConfig(path: string = defaultLinkConfigPath()): LoadedLinkConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: defaultLinkConfig(), path };
    }
    return {
      config: defaultLinkConfig(),
      path,
      warning: `link.json could not be read (${error instanceof Error ? error.message : String(error)}); using defaults`,
    };
  }
  return { ...parseLinkConfig(text), path };
}
