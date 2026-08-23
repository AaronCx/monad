import { describe, it, expect } from "bun:test";
import { runCheckPipeline, type PipelineInput } from "../pipeline";
import { parseConfig } from "../config/parser";
import { parseAddedLines } from "../diff/parse";
import { checkFilePatterns } from "../checks/file-patterns";
import { checkSecrets } from "../checks/secrets";
import { parseBunAuditJson } from "../checks/dependencies";
import type { ChangedFile, PipelineConfig } from "../types";

function entropyFindings(details: Record<string, unknown>): Array<{ pattern: string }> {
  return (details.findings as Array<{ pattern: string }>).filter(
    (f) => f.pattern === "High Entropy String",
  );
}

// ---------------------------------------------------------------------------
// Adversarial gate-bypass corpus.
//
// Each test here encodes a concrete way a bad diff was able to slip past the
// gate (from the security audit). They are written to FAIL against the
// pre-fix engine and PASS once the corresponding fix lands, so the gate's core
// promise — "block bad diffs, pass good ones" — stays enforced.
// ---------------------------------------------------------------------------

function file(path: string, content: string, status: ChangedFile["status"] = "added"): ChangedFile {
  return { path, content, status };
}

function input(over: Partial<PipelineInput>): PipelineInput {
  return { files: [], commits: [], ...over };
}

