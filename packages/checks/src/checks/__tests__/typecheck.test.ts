import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkTypecheck } from "../typecheck";

const defaultConfig = { enabled: true, severity: "fail" as const, timeout: 60 };

/**
 * The typechecker is DETECTED by reading package.json, so dropping
 * `checks.typecheck.command` from an untrusted config does not stop the PR
 * from choosing what runs: `bun run typecheck` runs whatever the PR wrote in
 * `scripts.typecheck` (decision record 0009).
 */
describe("Type Check trust boundary", () => {
  function repoWithTypecheckScript(): { dir: string; canary: string } {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-trust-"));
    const canary = join(dir, "CANARY");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { typecheck: `touch ${canary}` } }),
    );
    return { dir, canary };
  }

  test("untrusted does not run the PR's package.json typecheck script", async () => {
    const { dir, canary } = repoWithTypecheckScript();
    try {
      const result = await checkTypecheck({ ...defaultConfig, cwd: dir, trust: "untrusted" } as never);
      expect(result.status).toBe("pass");
      expect((result.details as { skipped?: boolean }).skipped).toBe(true);
      expect(String((result.details as { reason?: string }).reason)).toContain(
        "untrusted PR: the package.json typecheck script is not run",
      );
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent trust level is the untrusted one: default deny", async () => {
    const { dir, canary } = repoWithTypecheckScript();
    try {
      const result = await checkTypecheck({ ...defaultConfig, cwd: dir } as never);
      expect((result.details as { skipped?: boolean }).skipped).toBe(true);
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted still runs it, which is the M2 behavior", async () => {
    const { dir, canary } = repoWithTypecheckScript();
    try {
      const result = await checkTypecheck({ ...defaultConfig, cwd: dir, trust: "trusted" } as never);
      expect((result.details as { command?: string }).command).toBe("bun run typecheck");
      expect(existsSync(canary)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit config command is a trusted-only field and still wins", async () => {
    const { dir, canary } = repoWithTypecheckScript();
    try {
      const result = await checkTypecheck({
        ...defaultConfig,
        cwd: dir,
        trust: "trusted",
        command: "true",
      } as never);
      expect((result.details as { command?: string }).command).toBe("true");
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
