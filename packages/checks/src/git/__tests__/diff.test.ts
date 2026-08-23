import { describe, test, expect } from "bun:test";

/**
 * Tests for parseNameStatus and parseDiffContent logic from diff.ts.
 *
 * We replicate the pure parsing functions here since they are not exported.
 * This validates the data transformation and ChangedFile contract.
 */

interface ChangedFile {
  path: string;
  content: string;
  patch?: string;
  status: "added" | "modified" | "removed" | "renamed";
}

function parseNameStatus(output: string): { status: string; path: string }[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...pathParts] = line.split("\t");
      return { status: status.trim(), path: pathParts.join("\t").trim() };
    });
}

function parseDiffContent(
  diffOutput: string,
  nameStatusEntries: { status: string; path: string }[]
): ChangedFile[] {
  const fileMap = new Map<string, string>();

  const fileChunks = diffOutput
    .split(/^diff --git /m)
    .filter((c) => c.length > 0);

  for (const chunk of fileChunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/m);
    if (headerMatch) {
      const filePath = headerMatch[2];
      fileMap.set(filePath, `diff --git ${chunk}`);
    }
  }

  return nameStatusEntries.map((entry) => {
    let status: ChangedFile["status"];
    switch (entry.status[0]) {
      case "A":
        status = "added";
        break;
      case "D":
        status = "removed";
        break;
      case "M":
        status = "modified";
        break;
      case "R":
        status = "renamed";
        break;
      default:
        status = "modified";
    }

    const patch = fileMap.get(entry.path) || "";

    return {
      path: entry.path,
      status,
      content: patch,
      patch,
    };
  });
}

describe("parseNameStatus", () => {
  test("parses single added file", () => {
    const output = "A\tsrc/newfile.ts\n";
    const entries = parseNameStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ status: "A", path: "src/newfile.ts" });
  });

  test("parses single modified file", () => {
    const output = "M\tsrc/existing.ts\n";
    const entries = parseNameStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ status: "M", path: "src/existing.ts" });
  });

  test("parses single deleted file", () => {
    const output = "D\told-file.ts\n";
    const entries = parseNameStatus(output);
    expect(entries[0]).toEqual({ status: "D", path: "old-file.ts" });
  });

  test("parses renamed file with similarity index", () => {
    const output = "R100\told-name.ts\tnew-name.ts\n";
    const entries = parseNameStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("R100");
    // path joins remaining tab parts
    expect(entries[0].path).toBe("old-name.ts\tnew-name.ts");
  });

  test("parses multiple files", () => {
    const output = "A\tfile1.ts\nM\tfile2.ts\nD\tfile3.ts\n";
    const entries = parseNameStatus(output);
    expect(entries).toHaveLength(3);
    expect(entries[0].status).toBe("A");
    expect(entries[1].status).toBe("M");
    expect(entries[2].status).toBe("D");
  });

  test("returns empty array for empty input", () => {
    const entries = parseNameStatus("");
    expect(entries).toHaveLength(0);
  });

  test("returns empty array for whitespace-only input", () => {
    const entries = parseNameStatus("  \n  ");
    expect(entries).toHaveLength(0);
  });

  test("handles paths with spaces", () => {
    const output = "M\tpath with spaces/file.ts\n";
    const entries = parseNameStatus(output);
    expect(entries[0].path).toBe("path with spaces/file.ts");
  });
});

describe("parseDiffContent", () => {
  test("maps A status to 'added'", () => {
    const entries = [{ status: "A", path: "new.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].status).toBe("added");
  });

  test("maps D status to 'removed'", () => {
    const entries = [{ status: "D", path: "old.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].status).toBe("removed");
  });

  test("maps M status to 'modified'", () => {
    const entries = [{ status: "M", path: "changed.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].status).toBe("modified");
  });

  test("maps R status to 'renamed'", () => {
    const entries = [{ status: "R100", path: "renamed.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].status).toBe("renamed");
  });

  test("maps unknown status to 'modified' (default)", () => {
    const entries = [{ status: "C", path: "copied.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].status).toBe("modified");
  });

  test("returns ChangedFile with correct shape", () => {
    const entries = [{ status: "A", path: "file.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0]).toHaveProperty("path");
    expect(result[0]).toHaveProperty("status");
    expect(result[0]).toHaveProperty("content");
    expect(result[0]).toHaveProperty("patch");
  });

  test("associates diff chunks with files by path", () => {
    const diffOutput = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1234567..abcdefg 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "+newline",
      " line3",
    ].join("\n");

    const entries = [{ status: "M", path: "src/foo.ts" }];
    const result = parseDiffContent(diffOutput, entries);

    expect(result[0].patch).toContain("diff --git");
    expect(result[0].patch).toContain("+newline");
    expect(result[0].content).toBe(result[0].patch!);
  });

  test("handles multiple files in diff output", () => {
    const diffOutput = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "--- /dev/null",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+added line",
    ].join("\n");

    const entries = [
      { status: "M", path: "a.ts" },
      { status: "A", path: "b.ts" },
    ];

    const result = parseDiffContent(diffOutput, entries);
    expect(result).toHaveLength(2);
    expect(result[0].patch).toContain("-old");
    expect(result[1].patch).toContain("+added line");
  });

  test("returns empty patch when file not found in diff output", () => {
    const entries = [{ status: "D", path: "deleted.ts" }];
    const result = parseDiffContent("", entries);
    expect(result[0].patch).toBe("");
    expect(result[0].content).toBe("");
  });

  test("content and patch are identical", () => {
    const diffOutput = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    const entries = [{ status: "M", path: "x.ts" }];
    const result = parseDiffContent(diffOutput, entries);
    expect(result[0].content).toBe(result[0].patch!);
  });
});

describe("status mapping exhaustiveness", () => {
  const statusMap: [string, ChangedFile["status"]][] = [
    ["A", "added"],
    ["D", "removed"],
    ["M", "modified"],
    ["R", "renamed"],
    ["R050", "renamed"],
    ["R100", "renamed"],
  ];

  for (const [gitStatus, expectedStatus] of statusMap) {
    test(`git status '${gitStatus}' maps to '${expectedStatus}'`, () => {
      const entries = [{ status: gitStatus, path: "file.ts" }];
      const result = parseDiffContent("", entries);
      expect(result[0].status).toBe(expectedStatus);
    });
  }
});
