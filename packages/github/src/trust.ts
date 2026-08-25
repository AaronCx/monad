import type { TrustLevel } from "@aaroncx/protocol";
import type { NarrowedComment, NarrowedPullRequest, ReviewIntent } from "./events.ts";

/**
 * Trust resolution for a webhook-triggered review (decision records 0009 and
 * 0010).
 *
 * The rule is one sentence: untrusted unless the payload GitHub signed
 * proves otherwise. Nothing in this file reads the worktree, calls the API,
 * or shells out to gh. The CLI's resolveTrust spends a gh api call on the
 * author's collaborator permission because a human is waiting and the answer
 * is worth the round trip; the App does not, because author_association is
 * already in the signed payload and the App has no gh binary in its
 * environment anyway.
 *
 * There is no fallback lookup on an inconclusive answer. A fallback is a
 * second code path that can only ever widen the answer, and the safe
 * direction to be wrong in is a thinner review.
 */

/**
 * Associations that mean the person can already run code in this repo's CI.
 * CONTRIBUTOR (merged before), FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN,
 * and NONE all mean they cannot.
 */
export const WRITE_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

export interface TrustDecision {
  trust: TrustLevel;
  /** One line, for the check run summary and the session record. */
  reason: string;
}

/** True only for the three associations that imply write access. */
export function hasWriteAccess(association: string | null | undefined): boolean {
  return typeof association === "string" && WRITE_ASSOCIATIONS.includes(association);
}

/**
 * A fork head. head.repo is null when the fork was deleted after the PR was
 * opened, which is not the base repo either, so it reads as a fork.
 */
export function isForkPullRequest(pr: NarrowedPullRequest): boolean {
  return pr.head.repo?.full_name !== pr.base.repo.full_name;
}

/**
 * Both facts must hold: the head is a branch on the repo itself, AND the
 * author has write access.
 *
 * The fork check comes first and is not redundant with the association
 * check. A PR you open from your own fork of your own repo carries
 * author_association OWNER and is still untrusted, because the head commit
 * lives in a repository the base repo's collaborators do not control. What
 * is trusted is the branch, not the person.
 */
export function resolveTrustFromPullRequest(pr: NarrowedPullRequest): TrustDecision {
  if (isForkPullRequest(pr)) {
    const head = pr.head.repo?.full_name;
    return {
      trust: "untrusted",
      reason:
        head === undefined
          ? "the pull request head is on a fork that no longer exists"
          : `the pull request head is on ${head}, a fork of ${pr.base.repo.full_name}`,
    };
  }
  const association = pr.author_association;
  if (!hasWriteAccess(association)) {
    const login = pr.user?.login ?? "the author";
    return {
      trust: "untrusted",
      reason: `${login} is ${association} on ${pr.base.repo.full_name}, which is not write access`,
    };
  }
  const login = pr.user?.login ?? "the author";
  return {
    trust: "trusted",
    reason: `${login} is ${association} and the head is a branch on ${pr.base.repo.full_name}`,
  };
}

/**
 * The intent-level entry point. A review intent from an issue_comment or a
 * check_run rerequest carries no signed pull request, so the answer is
 * untrusted: the caller may fetch the PR through the installation token and
 * call resolveTrustFromPullRequest on what it gets back, which is a
 * deliberate second step rather than a silent fallback.
 */
export function resolveTrustFromIntent(intent: ReviewIntent): TrustDecision {
  if (intent.pullRequest === undefined) {
    return {
      trust: "untrusted",
      reason: `the ${intent.delivery.event} delivery carried no pull request payload to prove trust from`,
    };
  }
  return resolveTrustFromPullRequest(intent.pullRequest);
}

/**
 * The gate on @monad fix, which is the command that edits files. Same three
 * associations, read from the comment rather than the pull request, because
 * the person typing the command is the one being trusted. Open decision 2:
 * a stricter version verifies write permission through the API per command,
 * which is worth doing if the App ever leaves Aaron's own repos.
 */
export function commenterMayRunFix(comment: NarrowedComment): boolean {
  return hasWriteAccess(comment.author_association);
}
