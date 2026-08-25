import type { ChangedFile } from "@aaroncx/checks";
import type { ReviewFinding, ReviewReport, ReviewSeverity } from "@aaroncx/protocol";
import type { OctokitLike } from "./octokit.ts";
import { sessionFooter } from "./render.ts";

/**
 * One COMMENT review with inline comments, shared by the CLI and the App.
 *
 * This was apps/cli/src/post.ts. It moved down here whole rather than being
 * copied, because the App posts the same review the CLI does and two copies
 * of anchoring logic drift in exactly the way that produces a comment
 * attached to the wrong line. The only difference between the two callers is
 * the transport: the CLI shells out to gh with the human's own auth, the App
 * uses an installation token through Octokit. Everything above that line is
 * this file.
 *
 * COMMENT reviews only, and that is a type-level fact rather than a
 * convention: ReviewPayload.event is the literal "COMMENT", so an APPROVE or
 * a REQUEST_CHANGES does not compile at any construction site. The Check Run
 * conclusion is the signal that can gate a branch, and it does not claim a
 * human read the code.
 */

/** Marker prefix; the full marker embeds the head sha the review covered. */
export const REVIEW_MARKER_PREFIX = "<!-- monad-review head=";

export function reviewMarker(headSha: string): string {
  return `${REVIEW_MARKER_PREFIX}${headSha} -->`;
}

/**
 * Right-side line numbers a review comment can anchor to: the added and
 * context lines of a unified patch. Removed lines only exist on the left
 * side, so a finding pointing at one cannot be anchored with side RIGHT.
 */
export function anchorableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  const split = patch.split("\n");
  // A patch ending in a newline yields one trailing empty element that is not
  // a line of the file; an empty element anywhere else is an empty context line.
  const body = split.at(-1) === "" ? split.slice(0, -1) : split;
  for (const line of body) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      right = Number(hunk[1]);
      continue;
    }
    if (right === 0) {
      // Still in the file header (diff --git, ---, +++): no line numbers yet.
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ")) {
      lines.add(right);
      right += 1;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // A removal advances only the left side; "\ No newline" advances neither.
    } else if (line.length === 0) {
      // git emits a bare empty line for an empty context line.
      lines.add(right);
      right += 1;
    }
  }
  return lines;
}

/** path -> anchorable right-side lines, for every file in the diff. */
export function anchorMap(files: ChangedFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    map.set(file.path, file.patch ? anchorableLines(file.patch) : new Set<number>());
  }
  return map;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface PostPlan {
  comments: ReviewComment[];
  /** Findings with no path in the diff or no anchorable line; they go in the body. */
  unanchored: ReviewFinding[];
}

const SEVERITY_ORDER: ReviewSeverity[] = ["critical", "high", "medium", "low", "nit"];

/**
 * Trailing newlines off a suggestion, without a regex.
 *
 * `/\n+$/` is what this used to be, and an anchored `+` is polynomial: on a
 * suggestion that is thousands of newlines followed by one other character,
 * the engine retries the run from every offset. The suggestion is written by
 * a model that just read a stranger's diff, so it is exactly the input that
 * must not be able to choose how long monad spends on it. A backwards walk is
 * one pass over the tail and cannot backtrack at all.
 */
export function stripTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** A single-line suggestion renders as a GitHub suggestion block. */
function suggestionBlock(finding: ReviewFinding): string | undefined {
  const raw = finding.suggestion;
  const suggestion = raw === undefined ? undefined : stripTrailingNewlines(raw);
  if (suggestion === undefined || suggestion.length === 0 || suggestion.includes("\n")) {
    return undefined;
  }
  return ["```suggestion", suggestion, "```"].join("\n");
}

/** Title, severity, body, and the suggestion block when there is one. */
export function formatComment(finding: ReviewFinding): string {
  const parts = [`**${finding.title}** (${finding.severity})`, finding.body];
  const suggestion = suggestionBlock(finding);
  if (suggestion) {
    parts.push(suggestion);
  }
  return parts.join("\n\n");
}

/** Same content as an inline comment plus the location it could not anchor to. */
function formatUnanchoredFinding(finding: ReviewFinding): string {
  const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
  const parts = [`- **${finding.title}** (${finding.severity}, ${where})`, finding.body];
  const raw = finding.suggestion;
  const suggestion = raw === undefined ? undefined : stripTrailingNewlines(raw);
  if (suggestion !== undefined && suggestion.length > 0) {
    parts.push(["```", suggestion, "```"].join("\n"));
  }
  return parts.join("\n\n");
}

/** Splits the report's findings into inline comments and body leftovers. */
export function planReviewPost(report: ReviewReport, files: ChangedFile[]): PostPlan {
  const anchors = anchorMap(files);
  const comments: ReviewComment[] = [];
  const unanchored: ReviewFinding[] = [];
  for (const finding of report.findings) {
    const lines = anchors.get(finding.path);
    if (finding.line !== undefined && lines?.has(finding.line)) {
      comments.push({
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        body: formatComment(finding),
      });
    } else {
      unanchored.push(finding);
    }
  }
  return { comments, unanchored };
}

export interface ReviewBodyInput {
  report: ReviewReport;
  checksTable: string;
  headSha: string;
  unanchored: ReviewFinding[];
  /**
   * The App leaves the session open and names it so `monad attach <id>`
   * reaches it from a+Terminal. The CLI omits it: the human who ran the
   * command already has the id on their terminal.
   */
  sessionId?: string;
}

