import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile } from "@aaroncx/checks";
import type { ReviewReport } from "@aaroncx/protocol";
import {
  anchorableLines,
  buildReviewPayload,
  planReviewPost,
  postReview,
  reviewMarker,
} from "../src/post.ts";

/**
 * monad review --post against a recording gh (MONAD_GH_BIN). No network, no
 * GitHub auth: the fixture script answers the reviews listing and stores what
 * was posted, so the same-head second run really goes through the
 * idempotence path.
 */

const FAKE_GH = new URL("./fixtures/fake-gh.ts", import.meta.url).pathname;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "+const added = 2;",
  " const c = 3;",
  "-const removed = 4;",
  " const d = 5;",
  "",
].join("\n");

const FILES: ChangedFile[] = [
  { path: "src/a.ts", status: "modified", content: "", patch: PATCH },
];

const REPORT: ReviewReport = {
  summary: "Two real problems and one style note.",
  verdict: "needs_changes",
  checks_acknowledged: true,
  findings: [
    {
      path: "src/a.ts",
      line: 2,
      severity: "high",
      title: "added is never used",
      body: "Drop it or use it.",
      suggestion: "const added = compute();",
    },
    {
      path: "src/a.ts",
      line: 3,
      severity: "low",
      title: "prefer a named constant",
      body: "Multi-line suggestions cannot be a suggestion block.",
      suggestion: "const c = 3;\nconst e = 4;",
    },
    {
      path: "src/a.ts",
      line: 99,
      severity: "medium",
      title: "line is outside the diff",
      body: "Nothing to anchor to on line 99.",
    },
    {
      path: "docs/untouched.md",
      severity: "nit",
      title: "file is not in the diff",
      body: "This finding has no anchor at all.",
    },
  ],
};

const CHECKS_TABLE = ["| check | status | findings |", "| --- | --- | --- |", "| Secrets | pass | 0 |"].join(
  "\n",
);

describe("anchorableLines", () => {
  test("counts added and context lines on the right side only", () => {
    expect([...anchorableLines(PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test("a patch with no hunk header anchors nothing", () => {
    expect(anchorableLines("diff --git a/x b/x\nnew file mode 100644\n").size).toBe(0);
  });

  test("a second hunk restarts at its own right-side offset", () => {
    const patch = ["@@ -1,1 +1,1 @@", " one", "@@ -40,2 +41,2 @@", " forty one", "+forty two", ""].join(
      "\n",
    );
    expect([...anchorableLines(patch)].sort((a, b) => a - b)).toEqual([1, 41, 42]);
  });
});

describe("planReviewPost", () => {
  test("anchors only findings whose path and line are in the diff", () => {
    const plan = planReviewPost(REPORT, FILES);
    expect(plan.comments.map((comment) => `${comment.path}:${comment.line}`)).toEqual([
      "src/a.ts:2",
      "src/a.ts:3",
    ]);
    expect(plan.comments.every((comment) => comment.side === "RIGHT")).toBe(true);
    expect(plan.unanchored.map((finding) => finding.title)).toEqual([
      "line is outside the diff",
      "file is not in the diff",
    ]);
  });

  test("a single-line suggestion becomes a suggestion block, a multi-line one does not", () => {
    const plan = planReviewPost(REPORT, FILES);
    expect(plan.comments[0]?.body).toContain("```suggestion\nconst added = compute();\n```");
    expect(plan.comments[0]?.body).toContain("**added is never used** (high)");
    expect(plan.comments[1]?.body).not.toContain("```suggestion");
  });
});

describe("buildReviewPayload", () => {
  const payload = buildReviewPayload({
    report: REPORT,
    files: FILES,
    checksTable: CHECKS_TABLE,
    headSha: HEAD_SHA,
  });

  test("is a COMMENT review pinned to the head sha", () => {
    expect(payload.commit_id).toBe(HEAD_SHA);
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(2);
  });

  test("the body carries the summary, verdict, checks table, and the marker", () => {
    expect(payload.body).toContain(REPORT.summary);
    expect(payload.body).toContain("**Verdict:** needs_changes");
    expect(payload.body).toContain(CHECKS_TABLE);
    expect(payload.body).toContain(reviewMarker(HEAD_SHA));
  });

  test("unanchorable findings land in the body, anchored ones do not", () => {
    expect(payload.body).toContain("line is outside the diff");
    expect(payload.body).toContain("docs/untouched.md");
    expect(payload.body).toContain("src/a.ts:99");
    expect(payload.body).not.toContain("added is never used");
  });
});

describe("postReview through MONAD_GH_BIN", () => {
  let dir: string;

  beforeAll(() => {
    chmodSync(FAKE_GH, 0o755);
    dir = mkdtempSync(join(tmpdir(), "monad-fake-gh-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function calls(): Array<{ args: string[]; stdin: string }> {
    const raw = readFileSync(join(dir, "calls.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
  }

  const input = {
    get env() {
      return { ...process.env, FAKE_GH_DIR: dir };
    },
    bin: FAKE_GH,
    repo: "example/fixture",
    number: 7,
    headSha: HEAD_SHA,
    report: REPORT,
    files: FILES,
    checksTable: CHECKS_TABLE,
  };

  test("posts one COMMENT review with the anchored comments", async () => {
    const outcome = await postReview(input);
    expect(outcome.posted).toBe(true);
    expect(outcome.comments).toBe(2);
    expect(outcome.unanchored).toBe(2);

    const recorded = calls();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.args).toEqual([
      "api",
      "repos/example/fixture/pulls/7/reviews",
      "--paginate",
    ]);
    expect(recorded[1]?.args).toEqual([
      "api",
      "repos/example/fixture/pulls/7/reviews",
      "-X",
      "POST",
      "--input",
      "-",
    ]);

    const payload = JSON.parse(recorded[1]?.stdin ?? "{}") as {
      commit_id: string;
      event: string;
      body: string;
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    };
    expect(payload.commit_id).toBe(HEAD_SHA);
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "RIGHT" });
    expect(payload.body).toContain("file is not in the diff");
    expect(payload.body).toContain(reviewMarker(HEAD_SHA));
  });

  test("a second run against the same head posts nothing", async () => {
    const outcome = await postReview(input);
    expect(outcome.posted).toBe(false);
    expect(outcome.reason).toContain("already has a monad review");
    // Only the listing call was added; no second POST.
    const recorded = calls();
    expect(recorded).toHaveLength(3);
    expect(recorded[2]?.args).toContain("--paginate");
    expect(recorded.filter((call) => call.args.includes("POST"))).toHaveLength(1);
  });

  test("a different head sha posts again", async () => {
    const other = `${HEAD_SHA.slice(0, 39)}f`;
    const outcome = await postReview({ ...input, headSha: other });
    expect(outcome.posted).toBe(true);
    const recorded = calls();
    expect(recorded.filter((call) => call.args.includes("POST"))).toHaveLength(2);
  });
});
