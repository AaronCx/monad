import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonInfoPath, daemonPidPath, monadStateDir } from "../src/paths.ts";

describe("monadStateDir", () => {
  test("defaults to ~/.monad", () => {
    expect(monadStateDir({})).toBe(join(homedir(), ".monad"));
  });

  test("MONAD_HOME overrides the state dir and everything under it", () => {
    const env = { MONAD_HOME: "/tmp/monad-test-home" };
    expect(monadStateDir(env)).toBe("/tmp/monad-test-home");
    expect(daemonInfoPath(env)).toBe("/tmp/monad-test-home/monadd.json");
    expect(daemonPidPath(env)).toBe("/tmp/monad-test-home/monadd.pid");
  });

  test("a blank MONAD_HOME falls back to the default", () => {
    expect(monadStateDir({ MONAD_HOME: "  " })).toBe(join(homedir(), ".monad"));
  });
});
