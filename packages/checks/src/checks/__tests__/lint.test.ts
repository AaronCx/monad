import { describe, test, expect } from "bun:test";
import { checkLint, detectLinter } from "../lint";
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

  // Trusted, because an untrusted run only invokes a linter it can resolve
  // from PATH (decision record 0009), so on a machine without biome installed
  // the untrusted answer is a skip rather than an attempt.
  test("auto-detects biome.json", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, "biome.json"), '{}');
      const config = { ...defaultConfig, cwd: tmpDir, trust: "trusted" } as any;
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

  // Trust is explicit here because checkLint now defaults to "untrusted"
  // (decision record 0009), and eslint is the one detected linter that loads
  // code from the tree it is linting.
  test("auto-detects .eslintrc.json when trusted", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, ".eslintrc.json"), '{}');
      const config = { ...defaultConfig, cwd: tmpDir, trust: "trusted" } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.type).toBe("lint");
      expect((result.details as any).skipped).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not run eslint on an untrusted tree", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      // A flat config IS executable JavaScript, and every eslint config
      // format resolves its parser and plugins out of the linted tree.
      writeFileSync(join(tmpDir, "eslint.config.js"), "export default [];\n");
      const config = { ...defaultConfig, cwd: tmpDir, trust: "untrusted" } as any;
      const files = [file("src/index.ts", "const x = 1;")];
      const result = await checkLint(files, config);
      expect(result.status).toBe("pass");
      expect((result.details as any).skipped).toBe(true);
      expect(detectLinter(tmpDir, "untrusted")).toBeNull();
      expect(detectLinter(tmpDir, "trusted")?.kind).toBe("eslint");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("untrusted still detects the linters whose config cannot carry code", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, "biome.json"), "{}");
      expect(detectLinter(tmpDir, "untrusted")?.kind).toBe("biome");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("auto-detects pyproject.toml (ruff)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
    try {
      writeFileSync(join(tmpDir, "pyproject.toml"), '[tool.ruff]\nline-length = 88');
      const config = { ...defaultConfig, cwd: tmpDir, trust: "trusted" } as any;
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
