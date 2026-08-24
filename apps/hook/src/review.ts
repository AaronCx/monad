import { diffBetween, type CheckRunResults } from "@aaroncx/checks";
import {
  ACK_REACTION,
  CHECK_RUN_NAME,
  completeCheckRun,
  createCheckRun,
  DONE_REACTION,
  fetchPullRequest,
  inProgressCheckRunOutput,
  octokitReviewTransport,
  postReview,
  queuedCheckRunOutput,
  reactToComment,
  renderCompletedCheckRun,
  resolveTrustFromIntent,
  resolveTrustFromPullRequest,
  reviewPrInputFromPayload,
  updateCheckRun,
  type NarrowedPullRequest,
  type ReviewIntent,
  type TrustDecision,
} from "@aaroncx/github";
import type { EventRecord, ReviewReport, SessionRecord } from "@aaroncx/protocol";
import type { JobContext, JobControl, JobOutcome } from "./job.ts";
import { describeRow } from "./log.ts";
import type { DeliveryRow } from "./queue.ts";

/**
 * The review lifecycle, in the order the pull request sees it.
 *
 * 1. Resolve trust. From the signed payload when the delivery carried one;
 *    otherwise read the pull request back through the installation token and
 *    resolve from that, as an explicit second step. There is no fallback
 *    that widens the answer.
 * 2. A queued Check Run on the head sha, immediately, so the PR shows
 *    something within seconds rather than after a minute of silence.
 * 3. in_progress, naming the trust level and what it means.
 * 4. The review session on monadd, with trust passed explicitly. The daemon
 *    never re-derives it; it has no GitHub credentials and no reason to.
 * 5. One completed Check Run: the brief's conclusion mapping, the checks
 *    table plus the report summary, and the annotations packages/checks
 *    already produced, paged 50 at a time.
 * 6. One COMMENT review with inline comments, through the same shared
 *    review-post code the CLI uses.
 * 7. The session is left open and idle, and its id is in the review footer,
 *    so `monad attach <id>` picks the conversation up.
 *
 * Nothing here decides what runs. Trust is read from what GitHub signed, and
 * everything downstream of it is the engine's.
 */

/** A results object for the case where the playbook never reported checks. */
function emptyResults(checksFailed: boolean): CheckRunResults {
  return {
    checks: [],
    hasFailures: checksFailed,
    hasWarnings: false,
    failureCount: checksFailed ? 1 : 0,
    warningCount: 0,
    summary: "the review reported no checks",
    annotations: [],
    meta: { engineVersion: "unknown", entropyThreshold: 0, inlineIgnore: false },
  };
}

/** The pull request this delivery is about, and how trusted it is. */
async function resolvePullRequest(
  ctx: JobContext,
  intent: ReviewIntent,
): Promise<{ pr: NarrowedPullRequest; trust: TrustDecision } | undefined> {
  if (intent.pullRequest !== undefined) {
    return { pr: intent.pullRequest, trust: resolveTrustFromIntent(intent) };
  }
  // A check_run rerequest and an @monad review comment carry no pull
  // request, so resolveTrustFromIntent answers untrusted and says why. The
  // proof has to come from somewhere signed or read back through the App's
  // own token; this is that read, and it is deliberately a second step
  // rather than a fallback hidden inside the resolver.
  const pr = await fetchPullRequest(ctx.octokit, {
    owner: intent.repo.owner,
    repo: intent.repo.name,
    number: intent.number,
  });
  if (pr === undefined) {
    return undefined;
  }
  return { pr, trust: resolveTrustFromPullRequest(pr) };
}

/**
 * A review asked for by a comment is acknowledged on that comment: eyes when
 * it starts, rocket when it lands. A review triggered by a push is not,
 * because the Check Run appearing within seconds already says it.
 */
async function acknowledge(
  ctx: JobContext,
  intent: ReviewIntent,
  content: typeof ACK_REACTION | typeof DONE_REACTION,
): Promise<void> {
  const comment = intent.comment;
  if (comment === undefined) {
    return;
  }
  await reactToComment(ctx.octokit, {
    owner: intent.repo.owner,
    repo: intent.repo.name,
    commentId: comment.id,
    content,
  }).catch(() => {
    // A reaction is the progress UI, never the work; losing one is not a
    // reason to abandon a review.
  });
}

