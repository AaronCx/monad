import { describe, test, expect } from "bun:test";
import { checkLint } from "../lint";
import type { ChangedFile, LintCheckConfig } from "../../types";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const defaultConfig: LintCheckConfig = {
  enabled: true,
  severity: "fail",
};

function file(path: string, content: string): ChangedFile {
  return { path, content, status: "added" };
}

describe("Lint & Type Checker", () => {
  test("passes when no linter config detected (skip gracefully)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      const config = { ...defaultConfig, cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.status).toBe("pass");
      expect(result.summary).toContain("No linter configuration detected");
      expect((result.details as any).skipped).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses custom command override when provided", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      // Use a command that exits 0
      const config = { ...defaultConfig, command: "echo ok", cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.status).toBe("pass");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("fails when custom command returns non-zero exit code", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      const config = { ...defaultConfig, command: "false", cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.status).toBe("fail");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("auto-detects biome.json", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, "biome.json"), '{}');
      const config = { ...defaultConfig, cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      // It will try to run biome, which may or may not be installed.
      // The key thing is it didn't skip — it attempted to run biome.
      expect(result.type).toBe("lint");
      expect((result.details as any).skipped).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("auto-detects .eslintrc.json", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, ".eslintrc.json"), '{}');
      const config = { ...defaultConfig, cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.type).toBe("lint");
      expect((result.details as any).skipped).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("auto-detects pyproject.toml (ruff)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, "pyproject.toml"), '[tool.ruff]\nline-length = 88');
      const config = { ...defaultConfig, cwd: tmpDir } as any;
      const files = [file("src/main.py", "import os")];
      const result = await checkLint(files, config);
      expect(result.type).toBe("lint");
      expect((result.details as any).skipped).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles non-existent command gracefully", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      const config = { ...defaultConfig, command: "nonexistent_linter_binary", cwd: tmpDir } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.status).toBe("fail");
      expect(result.type).toBe("lint");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