// A real-shaped hardcoded credential the named scanners must catch.
const AWS_KEY_FILE = file("config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";');

describe("C5: a partial caller config must not disable/downgrade other checks", () => {
  it("keeps secrets running at blocking severity when only an unrelated check is set", async () => {
    // Pre-fix: shallow `{...defaults, ...config}` replaced the whole `checks`
    // object, so secrets vanished (or lost its severity → warn) and the AWS key
    // merged clean.
    const res = await runCheckPipeline(
      input({
        files: [AWS_KEY_FILE],
        config: { checks: { lint: { enabled: false } } } as Partial<PipelineConfig>,
      }),
    );

    const secrets = res.checks.find((c) => c.type === "secrets");
    expect(secrets).toBeDefined();
    expect(secrets!.status).toBe("fail"); // not silently downgraded to "warn"
    expect(res.hasFailures).toBe(true);
  });

  it("a partial secrets block keeps the default blocking severity", async () => {
    const res = await runCheckPipeline(
      input({
        files: [AWS_KEY_FILE],
        // user only tweaks the entropy threshold; severity must stay the default "fail"
        config: { checks: { secrets: { enabled: true, entropy_threshold: 4.0 } } } as Partial<PipelineConfig>,
      }),
    );
    const secrets = res.checks.find((c) => c.type === "secrets")!;
    expect(secrets.status).toBe("fail");
  });
});

describe("C1/allow: an unbounded allow glob can no longer neutralize the gate", () => {
  for (const glob of ["**", "**/*", "*", "**/**"]) {
    it(`rejects top-level allow: ['${glob}'] at parse time`, () => {
      expect(() => parseConfig(`allow:\n  - "${glob}"\n`)).toThrow();
    });
    it(`rejects secrets.allow: ['${glob}'] at parse time`, () => {
      expect(() => parseConfig(`checks:\n  secrets:\n    allow:\n      - "${glob}"\n`)).toThrow();
    });
  }

  it("still accepts a concrete allow prefix", () => {
    const cfg = parseConfig(`allow:\n  - "test/fixtures/**"\n`);
    expect(cfg.allow).toEqual(["test/fixtures/**"]);
  });
});

describe("extends: schema defaults must not clobber a pack value the user never set", () => {
  it("keeps the pack's build.enabled=false when the user sets only build.command", () => {
    const cfg = parseConfig(
      ["extends:", "  - solo-dev", "checks:", "  build:", "    command: 'make'"].join("\n"),
    );
    expect(cfg.checks.build?.enabled).toBe(false);
  });
});

describe("diff parser: an added line starting with '++ ' / '-- ' cannot truncate the hunk", () => {
  it("still emits added lines that follow a '+++ '-prefixed added line", () => {
    // Raw added content "++ not metadata" renders as a diff line "+++ not metadata".
    const patch = [
      "diff --git a/f.ts b/f.ts",
      "index 000..111 100644",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,0 +1,3 @@",
      "+++ not metadata, this is added content",
      '+const key = "AKIAIOSFODNN7EXAMPLE";',
      "+another added line",
    ].join("\n");

    const added = parseAddedLines(patch);
    const texts = added.map((a) => a.text);
    expect(texts).toContain('const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(texts.some((t) => t.includes("another added line"))).toBe(true);
  });
});

describe("dependencies: bun audit output is parsed (not discarded for npm)", () => {
  // Captured `bun audit --json` shape: a version banner, then a top-level object
  // keyed by package name with advisory arrays. The npm parser can't read this.
  const bunOutput = [
    "bun audit v1.3.10 (30e609e0)",
    JSON.stringify({
      "fast-uri": [
        { id: 1117884, url: "https://github.com/advisories/GHSA-v39h-62p7-jpjc", title: "fast-uri host confusion", severity: "high", vulnerable_versions: "<=3.1.1" },
      ],
      hono: [
        { id: 1117915, url: "https://github.com/advisories/GHSA-qp7p-654g-cw7p", title: "Hono CSS injection", severity: "moderate" },
      ],
    }),
  ].join("\n");

  it("extracts every advisory across packages, skipping the banner", () => {
    const findings = parseBunAuditJson(bunOutput);
    expect(findings.length).toBe(2);
    const byPkg = Object.fromEntries(findings.map((f) => [f.package, f]));
    expect(byPkg["fast-uri"].severity).toBe("high");
    expect(byPkg["fast-uri"].title).toContain("host confusion");
    expect(byPkg.hono.severity).toBe("moderate");
  });

  it("returns [] for empty/no-vuln output without throwing", () => {
    expect(parseBunAuditJson("bun audit v1.3.10\n{}")).toEqual([]);
    expect(parseBunAuditJson("")).toEqual([]);
  });
});

describe("entropy: hex and base64 secrets must clear the charset-scaled floor", () => {
  const cfg = { enabled: true as const, severity: "fail" as const };

  // Neutral variable names so the named generic patterns (password/secret/
  // token/api_key) don't fire and suppress the entropy path we're exercising.
  it("flags a long high-entropy hex token (default 4.8 could never fire on hex)", async () => {
    const res = await checkSecrets(
      [file("k.ts", 'const blob = "a3f5c8e1b2d4906f7a8c5e3b1d9f02468ace1357";')],
      cfg,
    );
    expect(entropyFindings(res.details).length).toBeGreaterThan(0);
  });

  it("flags an AWS-secret-shaped base64 token (~4.71, under the old 4.8 floor)", async () => {
    const res = await checkSecrets(
      [file("k.ts", 'const blob = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";')],
      cfg,
    );
    expect(entropyFindings(res.details).length).toBeGreaterThan(0);
  });

  it("does NOT flag a low-entropy long hex string (repeated chars)", async () => {
    const res = await checkSecrets(
      [file("k.ts", 'const x = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";')],
      cfg,
    );
    expect(entropyFindings(res.details).length).toBe(0);
  });
});

describe("file_patterns: default artifact globs catch nested monorepo copies", () => {
  it("blocks a dist/ file nested under a sub-package", async () => {
    const res = await checkFilePatterns(
      [file("packages/app/dist/bundle.js", "console.log(1)")],
      { enabled: true, severity: "fail" },
    );
    expect(res.status).toBe("fail");
  });

  it("blocks nested node_modules and .next artifacts too", async () => {
    const res = await checkFilePatterns(
      [
        file("apps/web/node_modules/dep/index.js", "x"),
        file("services/api/.next/cache/x", "y"),
      ],
      { enabled: true, severity: "fail" },
    );
    expect((res.details.count as number)).toBeGreaterThanOrEqual(2);
  });

  it("does not flag a legitimately-named file that merely contains 'dist'", async () => {
    const res = await checkFilePatterns(
      [file("src/redistribute.ts", "export const x = 1")],
      { enabled: true, severity: "fail" },
    );
    expect(res.status).toBe("pass");
  });
});
