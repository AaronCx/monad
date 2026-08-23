import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { z } from "zod";
import { diffBetween, runChecks } from "../src/index";
import type { CheckRunResults, Finding, PipelineConfig } from "../src/index";
import { makeFixtureRepo, type FixtureRepo } from "./fixtures/make-repo";

// Structural schema for CheckRunResults, so the JSON output shape is pinned.
const checkRunResultsSchema = z.object({
  checks: z.array(
    z.object({
      type: z.enum([
        "secrets",
        "lint",
        "typecheck",
        "build",
        "test",
        "dependencies",
        "file_patterns",
        "agent_patterns",
      ]),
      status: z.enum(["pass", "warn", "fail"]),
      title: z.string(),
      summary: z.string().optional(),
      details: z.record(z.unknown()),
      duration_ms: z.number().optional(),
    }),
  ),
  hasFailures: z.boolean(),
  hasWarnings: z.boolean(),
  failureCount: z.number(),
  warningCount: z.number(),
  summary: z.string(),
  annotations: z.array(
    z.object({
      path: z.string(),
      start_line: z.number(),
      end_line: z.number(),
      annotation_level: z.enum(["notice", "warning", "failure"]),
      message: z.string(),
      title: z.string(),
    }),
  ),
  meta: z.object({
    engineVersion: z.string(),
    entropyThreshold: z.number(),
    inlineIgnore: z.boolean(),
    rulesetVersion: z.string().optional(),
  }),
});

function findingsOf(results: CheckRunResults, type: string): Array<Record<string, unknown>> {
  const check = results.checks.find((c) => c.type === type);
  expect(check).toBeDefined();
  return (check!.details.findings as Array<Record<string, unknown>>) ?? [];
}

describe("runChecks against the fixture repo", () => {
  let repo: FixtureRepo;
  let results: CheckRunResults;

  beforeAll(async () => {
    repo = makeFixtureRepo();
    const files = await diffBetween(repo.baseSha, repo.headSha, repo.dir);
    const config: Partial<PipelineConfig> = {
      checks: {
        // Command override so the fixture repo needs no node_modules of its
        // own: the monorepo's biome binary lints the planted file directly.
        lint: {
          enabled: true,
          severity: "fail",
          command: `${repo.biomeBin} check ${repo.planted.lintError.file}`,
        },
      },
    };
    results = await runChecks({
      cwd: repo.dir,
      files,
      base: repo.baseSha,
      head: repo.headSha,
      config,
      profile: "fast",
    });
  }, 120_000);

  afterAll(() => {
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
  });

  test("reports the planted synthetic secret at the correct file:line", () => {
    const findings = findingsOf(results, "secrets");
    const hit = findings.find(
      (f) => f.file === repo.planted.secret.file && f.line === repo.planted.secret.line,
    );
    expect(hit).toBeDefined();
    expect(String(hit!.pattern)).toContain("API Key");
    // The raw value never appears; findings carry a redacted match.
    expect(String(hit!.match)).toContain("***");
  });

  test("reports the planted type error at the correct file:line with a TS rule", () => {
    const check = results.checks.find((c) => c.type === "typecheck");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    const findings = (check!.details.findings ?? []) as Finding[];
    const hit = findings.find(
      (f) =>
        f.file.endsWith(repo.planted.typeError.file) && f.line === repo.planted.typeError.line,
    );
    expect(hit).toBeDefined();
    expect(hit!.rule).toMatch(/^TS\d+$/);
  });

  test("reports the planted biome lint error at the correct file:line", () => {
    const check = results.checks.find((c) => c.type === "lint");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    const findings = findingsOf(results, "lint");
    const hit = findings.find(
      (f) =>
        String(f.file).endsWith(repo.planted.lintError.file) &&
        f.line === repo.planted.lintError.line,
    );
    expect(hit).toBeDefined();
  });

  test("reports the new dependency without a lockfile update", () => {
    const check = results.checks.find((c) => c.type === "dependencies");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    const findings = findingsOf(results, "dependencies");
    const hit = findings.find((f) => f.file === repo.planted.dependency.file);
    expect(hit).toBeDefined();
    expect(String(hit!.message)).toContain("lockfile");
  });

  test("reports the planted .env file", () => {
    const check = results.checks.find((c) => c.type === "file_patterns");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    const findings = findingsOf(results, "file_patterns");
    const hit = findings.find((f) => f.file === repo.planted.envFile.file);
    expect(hit).toBeDefined();
  });

  test("the run fails overall and the JSON shape matches CheckRunResults", () => {
    expect(results.hasFailures).toBe(true);
    // Round-trip through JSON: the shape a CLI's --json flag would emit.
    const parsed = checkRunResultsSchema.safeParse(JSON.parse(JSON.stringify(results)));
    expect(parsed.success).toBe(true);
  });

  test("secrets and typecheck findings carry annotations with real line numbers", () => {
    const secretAnnotation = results.annotations.find(
      (a) => a.path === repo.planted.secret.file,
    );
    expect(secretAnnotation).toBeDefined();
    expect(secretAnnotation!.start_line).toBe(repo.planted.secret.line);
    expect(secretAnnotation!.annotation_level).toBe("failure");
  });
});
