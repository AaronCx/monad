import { describe, test, expect } from "bun:test";
import { isPathAllowed, isLineIgnored, fingerprint } from "../allowlist";

describe("isPathAllowed", () => {
  test("returns false when globs empty/missing", () => {
    expect(isPathAllowed("src/x.ts", undefined)).toBe(false);
    expect(isPathAllowed("src/x.ts", [])).toBe(false);
  });

  test("matches **/*.example", () => {
    expect(isPathAllowed("config.example", ["**/*.example"])).toBe(true);
    expect(isPathAllowed("apps/web/.env.example", ["**/*.example"])).toBe(true);
    expect(isPathAllowed("config.json", ["**/*.example"])).toBe(false);
  });

  test("matches **/fixtures/**", () => {
    expect(isPathAllowed("fixtures/seeds.json", ["**/fixtures/**"])).toBe(true);
    expect(isPathAllowed("a/b/fixtures/c/d.ts", ["**/fixtures/**"])).toBe(true);
    expect(isPathAllowed("src/lib.ts", ["**/fixtures/**"])).toBe(false);
  });

  test("matches plain basename without slash", () => {
    expect(isPathAllowed("apps/web/package-lock.json", ["package-lock.json"])).toBe(true);
    expect(isPathAllowed("package-lock.json", ["package-lock.json"])).toBe(true);
  });

  test("matches **/*.test.ts", () => {
    expect(isPathAllowed("packages/engine/src/foo.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(isPathAllowed("packages/engine/src/foo.ts", ["**/*.test.ts"])).toBe(false);
  });
});

describe("isLineIgnored", () => {
  test("same-line // lastgate-ignore suppresses", () => {
    const lines = ['const key = "sk-foo"; // lastgate-ignore'];
    expect(isLineIgnored(1, lines)).toBe(true);
  });

  test("same-line # lastgate-ignore suppresses (Python/YAML)", () => {
    const lines = ['SECRET = "abc" # lastgate-ignore'];
    expect(isLineIgnored(1, lines)).toBe(true);
  });

  test("same-line -- lastgate-ignore suppresses (SQL)", () => {
    const lines = ["SELECT 'token' -- lastgate-ignore"];
    expect(isLineIgnored(1, lines)).toBe(true);
  });

  test("preceding // lastgate-ignore-next-line suppresses", () => {
    const lines = [
      "// lastgate-ignore-next-line",
      'const key = "sk-foo";',
    ];
    expect(isLineIgnored(2, lines)).toBe(true);
  });

  test("preceding ignore-next-line does NOT leak past one line", () => {
    const lines = [
      "// lastgate-ignore-next-line",
      "neutral line",
      'const key = "sk-foo";',
    ];
    expect(isLineIgnored(3, lines)).toBe(false);
  });

  test("unrelated comment does not suppress", () => {
    const lines = ['// some normal comment', 'const key = "sk-foo";'];
    expect(isLineIgnored(2, lines)).toBe(false);
  });

  test("falls back to sameLineText when content not provided", () => {
    expect(isLineIgnored(42, [], 'const k="x"; // lastgate-ignore')).toBe(true);
    expect(isLineIgnored(42, [], 'const k="x";')).toBe(false);
  });
});

describe("fingerprint", () => {
  test("stable for the same inputs", () => {
    const a = fingerprint({ check: "secrets", file: "src/x.ts", rule: "AWS", redactedMatch: "AK***DEF" });
    const b = fingerprint({ check: "secrets", file: "src/x.ts", rule: "AWS", redactedMatch: "AK***DEF" });
    expect(a).toBe(b);
  });

  test("different across file/rule/match", () => {
    const base = fingerprint({ check: "secrets", file: "src/x.ts", rule: "AWS", redactedMatch: "AK***DEF" });
    const f1 = fingerprint({ check: "secrets", file: "src/y.ts", rule: "AWS", redactedMatch: "AK***DEF" });
    const f2 = fingerprint({ check: "secrets", file: "src/x.ts", rule: "GitHub", redactedMatch: "AK***DEF" });
    const f3 = fingerprint({ check: "secrets", file: "src/x.ts", rule: "AWS", redactedMatch: "AK***ZZZ" });
    expect(f1).not.toBe(base);
    expect(f2).not.toBe(base);
    expect(f3).not.toBe(base);
  });

  test("redactedMatch optional", () => {
    expect(fingerprint({ check: "secrets", file: "src/x.ts", rule: "AWS" })).toMatch(/^[a-f0-9]{16}$/);
  });
});
