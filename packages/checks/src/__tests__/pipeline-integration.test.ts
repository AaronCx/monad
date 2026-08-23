import { describe, test, expect } from "bun:test";
import { runCheckPipeline, type PipelineInput } from "../pipeline";
import type { ChangedFile, CommitInfo } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function file(
  path: string,
  content: string,
  status: ChangedFile["status"] = "added",
): ChangedFile {
  return { path, content, status };
}

function commitInfo(
  sha: string,
  message: string,
  author = "dev",
): CommitInfo {
  return { sha, message, author, timestamp: new Date().toISOString() };
}

/** Base config that disables lint/build/dependencies (they spawn processes). */
const FAST_CHECKS_ONLY: PipelineInput["config"] = {
  checks: {
    secrets: { enabled: true, severity: "fail" },
    file_patterns: { enabled: true, severity: "fail" },
    typecheck: { enabled: false, severity: "fail" },
    test: { enabled: false, severity: "warn" },
    agent_patterns: { enabled: true, severity: "warn" },
    lint: { enabled: false, severity: "fail" },
    build: { enabled: false, severity: "fail" },
    dependencies: { enabled: false, severity: "warn" },
  },
};

/** All checks disabled — useful as a base to enable selectively. */
const ALL_DISABLED: PipelineInput["config"] = {
  checks: {
    secrets: { enabled: false, severity: "fail" },
    file_patterns: { enabled: false, severity: "fail" },
    typecheck: { enabled: false, severity: "fail" },
    test: { enabled: false, severity: "warn" },
    agent_patterns: { enabled: false, severity: "warn" },
    lint: { enabled: false, severity: "fail" },
    build: { enabled: false, severity: "fail" },
    dependencies: { enabled: false, severity: "warn" },
  },
};

function makeInput(overrides?: Partial<PipelineInput>): PipelineInput {
  return {
    files: [],
    commits: [commitInfo("abc1234", "feat: initial commit")],
    config: FAST_CHECKS_ONLY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Pipeline Integration — clean files, all pass", () => {
  test("clean source files with tests yield zero failures and zero warnings", async () => {
    const input = makeInput({
      files: [
        file("src/index.ts", "export const greeting = 'hello';"),
        file("src/utils.ts", "export function add(a: number, b: number) { return a + b; }"),
        file("src/__tests__/index.test.ts", "test('greeting', () => {})"),
      ],
      commits: [commitInfo("a1b2c3d", "feat: add greeting util")],
    });

    const results = await runCheckPipeline(input);

    expect(results.hasFailures).toBe(false);
    expect(results.failureCount).toBe(0);
    // All enabled checks should produce a result
    expect(results.checks.length).toBe(3);
    for (const check of results.checks) {
      expect(check.status).toBe("pass");
    }
  });

  test("all checks pass when files include tests and commits are conventional", async () => {
    const input = makeInput({
      files: [
        file("lib/math.ts", "export const pi = 3.14;"),
        file("lib/__tests__/math.test.ts", "test('pi', () => {})"),
      ],
      commits: [
        commitInfo("aaa1111", "feat: add math constants"),
        commitInfo("bbb2222", "fix: correct pi precision"),
      ],
    });

    const results = await runCheckPipeline(input);
    expect(results.hasFailures).toBe(false);
    expect(results.hasWarnings).toBe(false);
  });
});

