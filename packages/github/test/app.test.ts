import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitHubApp,
  INSTALLATION_TOKEN_TTL_MS,
  normalizePrivateKey,
  readPrivateKey,
} from "../src/app.ts";
import type { InstallationToken } from "../src/app.ts";
import type { OctokitLike } from "../src/octokit.ts";

/**
 * The installation token cache, with the clock and the minting call as test
 * seams so nothing here touches GitHub. What is asserted is how often a
 * token is minted, never the token value, which is the same rule the code
 * follows.
 */

const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";

interface Harness {
  app: ReturnType<typeof createGitHubApp>;
  mints: number[];
  advance: (ms: number) => void;
}

function harness(options: { ttlSeconds?: number; capacity?: number } = {}): Harness {
  const mints: number[] = [];
  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  const ttl = (options.ttlSeconds ?? 3600) * 1000;
  const app = createGitHubApp({
    appId: "1234",
    privateKey: PRIVATE_KEY,
    maxCachedInstallations: options.capacity,
    now: () => clock,
    mintInstallationToken: async ({ installationId }): Promise<InstallationToken> => {
      mints.push(installationId);
      return {
        token: `ghs_${installationId}_${mints.length}`,
        expiresAt: new Date(clock + ttl).toISOString(),
      };
    },
    createOctokit: (auth: string): OctokitLike => ({
      request: async () => ({ status: 200, data: { auth } }),
    }),
  });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { app, mints, advance };
}

describe("normalizePrivateKey", () => {
  test("unescapes the newlines an env var or a JSON field escapes", () => {
    expect(normalizePrivateKey("-----BEGIN-----\\nbody\\n-----END-----")).toBe(
      "-----BEGIN-----\nbody\n-----END-----",
    );
  });

  test("a key with real newlines passes through unchanged", () => {
    expect(normalizePrivateKey(PRIVATE_KEY)).toBe(PRIVATE_KEY);
  });

  test("readPrivateKey reads the file the config points at", async () => {
    // Written here rather than committed as a .pem fixture: monad's own
    // secrets check scans this repo, and a committed key header is exactly
    // what it should flag. Test files are already allowlisted in .monad.yml.
    const dir = mkdtempSync(join(tmpdir(), "monad-app-key-"));
    const path = join(dir, "app.private-key.pem");
    try {
      writeFileSync(path, `${PRIVATE_KEY}\n`);
      expect(await readPrivateKey(path)).toBe(`${PRIVATE_KEY}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installation token cache", () => {
  test("a second call inside the refresh window reuses the token", async () => {
    const { app, mints, advance } = harness();
    const first = await app.getInstallationToken(42);
    advance(INSTALLATION_TOKEN_TTL_MS - 1000);
    const second = await app.getInstallationToken(42);
    expect(second.token).toBe(first.token);
    expect(mints).toEqual([42]);
  });

  test("the token is re-minted at 55 minutes, not at 60", async () => {
    const { app, mints, advance } = harness();
    const first = await app.getInstallationToken(42);
    advance(INSTALLATION_TOKEN_TTL_MS);
    const second = await app.getInstallationToken(42);
    expect(second.token).not.toBe(first.token);
    expect(mints).toEqual([42, 42]);
  });

  test("an expires_at earlier than the refresh window wins", async () => {
    const { app, mints, advance } = harness({ ttlSeconds: 60 });
    await app.getInstallationToken(42);
    advance(61_000);
    await app.getInstallationToken(42);
    expect(mints).toEqual([42, 42]);
  });

  test("getInstallationOctokit hands back the client built for that token", async () => {
    const { app, mints } = harness();
    const client = await app.getInstallationOctokit(7);
    const response = await client.request("GET /rate_limit");
    expect(response.data.auth).toBe("ghs_7_1");
    expect(await app.getInstallationOctokit(7)).toBe(client);
    expect(mints).toEqual([7]);
  });

  test("each installation gets its own token", async () => {
    const { app, mints } = harness();
    const a = await app.getInstallationToken(1);
    const b = await app.getInstallationToken(2);
    expect(a.token).not.toBe(b.token);
    expect(mints).toEqual([1, 2]);
  });

  test("the LRU evicts the least recently used installation", async () => {
    const { app, mints } = harness({ capacity: 2 });
    await app.getInstallationToken(1);
    await app.getInstallationToken(2);
    // Touching 1 makes 2 the eviction candidate.
    await app.getInstallationToken(1);
    await app.getInstallationToken(3);
    expect(app.cachedInstallations()).toEqual([1, 3]);
    await app.getInstallationToken(2);
    expect(mints).toEqual([1, 2, 3, 2]);
  });

  test("forget drops one installation, for a revoked token", async () => {
    const { app, mints } = harness();
    await app.getInstallationToken(9);
    app.forget(9);
    expect(app.cachedInstallations()).toEqual([]);
    await app.getInstallationToken(9);
    expect(mints).toEqual([9, 9]);
  });

  test("cachedInstallations reports ids and nothing else", async () => {
    const { app } = harness();
    await app.getInstallationToken(11);
    expect(app.cachedInstallations()).toEqual([11]);
    expect(JSON.stringify(app.cachedInstallations())).not.toContain("ghs_");
  });

  test("an app with no credentials is refused at construction", () => {
    expect(() => createGitHubApp({ appId: "", privateKey: PRIVATE_KEY })).toThrow(
      "a GitHub App needs both an app id and a private key",
    );
    expect(() => createGitHubApp({ appId: "1", privateKey: "" })).toThrow(
      "a GitHub App needs both an app id and a private key",
    );
  });
});
