import type { Annotation } from "@aaroncx/checks";
import type { OctokitLike } from "./octokit.ts";

/**
 * Check Runs, ported from LastGate's apps/web/lib/github/checks.ts.
 *
 * One change to the signature: these take an Octokit rather than an
 * installationId. LastGate minted a fresh installation token inside every
 * call, which put token handling in three files; here it lives only in
 * src/app.ts and callers pass the client they already hold.
 *
 * The other change is annotation paging, which LastGate never needed and M3
 * does. GitHub accepts at most 50 annotations per request and accumulates
 * them across updates to the same check run, so a run with more than 50
 * takes several PATCHes. Past MAX_ANNOTATIONS_TOTAL monad stops and says so
 * in the summary rather than paging forever on a noisy diff.
 */

/** The check run's name on the PR. Also what a rerequest comes back on. */
export const CHECK_RUN_NAME = "monad";

/** GitHub's hard limit per request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

/** monad's own cap across the whole run. Four requests of annotations. */
export const MAX_ANNOTATIONS_TOTAL = 200;

/** GitHub's cap on output.summary. */
export const MAX_SUMMARY_LENGTH = 65_535;

export type CheckRunStatus = "queued" | "in_progress" | "completed";

export type CheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "success"
  | "timed_out";

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: Annotation[];
}

export interface CreateCheckRunParams {
  owner: string;
  repo: string;
  headSha: string;
  /** Defaults to CHECK_RUN_NAME. */
  name?: string;
  /** Defaults to queued, which is what a PR should see within seconds. */
  status?: Exclude<CheckRunStatus, "completed">;
  output?: CheckRunOutput;
  /** Test seam for the clock. */
  now?: () => Date;
}

export interface UpdateCheckRunParams {
  owner: string;
  repo: string;
  checkRunId: number;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  output?: CheckRunOutput;
  now?: () => Date;
}

/** GitHub truncates a long summary itself; monad does it visibly instead. */
export function clampSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_LENGTH) {
    return summary;
  }
  const notice = "\n\n(summary truncated at GitHub's 65535 character limit)";
  return `${summary.slice(0, MAX_SUMMARY_LENGTH - notice.length)}${notice}`;
}

function outputPayload(output: CheckRunOutput | undefined): CheckRunOutput | undefined {
  if (output === undefined) {
    return undefined;
  }
  return { ...output, summary: clampSummary(output.summary) };
}

/** POST /repos/{owner}/{repo}/check-runs. Returns the new run's id. */
export async function createCheckRun(
  octokit: OctokitLike,
  params: CreateCheckRunParams,
): Promise<{ id: number }> {
  const now = params.now ?? (() => new Date());
  const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner: params.owner,
    repo: params.repo,
    name: params.name ?? CHECK_RUN_NAME,
    head_sha: params.headSha,
    status: params.status ?? "queued",
    started_at: now().toISOString(),
    output: outputPayload(params.output),
  });
  return { id: response.data.id as number };
}

/** PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}. */
export async function updateCheckRun(
  octokit: OctokitLike,
  params: UpdateCheckRunParams,
): Promise<{ id: number }> {
  const now = params.now ?? (() => new Date());
  const response = await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
      status: params.status,
      conclusion: params.conclusion,
      completed_at: params.status === "completed" ? now().toISOString() : undefined,
      output: outputPayload(params.output),
    },
  );
  return { id: response.data.id as number };
}

/** The line the summary carries when annotations were dropped. */
export function annotationTruncationNote(total: number): string {
  const remaining = total - MAX_ANNOTATIONS_TOTAL;
  return [
    `Showing the first ${MAX_ANNOTATIONS_TOTAL} of ${total} annotations.`,
    `The remaining ${remaining} are in the review body and the session transcript;`,
    "a diff this noisy is usually worth splitting.",
  ].join(" ");
}

export interface CompleteCheckRunParams {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: CheckRunConclusion;
  title: string;
  summary: string;
  text?: string;
  annotations: Annotation[];
  now?: () => Date;
}

export interface CompleteCheckRunResult {
  /** How many PATCH calls it took. */
  requests: number;
  annotationsSent: number;
  /** Annotations past MAX_ANNOTATIONS_TOTAL, which the summary names. */
  dropped: number;
}

/**
 * Drives the run to completed, paging annotations 50 at a time.
 *
 * Every request carries the full title and summary, so whichever one lands
 * last leaves the run in the right state; only the annotations differ page
 * to page, and GitHub accumulates those. A run with no annotations is one
 * request.
 */
export async function completeCheckRun(
  octokit: OctokitLike,
  params: CompleteCheckRunParams,
): Promise<CompleteCheckRunResult> {
  const total = params.annotations.length;
  const kept = params.annotations.slice(0, MAX_ANNOTATIONS_TOTAL);
  const dropped = total - kept.length;
  const summary =
    dropped > 0 ? `${params.summary}\n\n${annotationTruncationNote(total)}` : params.summary;

  const pages: Annotation[][] = [];
  for (let index = 0; index < kept.length; index += MAX_ANNOTATIONS_PER_REQUEST) {
    pages.push(kept.slice(index, index + MAX_ANNOTATIONS_PER_REQUEST));
  }
  if (pages.length === 0) {
    pages.push([]);
  }

  const now = params.now ?? (() => new Date());
  for (const page of pages) {
    await updateCheckRun(octokit, {
      owner: params.owner,
      repo: params.repo,
      checkRunId: params.checkRunId,
      status: "completed",
      conclusion: params.conclusion,
      output: {
        title: params.title,
        summary,
        text: params.text,
        annotations: page,
      },
      now,
    });
  }

  return { requests: pages.length, annotationsSent: kept.length, dropped };
}
