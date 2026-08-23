import { describe, test, expect } from "bun:test";
import { checkFilePatterns } from "../file-patterns";
import type { ChangedFile, FilePatternCheckConfig } from "../../types";

const defaultConfig: FilePatternCheckConfig = {
  enabled: true,
  severity: "fail",
};

function file(path: string, status: "added" | "modified" = "added"): ChangedFile {
  return { path, content: "content", status };
}

describe("File Pattern Guard", () => {
  // === Should FAIL ===

  test("blocks .env file", async () => {
    const result = await checkFilePatterns([file(".env")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks .env.production", async () => {
    const result = await checkFilePatterns([file(".env.production")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks node_modules file", async () => {
    const result = await checkFilePatterns([file("node_modules/some-package/index.js")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks .claude/settings.json", async () => {
    const result = await checkFilePatterns([file(".claude/settings.json")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks __pycache__ file", async () => {
    const result = await checkFilePatterns([file("__pycache__/module.cpython-311.pyc")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks .DS_Store", async () => {
    const result = await checkFilePatterns([file(".DS_Store")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks dist/bundle.js", async () => {
    const result = await checkFilePatterns([file("dist/bundle.js")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks build/output.css", async () => {
    const result = await checkFilePatterns([file("build/output.css")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks .next/cache/something", async () => {
    const result = await checkFilePatterns([file(".next/cache/something")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks *.log files", async () => {
    const result = await checkFilePatterns([file("npm-debug.log")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  test("blocks error.log", async () => {
    const result = await checkFilePatterns([file("error.log")], defaultConfig);
    expect(result.status).toBe("fail");
  });

  // === Should PASS ===

  test("allows .env.example (default exception)", async () => {
    const result = await checkFilePatterns([file(".env.example")], defaultConfig);
    expect(result.status).toBe("pass");
  });

  test("allows normal source files", async () => {
    const files = [
      file("src/index.ts"),
      file("src/App.tsx"),
      file("lib/utils.py"),
      file("README.md"),
    ];
    const result = await checkFilePatterns(files, defaultConfig);
    expect(result.status).toBe("pass");
  });

  test("allows small assets like favicon", async () => {
    const result = await checkFilePatterns([file("public/favicon.ico")], defaultConfig);
    expect(result.status).toBe("pass");
  });

  test("skips removed files", async () => {
    const files: ChangedFile[] = [{ path: ".env", content: "SECRET=abc", status: "removed" }];
    const result = await checkFilePatterns(files, defaultConfig);
    expect(result.status).toBe("pass");
  });

  // === Config ===

  test("custom block patterns from config", async () => {
    const config: FilePatternCheckConfig = {
      ...defaultConfig,
      block: ["*.sqlite"],
    };
    const result = await checkFilePatterns([file("data/app.sqlite")], config);
    expect(result.status).toBe("fail");
  });

  test("custom allow overrides block pattern", async () => {
    const config: FilePatternCheckConfig = {
      ...defaultConfig,
      allow: [".env.test"],
    };
    const result = await checkFilePatterns([file(".env.test")], config);
    expect(result.status).toBe("pass");
  });

  test("reports correct blocked pattern in findings", async () => {
    const result = await checkFilePatterns([file(".env"), file("dist/out.js")], defaultConfig);
    expect(result.status).toBe("fail");
    const findings = (result.details as any).findings as any[];
    expect(findings.length).toBe(2);
  });
});
