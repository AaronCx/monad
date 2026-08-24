import { describe, test, expect } from "bun:test";
import { checkAgentPatterns } from "../agent-patterns";
import type { CommitInfo, ChangedFile, AgentPatternCheckConfig } from "../../types";

const defaultConfig: AgentPatternCheckConfig = {
  enabled: true,
  severity: "warn",
};

function commit(sha: string, message: string): CommitInfo {
  return { sha, message, author: "agent", timestamp: new Date().toISOString() };
}

function file(path: string, status: "added" | "modified" | "removed" = "added"): ChangedFile {
  return { path, content: "content", status };
}

describe("Agent Behavior Patterns", () => {
  // === Should WARN ===

  test("detects thrashing: file added then deleted", async () => {
    const commits = [commit("abc1", "add file"), commit("abc2", "delete file")];
    const files: ChangedFile[] = [
      { path: "src/auth.ts", content: "code", status: "added" },
      { path: "src/auth.ts", content: "", status: "removed" },
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    expect(result.status).toBe("warn");
    const findings = (result.details as any).findings as any[];
    expect(findings.some((f: any) => f.pattern === "File Thrashing")).toBe(true);
  });

  test("detects scope creep: single commit touches 20+ files across 5+ dirs", async () => {
    const commits = [commit("abc1", "feat: big refactor")];
    const files: ChangedFile[] = [];
    const dirs = ["src", "lib", "utils", "config", "api", "tests"];
    for (const dir of dirs) {
      for (let i = 0; i < 4; i++) {
        files.push(file(`${dir}/file${i}.ts`));
      }
    }
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    expect(result.status).toBe("warn");
    const findings = (result.details as any).findings as any[];
    expect(findings.some((f: any) => f.pattern === "Scope Creep" || f.pattern === "Wide Scope")).toBe(true);
  });

  test("detects config churn: 3+ config files modified", async () => {
    const commits = [commit("abc1", "chore: fix configs")];
    const files: ChangedFile[] = [
      file("tsconfig.json", "modified"),
      file("package.json", "modified"),
      file("eslint.config.js", "modified"),
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    expect(result.status).toBe("warn");
    const findings = (result.details as any).findings as any[];
    expect(findings.some((f: any) => f.pattern === "Config Churn")).toBe(true);
  });

  test("detects test skipping: source files added without test files", async () => {
    const commits = [commit("abc1", "feat: add new features")];
    const files: ChangedFile[] = [
      file("src/lib/auth.ts"),
      file("src/utils/parse.ts"),
      file("src/api/webhook.ts"),
      file("src/checks/run.ts"),
      file("src/config/loader.ts"),
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    expect(result.status).toBe("warn");
    const findings = (result.details as any).findings as any[];
    expect(findings.some((f: any) => f.pattern === "Missing Tests")).toBe(true);
  });

  // === Should PASS ===

  test("passes normal development pattern with source + test files", async () => {
    const commits = [commit("abc1", "feat: add auth module")];
    const files: ChangedFile[] = [
      file("src/auth.ts"),
      file("src/auth.test.ts"),
      file("package.json", "modified"),
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    // Config churn needs 3+, so 1 config file is fine
    // Test files are present alongside source
    const findings = (result.details as any).findings as any[];
    const testSkipFinding = findings.find((f: any) => f.pattern === "Missing Tests");
    expect(testSkipFinding).toBeUndefined();
  });

  test("passes refactor touching many files in same module", async () => {
    const commits = [
      commit("abc1", "refactor: restructure auth module"),
      commit("abc2", "refactor: update auth tests"),
    ];
    const files: ChangedFile[] = [
      file("src/auth/login.ts", "modified"),
      file("src/auth/register.ts", "modified"),
      file("src/auth/utils.ts", "modified"),
      file("src/auth/__tests__/login.test.ts", "modified"),
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    // All files in same directory, not scope creep; tests present
    const findings = (result.details as any).findings as any[];
    const scopeCreep = findings.find((f: any) => f.pattern === "Scope Creep");
    expect(scopeCreep).toBeUndefined();
  });

  test("passes single config change (not churn)", async () => {
    const commits = [commit("abc1", "chore: update tsconfig")];
    const files: ChangedFile[] = [
      file("tsconfig.json", "modified"),
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    const findings = (result.details as any).findings as any[];
    const churn = findings.find((f: any) => f.pattern === "Config Churn");
    expect(churn).toBeUndefined();
  });

  test("passes with empty files and commits", async () => {
    const result = await checkAgentPatterns([], [], [], defaultConfig);
    expect(result.status).toBe("pass");
  });

  test("passes when only modified files have corresponding test changes", async () => {
    const commits = [commit("abc1", "feat: update dashboard")];
    const files: ChangedFile[] = [
      { path: "src/dashboard.ts", content: "code", status: "modified" },
      { path: "src/dashboard.test.ts", content: "tests", status: "modified" },
    ];
    const result = await checkAgentPatterns(commits, files, [], defaultConfig);
    // Modified files (not added) don't trigger test skipping
    const findings = (result.details as any).findings as any[];
    const testSkip = findings.find((f: any) => f.pattern === "Missing Tests");
    expect(testSkip).toBeUndefined();
  });
});
