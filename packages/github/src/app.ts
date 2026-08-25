import { readFile } from "node:fs/promises";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type { OctokitLike } from "./octokit.ts";

/**
 * GitHub App authentication, ported from LastGate's
 * apps/web/lib/github/app.ts with its two module-level globals removed.
 *
 * LastGate kept one process-wide `cachedAppOctokit` and minted a fresh
 * installation token on every single call. monad inverts that: the app-level
 * client is cheap to rebuild and is scoped to an explicit app handle, while
 * the installation token, which costs a round trip and is rate limited, is
 * cached per installation id with its expiry.
 *
 * Nothing here logs. The private key and the installation token are the two
 * values that must never reach a log line, an error message, or an event
 * record, so they are never interpolated into a string in this file.
 */

/** GitHub installation tokens live one hour; renew with five minutes to spare. */
export const INSTALLATION_TOKEN_TTL_MS = 55 * 60 * 1000;

/** How many installations to keep tokens for. The Mini installs single digits. */
export const DEFAULT_CACHE_ENTRIES = 16;

/**
 * A PEM carried through an environment variable or a JSON field arrives with
 * its newlines escaped. LastGate unescaped it and so does monad, because
 * @octokit/auth-app fails opaquely on a one-line key. A key read from a file
 * already has real newlines and passes through unchanged.
 */
export function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

/**
 * Reads the App private key from disk. The key is a file path in
 * ~/.monad/github.json, never an environment variable holding the key body.
 */
export async function readPrivateKey(path: string): Promise<string> {
  return normalizePrivateKey(await readFile(path, "utf8"));
}

/** A minted installation token and the moment GitHub says it dies. */
export interface InstallationToken {
  token: string;
  /** ISO 8601, as GitHub returns it. */
  expiresAt: string;
}

export interface GitHubAppConfig {
  appId: string;
  /** PEM body. Read it with readPrivateKey; do not pass a path. */
  privateKey: string;
  /** LRU capacity, keyed by installation id. */
  maxCachedInstallations?: number;
  /** Test seam for the clock. */
  now?: () => number;
  /** Test seam: mint an installation token without touching the network. */
  mintInstallationToken?: (input: {
    appId: string;
    privateKey: string;
    installationId: number;
  }) => Promise<InstallationToken>;
  /** Test seam: build a client from a token. */
  createOctokit?: (auth: string) => OctokitLike;
}

export interface GitHubApp {
  /** JWT-authenticated client: app metadata and installation listing only. */
  getAppOctokit(): OctokitLike;
  /** Installation-scoped client, from the cached token when one is live. */
  getInstallationOctokit(installationId: number): Promise<OctokitLike>;
  /** The installation token itself, for callers that need to hand it on. */
  getInstallationToken(installationId: number): Promise<InstallationToken>;
  /** Drops one installation's cached token (a 401 means it was revoked). */
  forget(installationId: number): void;
  /** Installation ids currently cached, most recently used last. Never the tokens. */
  cachedInstallations(): number[];
}

interface CacheEntry {
  token: InstallationToken;
  octokit: OctokitLike;
  /** Epoch ms after which the entry is rebuilt even if GitHub says otherwise. */
  refreshAt: number;
  /** Epoch ms parsed from GitHub's expires_at, or Infinity when unparsable. */
  expiresAtMs: number;
}

async function mintWithAuthApp(input: {
  appId: string;
  privateKey: string;
  installationId: number;
}): Promise<InstallationToken> {
  const auth = createAppAuth({ appId: input.appId, privateKey: input.privateKey });
  const result = await auth({ type: "installation", installationId: input.installationId });
  return { token: result.token, expiresAt: result.expiresAt };
}

function parseExpiry(expiresAt: string): number {
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Builds an app handle. Construct one per process and pass it around; the
 * cache lives on the handle, so a test gets its own and nothing leaks
 * between them.
 */
export function createGitHubApp(config: GitHubAppConfig): GitHubApp {
  const appId = config.appId;
  const privateKey = normalizePrivateKey(config.privateKey);
  if (appId.length === 0 || privateKey.length === 0) {
    throw new Error("a GitHub App needs both an app id and a private key");
  }
  const capacity = Math.max(1, config.maxCachedInstallations ?? DEFAULT_CACHE_ENTRIES);
  const now = config.now ?? (() => Date.now());
  const mint = config.mintInstallationToken ?? mintWithAuthApp;
  const build = config.createOctokit ?? ((auth: string) => new Octokit({ auth }));

  /** Insertion order is recency order: re-set on every hit, evict the head. */
  const cache = new Map<number, CacheEntry>();

  function live(installationId: number): CacheEntry | undefined {
    const entry = cache.get(installationId);
    if (entry === undefined) {
      return undefined;
    }
    const at = now();
    if (at >= entry.refreshAt || at >= entry.expiresAtMs) {
      cache.delete(installationId);
      return undefined;
    }
    // Touch: delete and re-set moves it to the tail, which is most recent.
    cache.delete(installationId);
    cache.set(installationId, entry);
    return entry;
  }

  async function load(installationId: number): Promise<CacheEntry> {
    const cached = live(installationId);
    if (cached !== undefined) {
      return cached;
    }
    const token = await mint({ appId, privateKey, installationId });
    const entry: CacheEntry = {
      token,
      octokit: build(token.token),
      refreshAt: now() + INSTALLATION_TOKEN_TTL_MS,
      expiresAtMs: parseExpiry(token.expiresAt),
    };
    cache.set(installationId, entry);
    while (cache.size > capacity) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
    return entry;
  }

  return {
    getAppOctokit(): OctokitLike {
      // Rebuilt per call on purpose: it holds a JWT the strategy refreshes
      // itself, and holding one forever was LastGate's module-level global.
      return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    },
    async getInstallationOctokit(installationId: number): Promise<OctokitLike> {
      return (await load(installationId)).octokit;
    },
    async getInstallationToken(installationId: number): Promise<InstallationToken> {
      return (await load(installationId)).token;
    },
    forget(installationId: number): void {
      cache.delete(installationId);
    },
    cachedInstallations(): number[] {
      return [...cache.keys()];
    },
  };
}

/**
 * Compile-time proof that the real client satisfies OctokitLike, so the
 * request-layer fakes the tests use are the same contract production runs.
 * If octokit ever changes request(), typecheck fails here rather than at
 * every call site.
 */
type Assert<T extends true> = T;
export type RealOctokitIsOctokitLike = Assert<Octokit extends OctokitLike ? true : false>;