/** Summary, verdict, checks table, unanchorable findings, and the marker. */
export function formatReviewBody(input: ReviewBodyInput): string {
  const sections = [
    "## monad review",
    input.report.summary,
    `**Verdict:** ${input.report.verdict}`,
    "### Checks",
    input.checksTable,
  ];
  if (input.unanchored.length > 0) {
    const ordered = [...input.unanchored].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    sections.push(
      "### Findings not anchored to the diff",
      ordered.map(formatUnanchoredFinding).join("\n\n"),
    );
  }
  if (input.sessionId !== undefined) {
    sections.push(sessionFooter(input.sessionId));
  }
  sections.push(reviewMarker(input.headSha));
  return sections.join("\n\n");
}

/** The only review event monad posts. Never APPROVE, never REQUEST_CHANGES. */
export type ReviewEvent = "COMMENT";

type Assert<T extends true> = T;

/**
 * Compile-time statement of the guardrail: there is one review event and it
 * is COMMENT. Widening ReviewEvent fails here, which is a cheaper place to
 * notice than a PR that got approved by a bot.
 */
export type MonadOnlyEverComments = Assert<
  Exclude<ReviewEvent, "COMMENT"> extends never ? true : false
>;

export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export interface BuildPayloadInput {
  report: ReviewReport;
  files: ChangedFile[];
  checksTable: string;
  headSha: string;
  sessionId?: string;
}

/** The exact JSON body of POST /repos/<owner>/<repo>/pulls/<n>/reviews. */
export function buildReviewPayload(input: BuildPayloadInput): ReviewPayload {
  const plan = planReviewPost(input.report, input.files);
  return {
    commit_id: input.headSha,
    event: "COMMENT",
    body: formatReviewBody({
      report: input.report,
      checksTable: input.checksTable,
      headSha: input.headSha,
      unanchored: plan.unanchored,
      sessionId: input.sessionId,
    }),
    comments: plan.comments,
  };
}

export interface ExistingReview {
  body?: string;
}

/**
 * The one thing the CLI and the App do differently. The CLI's implementation
 * shells out to gh with the caller's auth (it lives in apps/cli, because
 * this package must not know about a gh binary); the App's is
 * octokitReviewTransport below.
 */
export interface ReviewTransport {
  /** Every existing review on the PR, all pages. */
  listReviews(input: { repo: string; number: number }): Promise<ExistingReview[]>;
  /** Posts one review. The payload is COMMENT by construction. */
  createReview(input: { repo: string; number: number; payload: ReviewPayload }): Promise<unknown>;
}

/**
 * True when the PR already carries a monad review for this head sha. The
 * marker is monad's own, so a human review quoting the body cannot be
 * mistaken for one (they would have to reproduce the comment verbatim).
 */
export async function hasMonadReviewForHead(
  transport: ReviewTransport,
  input: { repo: string; number: number; headSha: string },
): Promise<boolean> {
  const reviews = await transport.listReviews({ repo: input.repo, number: input.number });
  const marker = reviewMarker(input.headSha);
  return reviews.some((review) => review.body?.includes(marker) === true);
}

export interface PostReviewInput {
  repo: string;
  number: number;
  headSha: string;
  report: ReviewReport;
  files: ChangedFile[];
  checksTable: string;
  sessionId?: string;
}

export interface PostReviewResult {
  posted: boolean;
  /** Why nothing was posted, when posted is false. */
  reason?: string;
  comments: number;
  unanchored: number;
}

/**
 * Posts one COMMENT review, unless an identical-head monad review is already
 * there. Never APPROVE, never REQUEST_CHANGES.
 */
export async function postReview(
  transport: ReviewTransport,
  input: PostReviewInput,
): Promise<PostReviewResult> {
  const payload = buildReviewPayload({
    report: input.report,
    files: input.files,
    checksTable: input.checksTable,
    headSha: input.headSha,
    sessionId: input.sessionId,
  });
  const already = await hasMonadReviewForHead(transport, {
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
  });
  if (already) {
    return {
      posted: false,
      reason: `${input.repo}#${input.number} already has a monad review for head ${input.headSha}`,
      comments: payload.comments.length,
      unanchored: input.report.findings.length - payload.comments.length,
    };
  }
  await transport.createReview({ repo: input.repo, number: input.number, payload });
  return {
    posted: true,
    comments: payload.comments.length,
    unanchored: input.report.findings.length - payload.comments.length,
  };
}

/** GitHub's page size cap on the reviews listing. */
const REVIEWS_PAGE_SIZE = 100;

/** Refuses to page forever on a PR with an implausible review count. */
const REVIEWS_MAX_PAGES = 10;

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    throw new Error(`${repo} is not an owner/name repository`);
  }
  return { owner, name };
}

/**
 * The App's half of the transport: the same two calls through an
 * installation token. Paging is explicit rather than octokit.paginate so the
 * request layer is the only thing a test has to fake.
 */
export function octokitReviewTransport(octokit: OctokitLike): ReviewTransport {
  return {
    async listReviews(input): Promise<ExistingReview[]> {
      const { owner, name } = splitRepo(input.repo);
      const reviews: ExistingReview[] = [];
      for (let page = 1; page <= REVIEWS_MAX_PAGES; page += 1) {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner,
            repo: name,
            pull_number: input.number,
            per_page: REVIEWS_PAGE_SIZE,
            page,
          },
        );
        const batch = Array.isArray(response.data) ? (response.data as ExistingReview[]) : [];
        reviews.push(...batch);
        if (batch.length < REVIEWS_PAGE_SIZE) {
          break;
        }
      }
      return reviews;
    },
    async createReview(input): Promise<unknown> {
      const { owner, name } = splitRepo(input.repo);
      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo: name,
          pull_number: input.number,
          commit_id: input.payload.commit_id,
          event: input.payload.event,
          body: input.payload.body,
          comments: input.payload.comments,
        },
      );
      return response.data;
    },
  };
}
