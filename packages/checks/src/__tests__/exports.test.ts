import { describe, test, expect } from "bun:test";
import * as engine from "../index";

describe("Engine public exports", () => {
  test("runCheckPipeline is exported as a function", () => {
    expect(engine.runCheckPipeline).toBeDefined();
    expect(typeof engine.runCheckPipeline).toBe("function");
  });

  test("parseConfig is exported as a function", () => {
    expect(engine.parseConfig).toBeDefined();
    expect(typeof engine.parseConfig).toBe("function");
  });

  test("parseAddedLines is exported as a function", () => {
    expect(engine.parseAddedLines).toBeDefined();
    expect(typeof engine.parseAddedLines).toBe("function");
  });

  test("statusFromFindings is exported as a function", () => {
    expect(engine.statusFromFindings).toBeDefined();
    expect(typeof engine.statusFromFindings).toBe("function");
  });

  test("allowlist helpers are exported as functions", () => {
    expect(typeof engine.isPathAllowed).toBe("function");
    expect(typeof engine.isLineIgnored).toBe("function");
    expect(typeof engine.fingerprint).toBe("function");
    expect(typeof engine.loadBaseline).toBe("function");
    expect(typeof engine.writeBaseline).toBe("function");
    expect(typeof engine.DEFAULT_BASELINE_PATH).toBe("string");
  });

  test("getDefaultConfig is exported as a function (F2 fix needs it for --only merge)", () => {
    expect(typeof engine.getDefaultConfig).toBe("function");
  });

  test("no unexpected runtime exports exist", () => {
    const runtimeKeys = Object.keys(engine);
    const expected = [
      "runChecks",
      "listChecks",
      "loadConfig",
      "LASTGATE_RENAME_NOTICE",
      "runCheckPipeline",
      "runChecksIterable",
      "runSingleCheck",
      "resolveMeta",
      "formatMetaFooter",
      "defaultProfileFor",
      "CHECK_ORDER",
      "ENGINE_VERSION",
      "parseConfig",
      "parseConfigWithWarnings",
      "getDefaultConfig",
      "resolveExtends",
      "collectUnknownKeyWarnings",
      "REMOVED_KEYS",
      "validateConfig",
      "parsePackRef",
      "resolveBuiltinPack",
      "BUILTIN_PACK_NAMES",
      "isPathAllowed",
      "isLineIgnored",
      "fingerprint",
      "loadBaseline",
      "writeBaseline",
      "DEFAULT_BASELINE_PATH",
      "LEGACY_BASELINE_PATH",
      "parseAddedLines",
      "diffBetween",
      "getBranchDiff",
      "getStagedDiff",
      "splitPatchByFile",
      "commitsBetween",
      "statusFromFindings",
      "detectLinter",
      "parseTscOutput",
      "parseTestCounts",
    ];
    for (const key of expected) {
      expect(runtimeKeys).toContain(key);
    }
    expect(runtimeKeys.length).toBe(expected.length);
  });
});

describe("Engine type exports compile correctly", () => {
  // These tests verify that the type exports resolve at compile time.
  // If any type were missing from index.ts, this file would fail to compile.

  test("CheckResult type is usable", () => {
    const result: engine.CheckResult = {
      type: "secrets",
      status: "pass",
      title: "test",
      details: {},
    };
    expect(result.type).toBe("secrets");
  });

  test("CheckRunResults type is usable", () => {
    const results: engine.CheckRunResults = {
      checks: [],
      hasFailures: false,
      hasWarnings: false,
      failureCount: 0,
      warningCount: 0,
      summary: "",
      annotations: [],
      meta: { engineVersion: "test", entropyThreshold: 4.8, inlineIgnore: true },
    };
    expect(results.checks).toEqual([]);
  });

  test("PipelineConfig type is usable", () => {
    const config: engine.PipelineConfig = {
      checks: {
        secrets: { enabled: true, severity: "fail" },
      },
    };
    expect(config.checks.secrets!.enabled).toBe(true);
  });

  test("ChangedFile type is usable", () => {
    const f: engine.ChangedFile = {
      path: "src/index.ts",
      content: "const x = 1;",
      status: "added",
    };
    expect(f.status).toBe("added");
  });

  test("CommitInfo type is usable", () => {
    const c: engine.CommitInfo = {
      sha: "abc1234",
      message: "feat: test",
      author: "dev",
      timestamp: new Date().toISOString(),
    };
    expect(c.sha).toBe("abc1234");
  });

  test("CheckStatus type accepts valid values", () => {
    const pass: engine.CheckStatus = "pass";
    const warn: engine.CheckStatus = "warn";
    const fail: engine.CheckStatus = "fail";
    expect([pass, warn, fail]).toEqual(["pass", "warn", "fail"]);
  });

  test("CheckType type accepts all valid check types", () => {
    const types: engine.CheckType[] = [
      "secrets",
      "lint",
      "typecheck",
      "build",
      "test",
      "dependencies",
      "file_patterns",
      "agent_patterns",
    ];
    expect(types.length).toBe(8);
  });

  test("Annotation type is usable", () => {
    const a: engine.Annotation = {
      path: "src/index.ts",
      start_line: 1,
      end_line: 1,
      annotation_level: "failure",
      message: "Found a secret",
      title: "secrets: AWS Key",
    };
    expect(a.annotation_level).toBe("failure");
  });

  test("PipelineInput type is usable", () => {
    const input: engine.PipelineInput = {
      files: [],
      commits: [],
      cwd: "/tmp/somewhere",
    };
    expect(input.cwd).toBe("/tmp/somewhere");
  });
});
