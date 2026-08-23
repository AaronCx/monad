import type {
  CommitInfo,
  ChangedFile,
  CheckResult,
  AgentPatternCheckConfig,
} from "../types";

const CONFIG_FILES = new Set([
  "tsconfig.json", "tsconfig.node.json", "tsconfig.build.json",
  ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml",
  "eslint.config.js", "eslint.config.mjs",
  "biome.json", "biome.jsonc",
  "prettier.config.js", ".prettierrc", ".prettierrc.json",
  "package.json",
  "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs",
  "webpack.config.js", "rollup.config.js",
  "jest.config.js", "jest.config.ts", "vitest.config.ts",
  ".babelrc", "babel.config.js",
  "tailwind.config.js", "tailwind.config.ts",
  "postcss.config.js",
  "pyproject.toml", "setup.cfg", "Cargo.toml",
]);

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*_test\.go$/,
  /tests?\//,
];

interface PatternFinding {
  pattern: string;
  details: string;
  severity: "high" | "medium" | "low";
}

function getBasename(filepath: string): string {
  return filepath.split("/").pop() ?? filepath;
}

function getDirectory(filepath: string): string {
  const parts = filepath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function isTestFile(filename: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(filename));
}

function isConfigFile(filename: string): boolean {
  return CONFIG_FILES.has(getBasename(filename));
}

function detectThrashing(
  files: ChangedFile[],
): PatternFinding[] {
  const findings: PatternFinding[] = [];

  // Within the current changeset, look for files that were both added and removed
  const statusByFile = new Map<string, string[]>();
  for (const file of files) {
    const statuses = statusByFile.get(file.path) ?? [];
    statuses.push(file.status);
    statusByFile.set(file.path, statuses);
  }

  for (const [filename, statuses] of statusByFile) {
    if (statuses.includes("added") && statuses.includes("removed")) {
      findings.push({
        pattern: "File Thrashing",
        details: `${filename} was added then deleted -- possible agent confusion`,
        severity: "medium",
      });
    }
  }

  return findings;
}

function detectScopeCreep(
  commits: CommitInfo[],
  files: ChangedFile[],
): PatternFinding[] {
  const findings: PatternFinding[] = [];

  // Check across all files in the changeset
  const allDirs = new Set(files.map((f) => getDirectory(f.path).split("/")[0]));
  if (allDirs.size >= 8) {
    findings.push({
      pattern: "Wide Scope",
      details: `Changeset touches ${allDirs.size} different top-level directories -- consider splitting into smaller PRs`,
      severity: "low",
    });
  }

  // Check if any single commit touches too many directories
  // (We can infer from commit count vs file spread)
  if (commits.length === 1 && files.length > 20) {
    const dirs = new Set(files.map((f) => getDirectory(f.path).split("/")[0]));
    if (dirs.size >= 5) {
      findings.push({
        pattern: "Scope Creep",
        details: `Single commit touches ${files.length} files across ${dirs.size} directories -- may indicate unfocused changes`,
        severity: "medium",
      });
    }
  }

  return findings;
}

function detectConfigChurn(
  files: ChangedFile[],
  previousCommits: CommitInfo[],
): PatternFinding[] {
  const findings: PatternFinding[] = [];

  // Count config file changes in current changeset
  const configFiles = files.filter((f) => isConfigFile(f.path));

  if (configFiles.length >= 3) {
    const names = configFiles.map((f) => getBasename(f.path)).join(", ");
    findings.push({
      pattern: "Config Churn",
      details: `${configFiles.length} config files modified in this changeset (${names}) -- possible configuration thrashing`,
      severity: "medium",
    });
  }

  return findings;
}

function detectTestSkipping(
  files: ChangedFile[],
): PatternFinding[] {
  const findings: PatternFinding[] = [];

  const newSourceFiles = files.filter(
    (f) =>
      f.status === "added" &&
      !isTestFile(f.path) &&
      !isConfigFile(f.path) &&
      /\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(f.path),
  );

  const newTestFiles = files.filter(
    (f) => f.status === "added" && isTestFile(f.path),
  );

  if (newSourceFiles.length > 0 && newTestFiles.length === 0) {
    const fileList = newSourceFiles
      .slice(0, 5)
      .map((f) => f.path)
      .join(", ");
    findings.push({
      pattern: "Missing Tests",
      details: `${newSourceFiles.length} new source file(s) added without any test files (${fileList}${newSourceFiles.length > 5 ? "..." : ""})`,
      severity: "medium",
    });
  }

  return findings;
}

export async function checkAgentPatterns(
  commits: CommitInfo[],
  files: ChangedFile[],
  previousCommits: CommitInfo[],
  config: AgentPatternCheckConfig,
): Promise<CheckResult> {
  const allFindings: PatternFinding[] = [];

  allFindings.push(...detectThrashing(files));
  allFindings.push(...detectScopeCreep(commits, files));
  allFindings.push(...detectConfigChurn(files, previousCommits));
  allFindings.push(...detectTestSkipping(files));

  return {
    type: "agent_patterns",
    status: allFindings.length > 0 ? "warn" : "pass",
    title: "Agent Behavior Patterns",
    summary: allFindings.length === 0
      ? "No concerning agent patterns detected"
      : `Detected ${allFindings.length} agent behavior pattern(s)`,
    details: {
      findings: allFindings,
      count: allFindings.length,
    },
  };
}