export async function runReviewJob(
  ctx: JobContext,
  row: DeliveryRow,
  control: JobControl,
): Promise<JobOutcome> {
  const intent = row.intent as ReviewIntent;
  const repoRoot = ctx.repoRootFor(intent.repo.fullName);
  if (repoRoot === undefined) {
    return {
      status: "skipped",
      reason: [
        `${intent.repo.fullName} has no local checkout in github.json,`,
        "so monad has nothing to create a review worktree from",
      ].join(" "),
    };
  }

  const resolved = await resolvePullRequest(ctx, intent);
  if (resolved === undefined) {
    return {
      status: "failed",
      reason: `could not read ${intent.repo.fullName}#${intent.number} through the installation`,
    };
  }
  const { pr, trust } = resolved;
  const headSha = pr.head.sha;

  // The daemon is checked before the check run is created, so a monadd that
  // is down leaves the delivery queued for a retry rather than leaving a
  // second queued check run on the same head sha behind every attempt.
  try {
    await ctx.daemon.ensure();
  } catch (error) {
    return { status: "retry", reason: `monadd is not available: ${messageOf(error)}` };
  }

  await acknowledge(ctx, intent, ACK_REACTION);
  const { id: checkRunId } = await createCheckRun(ctx.octokit, {
    owner: intent.repo.owner,
    repo: intent.repo.name,
    headSha,
    name: CHECK_RUN_NAME,
    status: "queued",
    output: queuedCheckRunOutput(),
  });
  ctx.log.info(
    `${describeRow(row)} check_run=${checkRunId} head=${headSha} trust=${trust.trust}`,
  );
  await updateCheckRun(ctx.octokit, {
    owner: intent.repo.owner,
    repo: intent.repo.name,
    checkRunId,
    status: "in_progress",
    output: inProgressCheckRunOutput(trust),
  });

  let results: CheckRunResults | undefined;
  const onEvent = (event: EventRecord): void => {
    if (event.kind === "session_created") {
      // Captured live rather than read off the result, because supersede
      // needs the session id while the review is still running.
      const sessionId = (event.payload as SessionRecord).id;
      control.sessionId = sessionId;
      control.onSession?.(sessionId);
    } else if (event.kind === "checks") {
      results = event.payload as CheckRunResults;
    }
  };

  try {
    const result = await ctx.daemon.review(
      {
        repoRoot,
        pr: reviewPrInputFromPayload(intent.repo, pr),
        // Passed explicitly (decision records 0009 and 0010). The daemon
        // defaults to untrusted when a caller leaves it out; monad-hook
        // never leaves it out.
        trust: trust.trust,
      },
      onEvent,
    );
    if (control.superseded !== undefined) {
      await completeCheckRun(ctx.octokit, {
        owner: intent.repo.owner,
        repo: intent.repo.name,
        checkRunId,
        conclusion: "cancelled",
        title: "superseded by a newer commit",
        summary: [
          `This review was cancelled because ${intent.repo.fullName}#${intent.number} moved on`,
          `to a newer head. The review of ${control.superseded.headSha ?? "the new head"} is`,
          "the one that counts.",
        ].join(" "),
        annotations: [],
      });
      return { status: "superseded", reason: control.superseded.reason };
    }

    const checkResults = results ?? emptyResults(result.checksFailed);
    const rendered = renderCompletedCheckRun({
      report: result.report,
      results: checkResults,
      trust,
      sessionId: result.sessionId,
      checksFailed: result.checksFailed,
    });
    const completion = await completeCheckRun(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      checkRunId,
      conclusion: rendered.conclusion,
      title: rendered.title,
      summary: rendered.summary,
      text: rendered.text,
      annotations: checkResults.annotations,
    });
    ctx.log.info(
      `${describeRow(row)} completed=${rendered.conclusion} ` +
        `annotations=${completion.annotationsSent} dropped=${completion.dropped} ` +
        `session=${result.sessionId}`,
    );

    if (result.structured) {
      // The refs are already in the local checkout: the playbook fetched
      // refs/monad/pr/<n> and the base ref into it, so anchoring needs no
      // network.
      const files = await diffBetween(result.baseSha, result.headSha, repoRoot);
      const posted = await postReview(octokitReviewTransport(ctx.octokit), {
        repo: intent.repo.fullName,
        number: intent.number,
        headSha: result.headSha,
        report: result.report as ReviewReport,
        files,
        checksTable: result.checksTable,
        sessionId: result.sessionId,
      });
      ctx.log.info(
        `${describeRow(row)} review posted=${posted.posted} comments=${posted.comments} ` +
          `unanchored=${posted.unanchored}${posted.reason ? ` (${posted.reason})` : ""}`,
      );
    } else {
      ctx.log.info(
        [
          `${describeRow(row)} no review posted: the report was not structured,`,
          "and the check run says action_required",
        ].join(" "),
      );
    }
    // The session stays open and idle on purpose (step 7).
    await acknowledge(ctx, intent, DONE_REACTION);
    return { status: "done" };
  } catch (error) {
    if (control.superseded !== undefined) {
      return { status: "superseded", reason: control.superseded.reason };
    }
    const reason = messageOf(error);
    await completeCheckRun(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      checkRunId,
      conclusion: "failure",
      title: "the review did not finish",
      summary: `monad could not finish this review: ${reason}`,
      annotations: [],
    }).catch(() => {});
    return { status: "failed", reason };
  }
}

export function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split("\n", 1)[0]?.slice(0, 500) ?? "unknown error";
}
