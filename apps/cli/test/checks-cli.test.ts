import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureRepo, type FixtureRepo } from "../../../packages/checks/test/fixtures/make-repo";

/**
 * monad checks as a user runs it: the real CLI entry point against the
 * planted fixture repo. No daemon, no session, no vendor agent, no network.
 * Only cheap diff-scoped checks are selected so the command stays a wiring
 * test; packages/checks owns the per-check assertions.
 */

const CLI_MAIN = new URL("../src/main.ts", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, CLI_MAIN, ...args], {
    cwd,
    env: { ...process.env },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

let repo: FixtureRepo;

beforeAll(() => {
  repo = makeFixtureRepo();
  // The fixture repo has no node_modules; point lint at this monorepo's
  // biome so a --full run here would still work, and prove the loader reads
  // .monad.yml from cwd.
  writeFileSync(
    join(repo.dir, ".monad.yml"),
    [
      "version: 1",
      "checks:",
      "  lint:",
      "    enabled: true",
      "    severity: fail",
      `    command: ${repo.biomeBin} check ${repo.planted.lintError.file}`,
      "",
    ].join("\n"),
  );
}, 120_000);

afterAll(() => {
  if (repo) {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

describe("monad checks", () => {
  test("--base main --only secrets --json exits 1 with the planted finding", () => {
    const result = runCli(repo.dir, ["checks", "--base", "main", "--only", "secrets", "--json"]);
    expect(result.code).toBe(1);
    const results = JSON.parse(result.stdout) as {
      checks: Array<{ type: string; status: string; details: Record<string, unknown> }>;
      hasFailures: boolean;
    };
    expect(results.checks.map((check) => check.type)).toEqual(["secrets"]);
    expect(results.hasFailures).toBe(true);
    const findings = results.checks[0]?.details.findings as Array<{ file: string; line: number }>;
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: repo.planted.secret.file,
        line: repo.planted.secret.line,
      }),
    );
  });

  test("without --json it prints the checks table", () => {
    const result = runCli(repo.dir, ["checks", "--base", "main", "--only", "file_patterns"]);
    expect(result.stdout).toContain("| check | status | findings |");
    expect(result.stdout).toContain(repo.planted.envFile.file);
  });

  test("--staged sees the index, which is what a pre-commit hook runs", () => {
    writeFileSync(
      join(repo.dir, "src/staged-secret.ts"),
      ['// staged fixture file', 'export const api_key = "synthetic-fixture-credential-001";', ""].join(
        "\n",
      ),
    );
    execFileSync("git", ["add", "src/staged-secret.ts"], { cwd: repo.dir });
    const result = runCli(repo.dir, ["checks", "--staged", "--only", "secrets", "--json"]);
    expect(result.code).toBe(1);
    const results = JSON.parse(result.stdout) as {
      checks: Array<{ details: Record<string, unknown> }>;
    };
    const findings = results.checks[0]?.details.findings as Array<{ file: string; line: number }>;
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "src/staged-secret.ts", line: 2 }),
    );
    execFileSync("git", ["reset", "-q"], { cwd: repo.dir });
    rmSync(join(repo.dir, "src/staged-secret.ts"), { force: true });
  });

  test("a bad flag fails with a message, not a stack trace", () => {
    const result = runCli(repo.dir, ["checks", "--only", "semantic"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("monad: unknown check semantic");
    expect(result.stderr).not.toContain("at ");
  });
});
