import type { ChangedFile } from "@aaroncx/checks";
import type { ReviewFinding, ReviewReport, ReviewSeverity } from "@aaroncx/protocol";
import { runGh } from "./gh.ts";

/**
 * monad review --post: one COMMENT review through the caller's own gh auth.
 *
 * M2 never posts APPROVE or REQUEST_CHANGES; the GitHub App with Check Runs
 * is M3's job. Findings that anchor to the PR diff become inline review
 * comments; everything else is folded into the review body next to the
 * summary, the verdict, and the checks table. The body carries an HTML
 * comment naming the head sha, so a second run against the same head finds
 * its own marker and posts nothing.
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

/** A single-line suggestion renders as a GitHub suggestion block. */
function suggestionBlock(finding: ReviewFinding): string | undefined {
  const suggestion = finding.suggestion?.replace(/\n+$/, "");
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
  const suggestion = finding.suggestion?.replace(/\n+$/, "");
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
  sections.push(reviewMarker(input.headSha));
  return sections.join("\n\n");
}

export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}

export interface BuildPayloadInput {
  report: ReviewReport;
  files: ChangedFile[];
  checksTable: string;
  headSha: string;
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
    }),
    comments: plan.comments,
  };
}

interface ExistingReview {
  body?: string;
}

/**
 * True when the PR already carries a monad review for this head sha. The
 * marker is monad's own, so a human review quoting the body cannot be
 * mistaken for one (they would have to reproduce the comment verbatim).
 */
export async function hasMonadReviewForHead(input: {
  bin: string;
  repo: string;
  number: number;
  headSha: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const raw = await runGh(
    input.bin,
    ["api", `repos/${input.repo}/pulls/${input.number}/reviews`, "--paginate"],
    { cwd: input.cwd, env: input.env },
  );
  let reviews: unknown;
  try {
    reviews = JSON.parse(raw);
  } catch {
    throw new Error(`could not parse the existing reviews of ${input.repo}#${input.number}`);
  }
  if (!Array.isArray(reviews)) {
    return false;
  }
  const marker = reviewMarker(input.headSha);
  return (reviews as ExistingReview[]).some((review) => review.body?.includes(marker) === true);
}

export interface PostReviewInput {
  bin: string;
  repo: string;
  number: number;
  headSha: string;
  report: ReviewReport;
  files: ChangedFile[];
  checksTable: string;
  cwd?: string;
  /** Child environment for gh; omitted means inherit (tests point it at a recorder). */
  env?: Record<string, string | undefined>;
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
export async function postReview(input: PostReviewInput): Promise<PostReviewResult> {
  const payload = buildReviewPayload({
    report: input.report,
    files: input.files,
    checksTable: input.checksTable,
    headSha: input.headSha,
  });
  const already = await hasMonadReviewForHead({
    bin: input.bin,
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
    cwd: input.cwd,
    env: input.env,
  });
  if (already) {
    return {
      posted: false,
      reason: `${input.repo}#${input.number} already has a monad review for head ${input.headSha}`,
      comments: payload.comments.length,
      unanchored: input.report.findings.length - payload.comments.length,
    };
  }
  await runGh(
    input.bin,
    ["api", `repos/${input.repo}/pulls/${input.number}/reviews`, "-X", "POST", "--input", "-"],
    { cwd: input.cwd, stdin: JSON.stringify(payload), env: input.env },
  );
  return {
    posted: true,
    comments: payload.comments.length,
    unanchored: input.report.findings.length - payload.comments.length,
  };
}
