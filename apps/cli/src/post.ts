import type { ChangedFile } from "@aaroncx/checks";
import {
  hasMonadReviewForHead as hasMonadReviewForHeadWith,
  postReview as postReviewWith,
  type ExistingReview,
  type PostReviewResult,
  type ReviewTransport,
} from "@aaroncx/github";
import type { ReviewReport } from "@aaroncx/protocol";
import { runGh } from "./gh.ts";

/**
 * monad review --post: one COMMENT review through the caller's own gh auth.
 *
 * The anchoring, the body, the payload, and the same-head idempotence check
 * live in @aaroncx/github, because the GitHub App posts the same review and
 * two copies of that logic drift. What is left here is the CLI's transport:
 * gh, with the human's own credentials and cwd, MONAD_GH_BIN overridable so
 * tests can point it at a recording script.
 */

export {
  anchorableLines,
  anchorMap,
  buildReviewPayload,
  formatComment,
  formatReviewBody,
  planReviewPost,
  reviewMarker,
  REVIEW_MARKER_PREFIX,
} from "@aaroncx/github";
export type {
  BuildPayloadInput,
  PostPlan,
  PostReviewResult,
  ReviewBodyInput,
  ReviewComment,
  ReviewPayload,
} from "@aaroncx/github";

/**
 * The gh half of the review transport. It stays in apps/cli on purpose:
 * @aaroncx/github must not know that a gh binary exists, and the App's
 * environment does not have one.
 */
export function ghReviewTransport(options: {
  bin: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): ReviewTransport {
  return {
    async listReviews(input): Promise<ExistingReview[]> {
      const raw = await runGh(
        options.bin,
        ["api", `repos/${input.repo}/pulls/${input.number}/reviews`, "--paginate"],
        { cwd: options.cwd, env: options.env },
      );
      let reviews: unknown;
      try {
        reviews = JSON.parse(raw);
      } catch {
        throw new Error(`could not parse the existing reviews of ${input.repo}#${input.number}`);
      }
      return Array.isArray(reviews) ? (reviews as ExistingReview[]) : [];
    },
    async createReview(input): Promise<string> {
      return runGh(
        options.bin,
        ["api", `repos/${input.repo}/pulls/${input.number}/reviews`, "-X", "POST", "--input", "-"],
        { cwd: options.cwd, stdin: JSON.stringify(input.payload), env: options.env },
      );
    },
  };
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

/**
 * Posts one COMMENT review through gh, unless an identical-head monad review
 * is already there. Never APPROVE, never REQUEST_CHANGES.
 */
export async function postReview(input: PostReviewInput): Promise<PostReviewResult> {
  const transport = ghReviewTransport({ bin: input.bin, cwd: input.cwd, env: input.env });
  return postReviewWith(transport, {
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
    report: input.report,
    files: input.files,
    checksTable: input.checksTable,
  });
}

/**
 * True when the PR already carries a monad review for this head sha. Kept as
 * a named export because it is the idempotence check the CLI documents; the
 * logic itself is @aaroncx/github's.
 */
export async function hasMonadReviewForHead(input: {
  bin: string;
  repo: string;
  number: number;
  headSha: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  return hasMonadReviewForHeadWith(ghReviewTransport({ bin: input.bin, cwd: input.cwd, env: input.env }), {
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
  });
}
