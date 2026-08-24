import { describe, it, expect } from "bun:test";
import { checkSecrets } from "../checks/secrets";
import { checkFilePatterns } from "../checks/file-patterns";
import { checkAgentPatterns } from "../checks/agent-patterns";
import { runCheckPipeline } from "../pipeline";
import { calculateEntropy, extractTokens } from "../scanners/entropy";
import { parseConfig } from "../config/parser";
import type { ChangedFile, CommitInfo, CheckResult, CheckRunResults } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function file(path: string, content: string, status: ChangedFile["status"] = "added"): ChangedFile {
  return { path, content, status };
}

function commitInfo(sha: string, message: string, author = "dev"): CommitInfo {
  return { sha, message, author, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 1. Secret Scanner
// ---------------------------------------------------------------------------

describe("Secret Scanner", () => {
  const config = { enabled: true as const, severity: "fail" as const };

  it("detects AWS access key", async () => {
    const files = [file("config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";')];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("fail");
    expect(result.type).toBe("secrets");
    // details is Record<string, unknown> with findings array
    const findings = result.details.findings as Array<{ pattern: string }>;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.pattern.toLowerCase().includes("aws"))).toBe(true);
  });

  it("detects GitHub token (ghp_)", async () => {
    const files = [file("auth.ts", 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";')];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("fail");
    const findings = result.details.findings as Array<{ pattern: string }>;
    expect(findings.some((f) => f.pattern.toLowerCase().includes("github"))).toBe(true);
  });

  it("detects OpenAI key (sk-proj-)", async () => {
    const files = [file("ai.ts", 'const apiKey = "sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCDEFGH";')];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("fail");
  });

  it("detects generic password assignment", async () => {
    const files = [file("db.ts", 'const password = "secretpassword123";')];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("fail");
  });

  it("detects high entropy strings", async () => {
    const files = [file("keys.ts", 'const token = "a8f3k2j5h7g9d1s4f6a8k2j5h7g9d1s4f6a8k2j5h7g9";')];
    const result = await checkSecrets(files, config);
    // high entropy string should trigger a fail
    expect(result.status).toBe("fail");
  });

  it("passes clean files with no secrets", async () => {
    const files = [
      file("utils.ts", 'export function add(a: number, b: number) { return a + b; }'),
      file("index.ts", 'import { add } from "./utils";\nconsole.log(add(1, 2));'),
    ];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("pass");
  });

  it("respects custom patterns from config", async () => {
    const customConfig = {
      ...config,
      custom_patterns: [{ name: "Custom Secret", pattern: "CUSTOM_SECRET_[A-Z0-9]+", severity: "high" as const }],
    };
    const files = [file("custom.ts", 'const x = "CUSTOM_SECRET_ABC123";')];
    const result = await checkSecrets(files, customConfig);
    expect(result.status).toBe("fail");
  });

  it("skips binary files (.png, .jpg)", async () => {
    const files = [
      file("logo.png", "AKIAIOSFODNN7EXAMPLE embedded in binary"),
      file("photo.jpg", 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'),
    ];
    const result = await checkSecrets(files, config);
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 2. File Pattern Guard
// ---------------------------------------------------------------------------

describe("File Pattern Guard", () => {
  const config = { enabled: true as const, severity: "fail" as const };

  it("blocks .env files", async () => {
    const files = [file(".env", "DATABASE_URL=postgres://localhost/db")];
    const result = await checkFilePatterns(files, config);
    expect(result.status).toBe("fail");
    const findings = result.details.findings as Array<{ file: string }>;
    expect(findings.some((f) => f.file === ".env")).toBe(true);
  });

  it("blocks node_modules/", async () => {
    const files = [file("node_modules/lodash/index.js", "module.exports = {};")];
    const result = await checkFilePatterns(files, config);
    expect(result.status).toBe("fail");
    const findings = result.details.findings as Array<{ file: string }>;
    expect(findings.some((f) => f.file.includes("node_modules"))).toBe(true);
  });

  it("blocks .DS_Store", async () => {
    const files = [file(".DS_Store", "\x00\x00\x00\x01Bud1")];
    const result = await checkFilePatterns(files, config);
    expect(result.status).toBe("fail");
  });

  it("blocks dist/ and build/", async () => {
    const distFiles = [file("dist/bundle.js", "var a=1;")];
    const buildFiles = [file("build/output.js", "var b=2;")];

    const distResult = await checkFilePatterns(distFiles, config);
    const buildResult = await checkFilePatterns(buildFiles, config);

    expect(distResult.status).toBe("fail");
    expect(buildResult.status).toBe("fail");
  });

  it("blocks .claude/ directory", async () => {
    const files = [file(".claude/settings.json", '{"model": "claude-3"}')];
    const result = await checkFilePatterns(files, config);
    expect(result.status).toBe("fail");
  });

  it("allows .env.example when in allow list", async () => {
    const configWithAllow = {
      ...config,
      allow: [".env.example"],
    };
    const files = [file(".env.example", "DATABASE_URL=")];
    const result = await checkFilePatterns(files, configWithAllow);
    expect(result.status).toBe("pass");
  });

  it("passes clean file list", async () => {
    const files = [
      file("src/index.ts", "export default {};"),
      file("package.json", '{"name": "my-app"}'),
      file("README.md", "# My App"),
    ];
    const result = await checkFilePatterns(files, config);
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 5. Agent Pattern Analysis
// ---------------------------------------------------------------------------

describe("Agent Pattern Analysis", () => {
  const config = { enabled: true as const, severity: "warn" as const };

  it("detects config churn (multiple config files modified)", async () => {
    // Config churn triggers when >= 3 config files are modified
    const files = [
      file("package.json", '{"dependencies":{}}', "modified"),
      file("tsconfig.json", '{}', "modified"),
      file("eslint.config.js", 'module.exports = {};', "modified"),
    ];
    const commits = [commitInfo("aaa1111", "chore: update configs")];
    // checkAgentPatterns(commits, files, previousCommits, config)
    const result = await checkAgentPatterns(commits, files, [], config);
    expect(result.status).toBe("warn");
  });

  it("detects test skipping (source files added without tests)", async () => {
    const files = [
      file("src/feature.ts", "export function feature() { return true; }", "added"),
      file("src/another.ts", "export function another() { return false; }", "added"),
      file("src/third.ts", "export function third() { return null; }", "added"),
    ];
    const commits = [commitInfo("aaa1111", "feat: add features")];
    const result = await checkAgentPatterns(commits, files, [], config);
    expect(result.status).toBe("warn");
  });

  it("passes normal development patterns", async () => {
    const files = [
      file("src/feature.ts", "export function feature() { return true; }", "added"),
      file("src/__tests__/feature.test.ts", 'import { feature } from "../feature"; test("works", () => expect(feature()).toBe(true));', "added"),
    ];
    const commits = [commitInfo("aaa1111", "feat: add feature with tests")];
    const result = await checkAgentPatterns(commits, files, [], config);
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 6. Pipeline
// ---------------------------------------------------------------------------

describe("Pipeline", () => {
  it("runs all checks and returns aggregate results", async () => {
    const result = await runCheckPipeline({
      files: [file("src/index.ts", "export default {};")],
      commits: [commitInfo("abc1234", "feat: initial commit")],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          typecheck: { enabled: false, severity: "fail" },
          test: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: true, severity: "warn" },
        },
      },
    });
    expect(result).toHaveProperty("checks");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it("returns hasFailures=true when secrets found", async () => {
    const result = await runCheckPipeline({
      files: [file("leak.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";')],
      commits: [commitInfo("abc1234", "feat: add config")],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          typecheck: { enabled: false, severity: "fail" },
          test: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: true, severity: "warn" },
        },
      },
    });
    expect(result.hasFailures).toBe(true);
  });

  it("returns summary string", async () => {
    const result = await runCheckPipeline({
      files: [file("src/index.ts", "export default {};")],
      commits: [commitInfo("abc1234", "feat: initial commit")],
      config: {
        checks: {
          secrets: { enabled: true, severity: "fail" },
          file_patterns: { enabled: true, severity: "fail" },
          typecheck: { enabled: false, severity: "fail" },
          test: { enabled: false, severity: "warn" },
          agent_patterns: { enabled: true, severity: "warn" },
        },
      },
    });
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("config with all checks disabled returns empty results", async () => {
    const result = await runCheckPipeline({
      files: [file("leak.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";')],
      commits: [commitInfo("abc1234", "update")],
      config: {
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
      },
    });
    expect(result.checks.length).toBe(0);
    expect(result.hasFailures).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Entropy
// ---------------------------------------------------------------------------

describe("Entropy", () => {
  it("returns low entropy for 'aaaa' (~0)", () => {
    const entropy = calculateEntropy("aaaa");
    expect(entropy).toBeLessThan(1.0);
  });

  it("returns high entropy for random-looking strings (>4.0)", () => {
    const entropy = calculateEntropy("a8f3K2j5H7g9D1s4F6x0Z");
    expect(entropy).toBeGreaterThan(4.0);
  });

  it("extractTokens finds quoted strings and assignment values", () => {
    const code = `
      const apiKey = "sk-abcdef123456abcdef12";
      const name = 'helloworldhelloworldxx';
    `;
    const tokens = extractTokens(code);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((t: string) => t.includes("sk-abcdef123456"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Config Parser
// ---------------------------------------------------------------------------

describe("Config Parser", () => {
  it("parses valid YAML config", () => {
    const yaml = `
checks:
  secrets:
    enabled: true
    severity: fail
  file_patterns:
    enabled: true
    severity: fail
  typecheck:
    enabled: true
    severity: fail
`;
    const config = parseConfig(yaml);
    expect(config.checks!.secrets!.enabled).toBe(true);
    expect(config.checks!.secrets!.severity).toBe("fail");
    expect(config.checks!.typecheck!.enabled).toBe(true);
  });

  it("returns defaults for empty config", () => {
    const config = parseConfig("");
    expect(config).toHaveProperty("checks");
    expect(config.checks).toHaveProperty("secrets");
    expect(config.checks).toHaveProperty("file_patterns");
    expect(config.checks!.secrets).toHaveProperty("enabled");
    expect(config.checks!.secrets).toHaveProperty("severity");
  });

  it("merges partial config with defaults", () => {
    const yaml = `
checks:
  secrets:
    severity: warn
`;
    const config = parseConfig(yaml);
    expect(config.checks!.secrets!.severity).toBe("warn");
    // Other checks should still have defaults
    expect(config.checks!.file_patterns).toHaveProperty("enabled");
    expect(config.checks!.agent_patterns).toHaveProperty("enabled");
  });
});
