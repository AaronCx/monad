import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ENGINE_VERSION } from "../version";

// Read at runtime (not a static import) so tsc's rootDir=src constraint is happy.
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("engine version", () => {
  test("ENGINE_VERSION is kept in lockstep with package.json", () => {
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});
