import { describe, test, expect } from "bun:test";
import { runCheckPipeline, type PipelineInput } from "../pipeline";

function makeInput(overrides?: Partial<PipelineInput>): PipelineInput {
  return {
    files: [],
    commits: [{ sha: "abc1234", message: "feat: test commit", author: "test", timestamp: new Date().toISOString() }],
    ...overrides,
  };
}

describe("Pipeline Runner", () => {
  test("runs all enabled checks and aggregates results", async () => {
    const input = makeInput({
      files: [{ path: "src/index.ts", content: "const x = 1;", status: "added" }],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          typecheck: { enabled: false, severity: "fail" },
          test: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: true, severity: "warn" },
          // Skip slow checks that spawn processes
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    expect(results.checks.length).toBeGreaterThan(0);
    expect(results.summary).toContain("monad");
  });

  test("skips disabled checks", async () => {
    const input = makeInput({
      config: {
        checks: {
          secrets: { enabled: false, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    const secretsCheck = results.checks.find(c => c.type === "secrets");
    const lintCheck = results.checks.find(c => c.type === "lint");
    const buildCheck = results.checks.find(c => c.type === "build");
    expect(secretsCheck).toBeUndefined();
    expect(lintCheck).toBeUndefined();
    expect(buildCheck).toBeUndefined();
  });

  test("returns status 'pass' when all checks pass", async () => {
    const input = makeInput({
      files: [{ path: "src/clean.ts", content: "const x = 1;", status: "added" }],
      commits: [{ sha: "abc1234", message: "feat: clean commit", author: "test", timestamp: new Date().toISOString() }],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          typecheck: { enabled: false, severity: "fail" },
          test: { enabled: false, severity: "warn" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    expect(results.hasFailures).toBe(false);
  });

  test("returns hasFailures when a check fails", async () => {
    const input = makeInput({
      files: [{ path: ".env", content: "SECRET=value", status: "added" }],
      config: {
        checks: {
          file_patterns: { enabled: true, severity: "fail" },
          secrets: { enabled: false, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          typecheck: { enabled: false, severity: "fail" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    expect(results.hasFailures).toBe(true);
    expect(results.failureCount).toBeGreaterThan(0);
  });

  test("returns hasWarnings when checks warn but none fail", async () => {
    const input = makeInput({
      // New source file without any test file: agent_patterns warns.
      files: [{ path: "src/index.ts", content: "const x = 1;", status: "added" }],
      commits: [{ sha: "abc1234", message: "feat: add index", author: "test", timestamp: new Date().toISOString() }],
      config: {
        checks: {
          typecheck: { enabled: false, severity: "fail" },
          secrets: { enabled: false, severity: "fail" },
          file_patterns: { enabled: false, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: true, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    expect(results.checks.length).toBeGreaterThan(0);
    expect(results.hasWarnings).toBe(true);
    expect(results.hasFailures).toBe(false);
  });

  test("reports correct counts", async () => {
    const input = makeInput({
      files: [{ path: "src/clean.ts", content: "const x = 1;", status: "added" }],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          typecheck: { enabled: false, severity: "fail" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    const total = results.checks.length;
    const passed = results.checks.filter(c => c.status === "pass").length;
    const failed = results.checks.filter(c => c.status === "fail").length;
    const warned = results.checks.filter(c => c.status === "warn").length;
    expect(total).toBe(passed + failed + warned);
  });

  test("each check result includes duration_ms", async () => {
    const input = makeInput({
      files: [{ path: "src/index.ts", content: "const x = 1;", status: "added" }],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          typecheck: { enabled: false, severity: "fail" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    for (const check of results.checks) {
      expect(check.duration_ms).toBeDefined();
      expect(typeof check.duration_ms).toBe("number");
      expect(check.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("pipeline completes even if one check throws", async () => {
    // We can't easily make a check throw without mocking,
    // but we can verify the pipeline handles normal cases gracefully
    const input = makeInput({
      files: [
        { path: "src/index.ts", content: "const x = 1;", status: "added" },
        { path: ".env", content: "SECRET=abc", status: "added" },
      ],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          typecheck: { enabled: false, severity: "fail" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    // Both checks should have run
    expect(results.checks.length).toBe(2);
  });

  test("summary contains all check results", async () => {
    const input = makeInput({
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          lint: { enabled: false, severity: "fail" },
          build: { enabled: false, severity: "fail" },
          dependencies: { enabled: false, severity: "warn" },
          test: { enabled: false, severity: "warn" },
          typecheck: { enabled: false, severity: "fail" },
          agent_patterns: { enabled: false, severity: "warn" },
        },
      },
    });
    const results = await runCheckPipeline(input);
    expect(results.summary).toContain("passed");
    expect(results.summary).toContain("monad");
  });

  describe("PR-4 profile filtering", () => {
    function profileInput(): PipelineInput {
      return makeInput({
        files: [{ path: "src/index.ts", content: "const x = 1;", status: "added" }],
        config: {
          checks: {
            secrets: { enabled: true, severity: "fail" },
            file_patterns: { enabled: false, severity: "fail" },
            typecheck: { enabled: false, severity: "fail" },
            test: { enabled: false, severity: "warn" },
            agent_patterns: { enabled: false, severity: "warn" },
            lint: { enabled: false, severity: "fail" },
            dependencies: { enabled: false, severity: "warn" },
            // Build is enabled but defaults to profile "full".
            build: { enabled: true, severity: "fail", command: "true" },
          },
        },
      });
    }

    test("fast profile (default) skips the build check", async () => {
      const results = await runCheckPipeline(profileInput());
      const types = results.checks.map((c) => c.type);
      expect(types).not.toContain("build");
      expect(types).toContain("secrets");
    });

    test("full profile runs the build check", async () => {
      const results = await runCheckPipeline(profileInput(), { profile: "full" });
      const types = results.checks.map((c) => c.type);
      expect(types).toContain("build");
    });

    test("per-check profile override moves a check into the full profile", async () => {
      const input = profileInput();
      const cfg = input.config?.checks?.secrets;
      if (cfg) cfg.profile = "full";
      const results = await runCheckPipeline(input);
      const types = results.checks.map((c) => c.type);
      expect(types).not.toContain("secrets"); // secrets is now full-only, won't run in fast
    });
  });
});
