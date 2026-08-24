import type { OctokitLike } from "@aaroncx/github";
import type { DaemonAccess } from "./daemon.ts";
import type { Logger } from "./log.ts";

/** Everything a job needs that is not the delivery itself. */
export interface JobContext {
  /** Scoped to the delivery's installation. */
  octokit: OctokitLike;
  daemon: DaemonAccess;
  log: Logger;
  /** The daemon's database, read only, for a session's last event. */
  dbPath: string;
  /** owner/name to the local checkout, from github.json. */
  repoRootFor(fullName: string): string | undefined;
}

/**
 * The mutable half of a running job. The worker owns it: it reads sessionId
 * to cancel a review that a newer head superseded, and the job reads
 * superseded to know that the answer it is holding is stale.
 */
export interface JobControl {
  sessionId?: string;
  superseded?: { deliveryId: string; headSha?: string; reason: string };
  /**
   * Called the moment the review session exists. The worker uses it to
   * cancel a session that was already superseded before it had an id: a
   * synchronize can land while the previous review is still creating its
   * worktree, and waiting out a whole review to notice would be the storm
   * this design exists to collapse.
   */
  onSession?(sessionId: string): void;
}

export interface JobOutcome {
  /** retry means the delivery goes back to the queue behind a backoff. */
  status: "done" | "failed" | "skipped" | "retry" | "superseded";
  reason?: string;
}
