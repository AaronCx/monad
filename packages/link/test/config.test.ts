import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLinkConfig, loadLinkConfig, parseLinkConfig } from "../src/config.ts";

/**
 * link.json (decision record 0012): absent means the documented default,
 * every trusted session on this daemon; malformed means the same default and
 * a warning, never a crash.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "monad-linkcfg-"));
  dirs.push(dir);
  return join(dir, "link.json");
}

describe("loadLinkConfig", () => {
  test("an absent file is the defaults, with no warning", () => {
    const loaded = loadLinkConfig(tempPath());
    expect(loaded.config).toEqual(defaultLinkConfig());
    expect(loaded.warning).toBeUndefined();
    expect(loaded.config).toMatchObject({
      enabled: true,
      repos: null,
      limits: { messagesPerMinute: 10, maxHops: 4, maxSpawnDepth: 2, maxConcurrentSpawned: 3 },
    });
  });

  test("a full file is read, ~ expanded and limits merged over the defaults", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        repos: ["~/Developer/github/monad", "/abs/repo"],
        import: { enabled: false, watch: true, roots: ["~/logs"] },
        limits: { maxHops: 2 },
      }),
    );
    const { config, warning } = loadLinkConfig(path);
    expect(warning).toBeUndefined();
    expect(config.repos?.[0]).toEndWith("/Developer/github/monad");
    expect(config.repos?.[0]?.startsWith("~")).toBe(false);
    expect(config.repos?.[1]).toBe("/abs/repo");
    expect(config.import).toMatchObject({ enabled: false, watch: true });
    expect(config.limits).toMatchObject({ maxHops: 2, messagesPerMinute: 10 });
  });

  test("malformed JSON, a misspelled key or a bad value fall back to the defaults with a warning", () => {
    for (const text of [
      "{not json",
      JSON.stringify({ repo: ["/only/this"] }),
      JSON.stringify({ limits: { maxHops: -1 } }),
      JSON.stringify({ enabled: "yes" }),
    ]) {
      const { config, warning } = parseLinkConfig(text);
      expect(config).toEqual(defaultLinkConfig());
      expect(warning).toContain("using defaults");
    }
  });

  test("enabled false and an explicit null repo list", () => {
    expect(parseLinkConfig(JSON.stringify({ enabled: false, repos: null })).config).toMatchObject({
      enabled: false,
      repos: null,
    });
  });
});
