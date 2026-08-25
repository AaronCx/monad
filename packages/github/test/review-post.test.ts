import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "@aaroncx/checks";
import type { ReviewReport } from "@aaroncx/protocol";
import {
  anchorableLines,
  buildReviewPayload,
  hasMonadReviewForHead,
  octokitReviewTransport,
  planReviewPost,
  postReview,
  reviewMarker,
  stripTrailingNewlines,
} from "../src/review-post.ts";
import { fakeOctokit } from "./fixtures/fake-octokit.ts";

/**
 * The review-post logic moved down from apps/cli, so the anchoring cases
 * here mirror apps/cli/test/post.test.ts deliberately: if the move changed
 * behavior, both files fail rather than one silently drifting. What is new
 * is the App's transport, faked at the request layer.
 */

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

const FILES: ChangedFile[] = [{ path: "src/a.ts", status: "modified", content: "", patch: PATCH }];

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
      line: 99,
      severity: "medium",
      title: "line is outside the diff",
      body: "Nothing to anchor to on line 99.",
    },
  ],
};

const CHECKS_TABLE = ["| check | status | findings |", "| --- | --- | --- |"].join("\n");

const INPUT = {
  repo: "AaronCx/monad-review-demo",
  number: 7,
  headSha: HEAD_SHA,
  report: REPORT,
  files: FILES,
  checksTable: CHECKS_TABLE,
};

