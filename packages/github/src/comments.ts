import { parsePullRequest, type NarrowedPullRequest } from "./events.ts";
import type { OctokitLike } from "./octokit.ts";

/**
 * The three calls monad makes on a pull request's conversation, and the one
 * it makes to read a pull request back.
 *
 * They live here rather than in apps/hook for the same reason check runs and
 * review posting do: this package is the only place that knows GitHub's API
 * shapes, so the App is left holding intent ("acknowledge this command")
 * rather than a route string. Nothing here decides anything. Whether a
 * command may run at all is trust.ts, and it is decided before any of these
 * are called.
 */

/** The reaction contents GitHub accepts on a comment. */
export const REACTIONS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;

export type ReactionContent = (typeof REACTIONS)[number];

/**
 * monad's own vocabulary, which is the whole progress UI for a comment
 * command and costs two API calls:
 *
 * - eyes: accepted, work starting;
 * - rocket: done;
 * - confused: monad did not recognize the command and did nothing;
 * - -1: recognized, refused, because the commenter does not have write
 *   access. It is a different mark from confused on purpose: "I will not"
 *   and "I do not understand" are different answers.
 */
export const ACK_REACTION: ReactionContent = "eyes";
export const DONE_REACTION: ReactionContent = "rocket";
export const UNKNOWN_REACTION: ReactionContent = "confused";
export const REFUSED_REACTION: ReactionContent = "-1";

export interface CommentRef {
  owner: string;
  repo: string;
  commentId: number;
}

/** POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions. */
export async function reactToComment(
  octokit: OctokitLike,
  params: CommentRef & { content: ReactionContent },
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
    owner: params.owner,
    repo: params.repo,
    comment_id: params.commentId,
    content: params.content,
  });
}

/**
 * POST /repos/{owner}/{repo}/issues/{issue_number}/comments: a reply on the
 * pull request's conversation. Used for @monad status and for telling a
 * commenter what happened; a review's findings go through review-post.ts.
 */
export async function postIssueComment(
  octokit: OctokitLike,
  params: { owner: string; repo: string; number: number; body: string },
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner: params.owner,
    repo: params.repo,
    issue_number: params.number,
    body: params.body,
  });
}

/**
 * GET /repos/{owner}/{repo}/pulls/{pull_number}, narrowed to the same shape
 * a signed payload carries.
 *
 * This is the explicit second step behind resolveTrustFromIntent's
 * untrusted answer for a check_run rerequest or an @monad review comment:
 * the delivery proves nothing about trust, so the caller reads the pull
 * request through the installation token and resolves again from that.
 * Undefined means the API answered with something that is not a pull
 * request, which stays untrusted.
 */
export async function fetchPullRequest(
  octokit: OctokitLike,
  params: { owner: string; repo: string; number: number },
): Promise<NarrowedPullRequest | undefined> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.number,
  });
  return parsePullRequest(response.data);
}