describe("Pipeline Integration — secrets detection", () => {
  test("secret in file content causes failure", async () => {
    const input = makeInput({
      files: [
        file("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";'),
      ],
    });

    const results = await runCheckPipeline(input);

    expect(results.hasFailures).toBe(true);
    expect(results.failureCount).toBeGreaterThanOrEqual(1);
    const secretsCheck = results.checks.find((c) => c.type === "secrets");
    expect(secretsCheck).toBeDefined();
    expect(secretsCheck!.status).toBe("fail");
  });

  test("GitHub PAT triggers secrets failure with annotations", async () => {
    const input = makeInput({
      files: [
        file("src/auth.ts", 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";'),
      ],
    });

    const results = await runCheckPipeline(input);

    expect(results.hasFailures).toBe(true);
    const secretsCheck = results.checks.find((c) => c.type === "secrets");
    expect(secretsCheck!.status).toBe("fail");
    // Secrets findings include file+line so annotations should be generated
    expect(results.annotations.length).toBeGreaterThan(0);
    expect(results.annotations[0].annotation_level).toBe("failure");
    expect(results.annotations[0].path).toBe("src/auth.ts");
  });

  test("removed files with secrets do not trigger failure", async () => {
    const input = makeInput({
      files: [
        file("src/old.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";', "removed"),
      ],
    });

    const results = await runCheckPipeline(input);
    const secretsCheck = results.checks.find((c) => c.type === "secrets");
    expect(secretsCheck!.status).toBe("pass");
  });
});

describe("Pipeline Integration — agent_patterns detection", () => {
  test("new source files without tests produce agent_patterns warning", async () => {
    const input = makeInput({
      files: [
        file("src/feature.ts", "export function run() {}"),
        file("src/helper.ts", "export function help() {}"),
      ],
      commits: [commitInfo("c3d4e5f", "feat: add feature and helper")],
    });

    const results = await runCheckPipeline(input);
    const agentCheck = results.checks.find((c) => c.type === "agent_patterns");
    expect(agentCheck).toBeDefined();
    expect(agentCheck!.status).toBe("warn");
    const findings = agentCheck!.details.findings as Array<Record<string, unknown>>;
    expect(findings.some((f) => f.pattern === "Missing Tests")).toBe(true);
  });

  test("new source files with matching tests pass agent_patterns", async () => {
    const input = makeInput({
      files: [
        file("src/feature.ts", "export function run() {}"),
        file("src/__tests__/feature.test.ts", "test('run', () => {})"),
      ],
      commits: [commitInfo("d4e5f6a", "feat: add feature with tests")],
    });

    const results = await runCheckPipeline(input);
    const agentCheck = results.checks.find((c) => c.type === "agent_patterns");
    expect(agentCheck!.status).toBe("pass");
  });

  test("wide scope across many directories triggers warning", async () => {
    const dirs = ["src", "lib", "api", "db", "auth", "config", "utils", "hooks"];
    const files = dirs.map((d) => file(`${d}/index.ts`, "export default {};"));
    const input = makeInput({
      files,
      commits: [commitInfo("e5f6a7b", "feat: massive refactor")],
    });

    const results = await runCheckPipeline(input);
    const agentCheck = results.checks.find((c) => c.type === "agent_patterns");
    expect(agentCheck!.status).toBe("warn");
    const findings = agentCheck!.details.findings as Array<Record<string, unknown>>;
    expect(findings.some((f) => f.pattern === "Wide Scope")).toBe(true);
  });
});

describe("Pipeline Integration — empty inputs", () => {
  test("empty files array is handled gracefully", async () => {
    const input = makeInput({ files: [] });

    const results = await runCheckPipeline(input);

    expect(results.checks.length).toBeGreaterThan(0);
    expect(results.hasFailures).toBe(false);
    expect(typeof results.summary).toBe("string");
    expect(results.summary).toContain("monad");
  });

  test("empty commits array is handled gracefully", async () => {
    const input = makeInput({
      files: [file("src/index.ts", "const x = 1;")],
      commits: [],
    });

    const results = await runCheckPipeline(input);
    // Pipeline should not crash
    expect(results.checks.length).toBeGreaterThan(0);
  });
});

describe("Pipeline Integration — disabling specific checks via config", () => {
  test("disabling secrets skips secrets check entirely", async () => {
    const input = makeInput({
      files: [file("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";')],
      config: {
        ...FAST_CHECKS_ONLY,
        checks: {
          ...FAST_CHECKS_ONLY!.checks,
          secrets: { enabled: false, severity: "fail" },
        },
      },
    });

    const results = await runCheckPipeline(input);
    const secretsCheck = results.checks.find((c) => c.type === "secrets");
    expect(secretsCheck).toBeUndefined();
  });

  test("disabling all checks produces empty results array", async () => {
    const input = makeInput({ config: ALL_DISABLED });
    const results = await runCheckPipeline(input);

    expect(results.checks.length).toBe(0);
    expect(results.hasFailures).toBe(false);
    expect(results.hasWarnings).toBe(false);
    expect(results.failureCount).toBe(0);
    expect(results.warningCount).toBe(0);
  });

  test("enabling only one check runs only that check", async () => {
    const input = makeInput({
      files: [file("src/index.ts", "const x = 1;")],
      config: {
        checks: {
          ...ALL_DISABLED!.checks,
          secrets: { enabled: true, severity: "fail" },
        },
      },
    });

    const results = await runCheckPipeline(input);
    expect(results.checks.length).toBe(1);
    expect(results.checks[0].type).toBe("secrets");
  });
});

describe("Pipeline Integration — CheckRunResults structure", () => {
  test("result contains all expected top-level properties", async () => {
    const input = makeInput({
      files: [file("src/app.ts", "console.log('hi');")],
    });

    const results = await runCheckPipeline(input);

    expect(results).toHaveProperty("checks");
    expect(results).toHaveProperty("hasFailures");
    expect(results).toHaveProperty("hasWarnings");
    expect(results).toHaveProperty("failureCount");
    expect(results).toHaveProperty("warningCount");
    expect(results).toHaveProperty("summary");
    expect(results).toHaveProperty("annotations");

    expect(Array.isArray(results.checks)).toBe(true);
    expect(typeof results.hasFailures).toBe("boolean");
    expect(typeof results.hasWarnings).toBe("boolean");
    expect(typeof results.failureCount).toBe("number");
    expect(typeof results.warningCount).toBe("number");
    expect(typeof results.summary).toBe("string");
    expect(Array.isArray(results.annotations)).toBe(true);
  });

  test("each check result has type, status, title, details, and duration_ms", async () => {
    const input = makeInput({
      files: [file("src/index.ts", "export default 1;")],
    });

    const results = await runCheckPipeline(input);

    for (const check of results.checks) {
      expect(check).toHaveProperty("type");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("title");
      expect(check).toHaveProperty("details");
      expect(check).toHaveProperty("duration_ms");
      expect(typeof check.type).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(typeof check.title).toBe("string");
      expect(typeof check.details).toBe("object");
      expect(typeof check.duration_ms).toBe("number");
      expect(check.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("failureCount and warningCount match the actual check statuses", async () => {
    const input = makeInput({
      files: [
        file(".env", "SECRET=value"),                 // triggers file_patterns fail
        file("src/ok.ts", "const x = 1;"),            // clean
      ],
      commits: [commitInfo("f6a7b8c", "update")],    // non-conventional + generic
    });

    const results = await runCheckPipeline(input);

    const actualFailures = results.checks.filter((c) => c.status === "fail").length;
    const actualWarnings = results.checks.filter((c) => c.status === "warn").length;

    expect(results.failureCount).toBe(actualFailures);
    expect(results.warningCount).toBe(actualWarnings);
    expect(results.hasFailures).toBe(actualFailures > 0);
    expect(results.hasWarnings).toBe(actualWarnings > 0);
  });

  test("summary includes pass/warning/failure counts", async () => {
    const input = makeInput({
      files: [file("src/clean.ts", "const x = 1;")],
    });

    const results = await runCheckPipeline(input);

    expect(results.summary).toContain("passed");
    expect(results.summary).toContain("warnings");
    expect(results.summary).toContain("failures");
  });
});

describe("Pipeline Integration — annotations", () => {
  test("annotations are generated for secret findings with file and line info", async () => {
    const input = makeInput({
      files: [
        file("src/keys.ts", 'const aws = "AKIAIOSFODNN7EXAMPLE";'),
      ],
      config: {
        checks: {
          ...ALL_DISABLED!.checks,
          secrets: { enabled: true, severity: "fail" },
        },
      },
    });

    const results = await runCheckPipeline(input);

    expect(results.annotations.length).toBeGreaterThan(0);
    for (const annotation of results.annotations) {
      expect(annotation).toHaveProperty("path");
      expect(annotation).toHaveProperty("start_line");
      expect(annotation).toHaveProperty("end_line");
      expect(annotation).toHaveProperty("annotation_level");
      expect(annotation).toHaveProperty("message");
      expect(annotation).toHaveProperty("title");
      expect(typeof annotation.path).toBe("string");
      expect(typeof annotation.start_line).toBe("number");
    }
  });

  test("no annotations when all checks pass", async () => {
    const input = makeInput({
      files: [file("src/clean.ts", "const x = 1;")],
      commits: [commitInfo("aaa1111", "feat: clean commit")],
    });

    const results = await runCheckPipeline(input);

    // Secrets and file_patterns should pass
    // Annotations should be empty when no findings have file+line
    // (agent_patterns findings don't have file+line so no annotations from them)
    const failedChecks = results.checks.filter((c) => c.status === "fail");
    if (failedChecks.length === 0) {
      expect(results.annotations.length).toBe(0);
    }
  });

  test("file_patterns failures produce annotations only if findings have file+line", async () => {
    const input = makeInput({
      files: [file(".env", "DB_URL=localhost")],
      config: {
        checks: {
          ...ALL_DISABLED!.checks,
          file_patterns: { enabled: true, severity: "fail" },
        },
      },
    });

    const results = await runCheckPipeline(input);
    expect(results.hasFailures).toBe(true);
    // file_patterns findings have `file` but not `line`, so no annotations
    expect(results.annotations.length).toBe(0);
  });
});

describe("Pipeline Integration — file_patterns failures", () => {
  test(".env file is blocked by default", async () => {
    const input = makeInput({
      files: [file(".env", "SECRET=abc123")],
    });

    const results = await runCheckPipeline(input);
    const fpCheck = results.checks.find((c) => c.type === "file_patterns");
    expect(fpCheck).toBeDefined();
    expect(fpCheck!.status).toBe("fail");
  });

  test(".env.example is allowed by default", async () => {
    const input = makeInput({
      files: [file(".env.example", "API_KEY=your_key_here")],
    });

    const results = await runCheckPipeline(input);
    const fpCheck = results.checks.find((c) => c.type === "file_patterns");
    expect(fpCheck!.status).toBe("pass");
  });

  test("node_modules files are blocked by default", async () => {
    const input = makeInput({
      files: [file("node_modules/lodash/index.js", "module.exports = {};")],
    });

    const results = await runCheckPipeline(input);
    const fpCheck = results.checks.find((c) => c.type === "file_patterns");
    expect(fpCheck!.status).toBe("fail");
  });

  test(".DS_Store is blocked by default", async () => {
    const input = makeInput({
      files: [file(".DS_Store", "binary content")],
    });

    const results = await runCheckPipeline(input);
    const fpCheck = results.checks.find((c) => c.type === "file_patterns");
    expect(fpCheck!.status).toBe("fail");
  });
});

describe("Pipeline Integration — mixed scenarios", () => {
  test("multiple failures across different checks", async () => {
    const input = makeInput({
      files: [
        file("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";'),  // secret
        file(".env", "DB_URL=postgres://user:pass@host/db"),             // blocked file + secret
      ],
      commits: [commitInfo("badcafe", "asdf")],                          // generic + non-conventional
    });

    const results = await runCheckPipeline(input);

    expect(results.hasFailures).toBe(true);
    expect(results.failureCount).toBeGreaterThanOrEqual(1);

    const secretsCheck = results.checks.find((c) => c.type === "secrets");
    const fpCheck = results.checks.find((c) => c.type === "file_patterns");

    expect(secretsCheck!.status).toBe("fail");
    expect(fpCheck!.status).toBe("fail");
  });

  test("failures and warnings coexist correctly", async () => {
    const input = makeInput({
      files: [
        file(".env", "X=1"),                                   // blocked file pattern
        file("src/feature.ts", "export function run() {}"),    // no tests → agent warning
      ],
      commits: [commitInfo("a1b2c3d", "feat: add feature")],
    });

    const results = await runCheckPipeline(input);

    expect(results.hasFailures).toBe(true);
    expect(results.failureCount).toBeGreaterThanOrEqual(1);

    const agentCheck = results.checks.find((c) => c.type === "agent_patterns");
    if (agentCheck!.status === "warn") {
      expect(results.hasWarnings).toBe(true);
      expect(results.warningCount).toBeGreaterThanOrEqual(1);
    }
  });

  test("summary text contains check type names for failing checks", async () => {
    const input = makeInput({
      files: [file(".env", "SECRET=value")],
      commits: [commitInfo("aabbccd", "feat: add env file")],
    });

    const results = await runCheckPipeline(input);

    expect(results.summary).toContain("file_patterns");
  });

  test("pipeline handles renamed file status", async () => {
    const input = makeInput({
      files: [
        file("src/new-name.ts", "export const x = 1;", "renamed"),
      ],
      commits: [commitInfo("rename1", "refactor: rename module")],
    });

    const results = await runCheckPipeline(input);
    // Should not crash; renamed is a valid status
    expect(results.checks.length).toBeGreaterThan(0);
  });

  test("pipeline handles file with patch field", async () => {
    const input = makeInput({
      files: [
        {
          path: "src/app.ts",
          content: "const x = 1;",
          patch: "@@ -0,0 +1 @@\n+const x = 1;",
          status: "added" as const,
        },
      ],
    });

    const results = await runCheckPipeline(input);
    expect(results.checks.length).toBeGreaterThan(0);
  });
});

describe("Pipeline Integration — previousCommits", () => {
  test("pipeline accepts previousCommits without errors", async () => {
    const input = makeInput({
      previousCommits: [
        commitInfo("prev001", "feat: older commit"),
        commitInfo("prev002", "fix: older fix"),
      ],
    });

    const results = await runCheckPipeline(input);
    expect(results.checks.length).toBeGreaterThan(0);
  });

  test("config churn detection in agent_patterns with many config files", async () => {
    const input = makeInput({
      files: [
        file("tsconfig.json", "{}"),
        file("eslint.config.js", "module.exports = {};"),
        file("prettier.config.js", "module.exports = {};"),
      ],
      commits: [commitInfo("cfg1234", "chore: update configs")],
    });

    const results = await runCheckPipeline(input);
    const agentCheck = results.checks.find((c) => c.type === "agent_patterns");
    expect(agentCheck!.status).toBe("warn");
    const findings = agentCheck!.details.findings as Array<Record<string, unknown>>;
    expect(findings.some((f) => f.pattern === "Config Churn")).toBe(true);
  });
});
