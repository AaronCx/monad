import { describe, test, expect } from "bun:test";
import { checkBuild } from "../build";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpWithPackageJson(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "echo built" } }));
  return dir;
}

describe("Build Verifier", () => {
  test("passes when build command succeeds (exit 0)", async () => {
    const tmpDir = makeTmpWithPackageJson();
    try {
      const config = { enabled: true, severity: "fail", command: "echo build-ok", cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.status).toBe("pass");
      expect(result.type).toBe("build");
      expect(result.summary).toContain("passed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("fails when build command returns non-zero exit code", async () => {
    const tmpDir = makeTmpWithPackageJson();
    try {
      const config = { enabled: true, severity: "fail", command: "false", cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.status).toBe("fail");
      expect(result.summary).toContain("failed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("fails when build exceeds timeout", async () => {
    const tmpDir = makeTmpWithPackageJson();
    try {
      const config = { enabled: true, severity: "fail", command: "sleep 10", timeout: 1, cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.status).toBe("fail");
      expect(result.summary).toContain("timed out");
      expect((result.details as any).timeout).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips gracefully when no package.json and no repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "build-test-"));
    try {
      const config = { enabled: true, severity: "fail", command: "echo ok", cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.status).toBe("pass");
      expect(result.summary).toContain("skipped");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("defaults to 'bun run build' when no command specified", async () => {
    const tmpDir = makeTmpWithPackageJson();
    try {
      const config = { enabled: true, severity: "fail", cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.type).toBe("build");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("captures error output on failure", async () => {
    const tmpDir = makeTmpWithPackageJson();
    try {
      writeFileSync(join(tmpDir, "fail.sh"), '#!/bin/bash\necho "Error: Module not found" >&2\nexit 1');
      const config = { enabled: true, severity: "fail", command: "bash fail.sh", cwd: tmpDir } as any;
      const result = await checkBuild(config);
      expect(result.status).toBe("fail");
      expect((result.details as any).stderr).toContain("Module not found");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
