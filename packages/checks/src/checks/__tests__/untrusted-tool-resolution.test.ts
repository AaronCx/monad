import { describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkLint, detectLinter } from "../lint";
import { checkTypecheck } from "../typecheck";
import { resolveTool } from "../../exec";
import type { ChangedFile } from "../../types";

/**
 * Decision record 0009: the worktree may not decide what monad executes.
 * `bunx <name>` did, quietly, because bun prefers `node_modules/.bin/<name>`
 * inside the directory it runs in and a PR can commit that file. These
 * fixtures are the reproduction that was measured on 2026-08-24, shrunk to a
 * directory: a committed executable plus the config file that makes the
 * detector choose it.
 */

const lintConfig = { enabled: true, severity: "fail" as const };

function changed(path: string): ChangedFile {
  return { path, content: "const x = 1;\n", status: "added" };
}

/** A tree that ships its own `node_modules/.bin/<tool>`, as a PR can. */
function treeWithCommittedBinary(tool: string, files: Record<string, string>): { dir: string; canary: string } {
  const dir = mkdtempSync(join(tmpdir(), "untrusted-tool-"));
  const canary = join(dir, "CANARY");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const bin = join(dir, "node_modules", ".bin", tool);
  writeFileSync(bin, `#!/bin/sh\ntouch ${canary}\nexit 0\n`);
  chmodSync(bin, 0o755);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, canary };
}

describe("resolveTool", () => {
  test("untrusted refuses a binary that exists only in the worktree", () => {
    const { dir } = treeWithCommittedBinary("monad-fake-tool-xyz", {});
    try {
      const resolved = resolveTool("monad-fake-tool-xyz", { trust: "untrusted", cwd: dir });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.reason).toContain("not on PATH");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("untrusted returns an absolute path from PATH", () => {
    const { dir } = treeWithCommittedBinary("monad-fake-tool-xyz", {});
    try {
      const resolved = resolveTool("git", { trust: "untrusted", cwd: dir });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.argv).toHaveLength(1);
        expect(resolved.argv[0]?.startsWith("/")).toBe(true);
        expect(resolved.argv[0]?.startsWith(dir)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted keeps the bunx invocation, which is the repo's pinned toolchain", () => {
    const resolved = resolveTool("biome", { trust: "trusted", cwd: "/", viaBunx: true });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.argv).toEqual(["bunx", "biome"]);
  });

  test("trusted keeps the bare name for tools monad never sent through bunx", () => {
    const resolved = resolveTool("ruff", { trust: "trusted", cwd: "/" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.argv).toEqual(["ruff"]);
  });
});

describe("untrusted lint never runs a binary the PR committed", () => {
  test("a committed node_modules/.bin/biome is not executed", async () => {
    const { dir, canary } = treeWithCommittedBinary("biome", {
      "package.json": '{"name":"victim"}',
      "biome.json": "{}",
    });
    try {
      const result = await checkLint([changed("src/evil.ts")], {
        ...lintConfig,
        cwd: dir,
        trust: "untrusted",
      } as never);

      expect(existsSync(canary)).toBe(false);
      // Detection still names biome; resolution is what declined.
      expect(detectLinter(dir, "untrusted")?.kind).toBe("biome");
      const details = result.details as { skipped?: boolean; reason?: string; command?: string };
      if (details.skipped) {
        expect(String(details.reason)).toContain("untrusted PR");
      } else {
        // A machine with biome on PATH runs that one, never the worktree's.
        expect(String(details.command).startsWith(dir)).toBe(false);
        expect(String(details.command).startsWith("bunx")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The control that makes the assertion above mean something: the fixture is
  // genuinely loaded, and a trusted run still reaches the repo's own copy.
  test("the same fixture is executed on a trusted run, which is deliberate", async () => {
    const { dir, canary } = treeWithCommittedBinary("biome", {
      "package.json": '{"name":"victim"}',
      "biome.json": "{}",
    });
    try {
      await checkLint([changed("src/evil.ts")], {
        ...lintConfig,
        cwd: dir,
        trust: "trusted",
      } as never);
      expect(existsSync(canary)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("untrusted typecheck never runs a binary the PR committed", () => {
  test("a committed node_modules/.bin/tsc is not executed", async () => {
    const { dir, canary } = treeWithCommittedBinary("tsc", {
      "package.json": '{"name":"victim"}',
      "tsconfig.json": "{}",
    });
    try {
      const result = await checkTypecheck({
        enabled: true,
        severity: "fail",
        timeout: 60,
        cwd: dir,
        trust: "untrusted",
      } as never);

      expect(existsSync(canary)).toBe(false);
      const details = result.details as { skipped?: boolean; reason?: string; command?: string };
      if (details.skipped) {
        expect(String(details.reason)).toContain("untrusted PR");
      } else {
        expect(String(details.command).startsWith(dir)).toBe(false);
        expect(String(details.command).startsWith("bunx")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
