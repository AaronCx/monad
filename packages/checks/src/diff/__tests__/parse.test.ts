import { describe, test, expect } from "bun:test";
import { parseAddedLines } from "../parse";

const patch = (s: string) => s.replace(/^\n/, "");

describe("parseAddedLines", () => {
  test("returns [] for empty input", () => {
    expect(parseAddedLines("")).toEqual([]);
  });

  test("single hunk: emits + lines only, with real new-file line numbers", () => {
    const p = patch(`
diff --git a/src/x.ts b/src/x.ts
index abc..def 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,4 @@
 keep one
-removed
+added two
 keep three
+added four
`);
    expect(parseAddedLines(p)).toEqual([
      { lineNo: 2, text: "added two" },
      { lineNo: 4, text: "added four" },
    ]);
  });

  test("multiple hunks: each header resets the new-file counter", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,2 @@
 first
+added at 2
@@ -10,1 +11,2 @@
 tenth
+added at 12
`);
    expect(parseAddedLines(p)).toEqual([
      { lineNo: 2, text: "added at 2" },
      { lineNo: 12, text: "added at 12" },
    ]);
  });

  test("removals only: no added lines means empty result", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,1 @@
 keep
-gone
-also gone
`);
    expect(parseAddedLines(p)).toEqual([]);
  });

  test("added at EOF with the No-newline sentinel does not affect line numbers", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,2 @@
 first
+last line
\\ No newline at end of file
`);
    expect(parseAddedLines(p)).toEqual([{ lineNo: 2, text: "last line" }]);
  });

  test("renames with content changes: hunks still drive the counter", () => {
    const p = patch(`
diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
-old line one
+new line one
 unchanged
`);
    expect(parseAddedLines(p)).toEqual([{ lineNo: 1, text: "new line one" }]);
  });

  test("metadata lines (index/@@/+++/---) never appear as findings", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
index 7a3f..9c2e 100644
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,3 @@
 first
+the only added line
 second
`);
    const result = parseAddedLines(p);
    expect(result.length).toBe(1);
    for (const r of result) {
      expect(r.text).not.toMatch(/^(diff --git|index |[+-]{3} |@@)/);
    }
  });

  test("two files in one patch: counter resets at each new diff", () => {
    const p = patch(`
diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 keep
+from-a at 2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,2 @@
 keep
+from-b at 6
`);
    expect(parseAddedLines(p)).toEqual([
      { lineNo: 2, text: "from-a at 2" },
      { lineNo: 6, text: "from-b at 6" },
    ]);
  });

  test("blank added line is preserved with correct line number", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,3 @@
 keep
+
+after blank
`);
    expect(parseAddedLines(p)).toEqual([
      { lineNo: 2, text: "" },
      { lineNo: 3, text: "after blank" },
    ]);
  });

  test("contiguous - and + lines: + counter advances correctly past the - block", () => {
    const p = patch(`
diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,4 +1,4 @@
 keep one
-removed one
-removed two
+added one
+added two
 keep four
`);
    expect(parseAddedLines(p)).toEqual([
      { lineNo: 2, text: "added one" },
      { lineNo: 3, text: "added two" },
    ]);
  });
});
