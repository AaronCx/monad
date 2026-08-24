import { describe, expect, test } from "bun:test";
import type { ReviewReport } from "@aaroncx/protocol";
import { parseChecksFlags } from "../src/checks.ts";
import { parseGcFlags, parseOlderThanDays } from "../src/gc.ts";
import { ghBin, parsePrArg } from "../src/gh.ts";
import { formatReviewReport, parseReviewFlags, reviewExitCode } from "../src/review.ts";

/**
 * Flag parsing and exit-code mapping for the M2 commands. These are the
 * decisions a user feels immediately (a typo'd flag, a wrong exit code in a
 * hook or in CI), so they are unit tested away from the daemon.
 */

describe("parseReviewFlags", () => {
  test("takes a bare PR number with no flags", () => {
    expect(parseReviewFlags(["42"])).toEqual({
      pr: "42",
      full: false,
      post: false,
      fix: false,
      noInstall: false,
      backend: "claude-acp",
    });
  });

  test("takes a URL and every flag", () => {
    const flags = parseReviewFlags([
      "https://github.com/AaronCx/monad/pull/7",
      "--full",
      "--post",
      "--fix",
      "--no-install",
      "--backend",
      "claude",
    ]);
    expect(flags.pr).toBe("https://github.com/AaronCx/monad/pull/7");
    expect(flags.full).toBe(true);
    expect(flags.post).toBe(true);
    expect(flags.fix).toBe(true);
    expect(flags.noInstall).toBe(true);
    expect(flags.backend).toBe("claude-acp");
  });

  test("rejects a missing PR, an unknown flag, a second PR, and another backend", () => {
    expect(() => parseReviewFlags([])).toThrow("needs a PR number or URL");
    expect(() => parseReviewFlags(["1", "--deep"])).toThrow("unknown flag --deep");
    expect(() => parseReviewFlags(["1", "2"])).toThrow("takes one PR");
    expect(() => parseReviewFlags(["1", "--backend", "codex"])).toThrow("M2 ships claude only");
    expect(() => parseReviewFlags(["1", "--backend"])).toThrow("--backend needs a value");
  });
});

describe("parsePrArg", () => {
  test("a bare number stays repo-relative; a URL carries its repo", () => {
    expect(parsePrArg("42")).toEqual({ number: 42 });
    expect(parsePrArg("https://github.com/AaronCx/monad/pull/7")).toEqual({
      number: 7,
      repo: "AaronCx/monad",
    });
    expect(parsePrArg("https://github.com/AaronCx/monad/pull/7/files")).toEqual({
      number: 7,
      repo: "AaronCx/monad",
    });
  });

  test("rejects anything else", () => {
    expect(() => parsePrArg("main")).toThrow("cannot parse main");
    expect(() => parsePrArg("0")).toThrow("cannot parse 0");
  });
});

describe("ghBin", () => {
  test("MONAD_GH_BIN overrides the binary", () => {
    expect(ghBin({})).toBe("gh");
    expect(ghBin({ MONAD_GH_BIN: "  " })).toBe("gh");
    expect(ghBin({ MONAD_GH_BIN: "/tmp/fake-gh" })).toBe("/tmp/fake-gh");
  });
});

const REPORT: ReviewReport = {
  summary: "Looks fine.",
  verdict: "comment",
  checks_acknowledged: true,
  findings: [
    { path: "a.ts", line: 3, severity: "high", title: "unchecked index", body: "guard it" },
    { path: "b.ts", severity: "nit", title: "stray space", body: "trim it" },
  ],
};

describe("reviewExitCode", () => {
  test("0 for looks_good and comment with no failing check", () => {
    for (const verdict of ["looks_good", "comment"] as const) {
      expect(
        reviewExitCode({
          structured: true,
          report: { ...REPORT, verdict },
          checksFailed: false,
        }),
      ).toBe(0);
    }
  });

  test("1 for needs_changes, for a failing check, and for an unstructured report", () => {
    expect(
      reviewExitCode({
        structured: true,
        report: { ...REPORT, verdict: "needs_changes" },
        checksFailed: false,
      }),
    ).toBe(1);
    expect(reviewExitCode({ structured: true, report: REPORT, checksFailed: true })).toBe(1);
    expect(
      reviewExitCode({
        structured: false,
        report: { structured: false, raw: "no json block here" },
        checksFailed: false,
      }),
    ).toBe(1);
  });
});

describe("formatReviewReport", () => {
  test("summary, verdict, findings grouped by severity, then the checks table", () => {
    const printed = formatReviewReport(REPORT, "| check | status | findings |");
    expect(printed.indexOf("Looks fine.")).toBeLessThan(printed.indexOf("verdict: comment"));
    expect(printed.indexOf("high (1):")).toBeLessThan(printed.indexOf("nit (1):"));
    expect(printed).toContain("unchecked index (a.ts:3)");
    // A finding with no line prints the bare path.
    expect(printed).toContain("stray space (b.ts)");
    expect(printed.indexOf("| check | status | findings |")).toBeGreaterThan(
      printed.indexOf("nit (1):"),
    );
  });

  test("an unstructured report prints the raw text instead of pretending", () => {
    const printed = formatReviewReport({ structured: false, raw: "I forgot the json." }, "table");
    expect(printed).toContain("no parsable ReviewReport json block");
    expect(printed).toContain("I forgot the json.");
  });
});

describe("parseChecksFlags", () => {
  test("defaults to a base-branch run", () => {
    expect(parseChecksFlags([])).toEqual({ staged: false, full: false, json: false });
  });

  test("takes --staged, --base, --only, --full, --json", () => {
    expect(parseChecksFlags(["--staged", "--json"])).toMatchObject({ staged: true, json: true });
    expect(parseChecksFlags(["--base", "origin/main", "--full"])).toMatchObject({
      base: "origin/main",
      full: true,
    });
    expect(parseChecksFlags(["--only", "secrets, lint"]).only).toEqual(["secrets", "lint"]);
  });

  test("rejects a bad check name, a missing value, and --staged with --base", () => {
    expect(() => parseChecksFlags(["--only", "semantic"])).toThrow("unknown check semantic");
    expect(() => parseChecksFlags(["--base"])).toThrow("--base needs a ref");
    expect(() => parseChecksFlags(["--staged", "--base", "main"])).toThrow(
      "mutually exclusive",
    );
    expect(() => parseChecksFlags(["--fix"])).toThrow("unknown flag --fix");
  });
});

describe("parseOlderThanDays", () => {
  test("days, hours, and minutes", () => {
    expect(parseOlderThanDays("7d")).toBe(7);
    expect(parseOlderThanDays("12")).toBe(12);
    expect(parseOlderThanDays("12h")).toBeCloseTo(0.5, 10);
    expect(parseOlderThanDays("30m")).toBeCloseTo(30 / 1440, 10);
  });

  test("rejects junk", () => {
    expect(() => parseOlderThanDays("soon")).toThrow("cannot parse soon");
    expect(() => parseOlderThanDays("-1d")).toThrow("cannot parse -1d");
  });

  test("gc defaults to 7 days", () => {
    expect(parseGcFlags([])).toEqual({ olderThanDays: 7 });
    expect(parseGcFlags(["--older-than", "1d"])).toEqual({ olderThanDays: 1 });
    expect(() => parseGcFlags(["--older-than"])).toThrow("needs a duration");
    expect(() => parseGcFlags(["--all"])).toThrow("unknown flag --all");
  });
});