describe("the shared anchoring still behaves as it did in apps/cli", () => {
  test("counts added and context lines on the right side only", () => {
    expect([...anchorableLines(PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test("anchors only findings whose path and line are in the diff", () => {
    const plan = planReviewPost(REPORT, FILES);
    expect(plan.comments.map((comment) => `${comment.path}:${comment.line}`)).toEqual(["src/a.ts:2"]);
    expect(plan.unanchored.map((finding) => finding.title)).toEqual(["line is outside the diff"]);
  });

  test("the payload is a COMMENT review pinned to the head sha", () => {
    const payload = buildReviewPayload({ ...INPUT });
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe(HEAD_SHA);
    expect(payload.body).toContain(reviewMarker(HEAD_SHA));
    expect(payload.body).toContain("**Verdict:** needs_changes");
  });

  test("the session footer is opt in, so the CLI's body is byte identical to before", () => {
    expect(buildReviewPayload({ ...INPUT }).body).not.toContain("monad attach");
    expect(buildReviewPayload({ ...INPUT, sessionId: "s-9" }).body).toContain("monad attach s-9");
  });

  test("the footer sits above the marker, so the marker stays last", () => {
    const body = buildReviewPayload({ ...INPUT, sessionId: "s-9" }).body;
    expect(body.trimEnd().endsWith(reviewMarker(HEAD_SHA))).toBe(true);
  });
});

describe("octokitReviewTransport", () => {
  test("lists reviews through the reviews route, one page when it is short", async () => {
    const fake = fakeOctokit(() => ({ status: 200, data: [] }));
    const transport = octokitReviewTransport(fake.octokit);
    expect(await transport.listReviews({ repo: "AaronCx/monad", number: 7 })).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.route).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
    expect(fake.calls[0]?.params).toEqual({
      owner: "AaronCx",
      repo: "monad",
      pull_number: 7,
      per_page: 100,
      page: 1,
    });
  });

  test("a full page is followed by the next one", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ body: `review ${index}` })),
      [{ body: "review 100" }],
    ];
    let served = 0;
    const fake = fakeOctokit(() => ({ status: 200, data: pages[served++] ?? [] }));
    const reviews = await octokitReviewTransport(fake.octokit).listReviews({
      repo: "AaronCx/monad",
      number: 7,
    });
    expect(reviews).toHaveLength(101);
    expect(fake.calls.map((call) => call.params.page)).toEqual([1, 2]);
  });

  test("a repo that is not owner/name is refused before any request", async () => {
    const fake = fakeOctokit();
    await expect(
      octokitReviewTransport(fake.octokit).listReviews({ repo: "monad", number: 7 }),
    ).rejects.toThrow("monad is not an owner/name repository");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("postReview through the App's transport", () => {
  test("posts one COMMENT review with the anchored comments", async () => {
    const fake = fakeOctokit((route) =>
      route.startsWith("GET") ? { status: 200, data: [] } : undefined,
    );
    const outcome = await postReview(octokitReviewTransport(fake.octokit), {
      ...INPUT,
      sessionId: "s-1",
    });

    expect(outcome).toEqual({ posted: true, comments: 1, unanchored: 1 });
    expect(fake.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    ]);

    const posted = fake.calls[1]?.params as {
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      event: string;
      body: string;
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    };
    expect(posted.owner).toBe("AaronCx");
    expect(posted.repo).toBe("monad-review-demo");
    expect(posted.pull_number).toBe(7);
    expect(posted.commit_id).toBe(HEAD_SHA);
    expect(posted.event).toBe("COMMENT");
    expect(posted.comments).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        side: "RIGHT",
        body: expect.stringContaining("**added is never used** (high)"),
      },
    ]);
    expect(posted.body).toContain("line is outside the diff");
    expect(posted.body).toContain("monad attach s-1");
  });

  test("a second run against the same head posts nothing", async () => {
    const stored: Array<{ body: string }> = [];
    const fake = fakeOctokit((route, params) => {
      if (route.startsWith("GET")) {
        return { status: 200, data: [...stored] };
      }
      stored.push({ body: params.body as string });
      return { status: 200, data: { id: stored.length } };
    });
    const transport = octokitReviewTransport(fake.octokit);

    expect((await postReview(transport, INPUT)).posted).toBe(true);
    const second = await postReview(transport, INPUT);
    expect(second.posted).toBe(false);
    expect(second.reason).toContain("already has a monad review");
    expect(fake.matching("POST")).toHaveLength(1);
  });

  test("a different head sha posts again", async () => {
    const stored: Array<{ body: string }> = [];
    const fake = fakeOctokit((route, params) => {
      if (route.startsWith("GET")) {
        return { status: 200, data: [...stored] };
      }
      stored.push({ body: params.body as string });
      return { status: 200, data: { id: stored.length } };
    });
    const transport = octokitReviewTransport(fake.octokit);

    await postReview(transport, INPUT);
    const other = `${HEAD_SHA.slice(0, 39)}f`;
    expect((await postReview(transport, { ...INPUT, headSha: other })).posted).toBe(true);
    expect(fake.matching("POST")).toHaveLength(2);
  });

  test("hasMonadReviewForHead only matches monad's own marker", async () => {
    const fake = fakeOctokit(() => ({
      status: 200,
      data: [{ body: "looks good to me" }, { body: `nice\n\n${reviewMarker(HEAD_SHA)}` }],
    }));
    const transport = octokitReviewTransport(fake.octokit);
    expect(
      await hasMonadReviewForHead(transport, {
        repo: "AaronCx/monad",
        number: 7,
        headSha: HEAD_SHA,
      }),
    ).toBe(true);
    expect(
      await hasMonadReviewForHead(transport, {
        repo: "AaronCx/monad",
        number: 7,
        headSha: `${HEAD_SHA.slice(0, 39)}f`,
      }),
    ).toBe(false);
  });

  test("a transport that is not the App's works just as well, which is the point", async () => {
    const posted: unknown[] = [];
    const outcome = await postReview(
      {
        listReviews: async () => [],
        createReview: async (input) => {
          posted.push(input.payload);
          return undefined;
        },
      },
      INPUT,
    );
    expect(outcome.posted).toBe(true);
    expect(posted).toHaveLength(1);
  });
});

describe("stripTrailingNewlines", () => {
  test("removes only the trailing run, and only newlines", () => {
    expect(stripTrailingNewlines("a\n\n\n")).toBe("a");
    expect(stripTrailingNewlines("a\nb\n")).toBe("a\nb");
    expect(stripTrailingNewlines("")).toBe("");
    expect(stripTrailingNewlines("\n\n")).toBe("");
    expect(stripTrailingNewlines("a  ")).toBe("a  ");
  });

  test("a suggestion that is all newlines and one character is linear, not polynomial", () => {
    // The regex this replaced (/\n+$/) backtracks from every offset on this
    // shape. The suggestion is written by a model that just read a
    // stranger's diff, so its length must not decide monad's runtime.
    const hostile = `${"\n".repeat(200_000)}x`;
    const started = performance.now();
    expect(stripTrailingNewlines(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
