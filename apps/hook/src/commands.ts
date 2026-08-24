import { FIX_MODE_PROMPT } from "@aaroncx/engine";
import {
  ACK_REACTION,
  commenterMayRunFix,
  DONE_REACTION,
  postIssueComment,
  reactToComment,
  REFUSED_REACTION,
  type CommandIntent,
  UNKNOWN_REACTION,
} from "@aaroncx/github";
import type { SessionRecord } from "@aaroncx/protocol";
import { sessionForPr } from "./daemon.ts";
import type { JobContext, JobOutcome } from "./job.ts";
import { describeRow } from "./log.ts";
import type { DeliveryRow } from "./queue.ts";
import { messageOf } from "./review.ts";
import { lastEventOf } from "./sessions.ts";

/**
 * @monad commands on a pull request.
 *
 * The gate is one line, and it is the most important line in M3: fix mode
 * edits files, so @monad fix runs only for a commenter whose
 * author_association is OWNER, MEMBER, or COLLABORATOR. Everyone else gets a
 * reaction and nothing else. The association arrives inside the payload
 * GitHub signed, so this costs no API call and cannot be spoofed by the
 * comment's text.
 *
 * The whole progress UI is two reactions: eyes when a command is accepted,
 * rocket when it completes. An unrecognized command gets confused and no
 * reply, because a parser that guesses is a parser that eventually runs fix
 * mode because someone wrote the word "fix" in a sentence.
 *
 * And fix mode from a webhook never pushes. The M2 policy forwards git push
 * to an attached human and holds it when nobody is attached; monad-hook is
 * not a human (it rejects every permission request), so the branch stays in
 * the worktree and the reply says how to get it.
 */

/** How a human takes a webhook-run fix session over. */
function handoff(record: SessionRecord): string {
  return [
    `Session \`${record.id}\`, worktree \`${record.cwd}\`.`,
    "",
    [
      "monad committed inside that worktree and did not push: a session with nobody attached",
      "holds `git push` for a human rather than running it. To take it from here, either run",
      `\`monad attach ${record.id}\` and approve the push, or pull the branch out of the`,
      "worktree yourself.",
    ].join(" "),
  ].join("\n");
}

export async function runCommandJob(ctx: JobContext, row: DeliveryRow): Promise<JobOutcome> {
  const intent = row.intent as CommandIntent;
  const comment = {
    owner: intent.repo.owner,
    repo: intent.repo.name,
    commentId: intent.comment.id,
  };

  if (intent.command.name === "unknown") {
    await reactToComment(ctx.octokit, { ...comment, content: UNKNOWN_REACTION });
    ctx.log.info(`${describeRow(row)} command=unknown verb=${intent.command.verb}`);
    return { status: "done", reason: `monad does not know the command ${intent.command.verb}` };
  }

  if (intent.command.name === "fix" && !commenterMayRunFix(intent.comment)) {
    // Recognized, refused. A different mark from confused on purpose: "I
    // will not" and "I do not understand" are different answers, and this
    // one is the check that matters most in M3.
    await reactToComment(ctx.octokit, { ...comment, content: REFUSED_REACTION });
    const who = intent.comment.user?.login ?? "the commenter";
    ctx.log.info(
      `${describeRow(row)} command=fix refused: ${who} is ` +
        `${intent.comment.author_association}`,
    );
    return {
      status: "done",
      reason: [
        `${who} is ${intent.comment.author_association} on ${intent.repo.fullName},`,
        "which is not write access, so fix mode did not run",
      ].join(" "),
    };
  }

  await reactToComment(ctx.octokit, { ...comment, content: ACK_REACTION });

  let sessions: SessionRecord[];
  try {
    sessions = await ctx.daemon.sessions();
  } catch (error) {
    return { status: "retry", reason: `monadd is not available: ${messageOf(error)}` };
  }
  const record = sessionForPr(sessions, intent.repo.fullName, intent.number);
  if (record === undefined) {
    await postIssueComment(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      number: intent.number,
      body:
        "monad has no open session for this pull request. Comment `@monad review` first, " +
        "then ask again.",
    });
    return { status: "done", reason: "no open session for this pull request" };
  }

  if (intent.command.name === "status") {
    const last = lastEventOf(ctx.dbPath, record.id);
    await postIssueComment(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      number: intent.number,
      body: [
        `Session \`${record.id}\``,
        `- mode: ${record.mode}`,
        `- status: ${record.status}`,
        `- trust: ${record.trust}`,
        `- last event: ${last ? `${last.kind} at ${last.ts}` : "none yet"}`,
        "",
        `\`monad attach ${record.id}\` picks it up.`,
      ].join("\n"),
    });
    await reactToComment(ctx.octokit, { ...comment, content: DONE_REACTION });
    return { status: "done" };
  }

  const instruction = intent.command.instruction;
  try {
    const switched = await ctx.daemon.setMode(record.id, "fix");
    // Two prompts, the same pair `monad review --fix` sends: the mode
    // announcement (ACP has no system channel) and then the instruction.
    await ctx.daemon.prompt(switched, [FIX_MODE_PROMPT, instruction]);
    await postIssueComment(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      number: intent.number,
      body: handoff(switched),
    });
    await reactToComment(ctx.octokit, { ...comment, content: DONE_REACTION });
    ctx.log.info(`${describeRow(row)} command=fix session=${switched.id}`);
    return { status: "done" };
  } catch (error) {
    const reason = messageOf(error);
    await postIssueComment(ctx.octokit, {
      owner: intent.repo.owner,
      repo: intent.repo.name,
      number: intent.number,
      body: `monad could not run fix mode on session \`${record.id}\`: ${reason}`,
    }).catch(() => {});
    return { status: "failed", reason };
  }
}
