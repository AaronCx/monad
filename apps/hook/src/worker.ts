import type { OctokitLike } from "@aaroncx/github";
import { runCommandJob } from "./commands.ts";
import type { DaemonAccess } from "./daemon.ts";
import type { JobContext, JobControl, JobOutcome } from "./job.ts";
import { describeRow, type Logger } from "./log.ts";
import { type DeliveryQueue, type DeliveryRow, prKeyOf } from "./queue.ts";
import { messageOf, runReviewJob } from "./review.ts";

/**
 * The worker: what turns queued deliveries into reviews, one at a time per
 * pull request.
 *
 * Three rules, and everything else here is bookkeeping for them.
 *
 * ONE review per pull request. A push storm on one PR (rebase, force push,
 * three commits in a minute) is several deliveries about the same thing.
 * When a review delivery arrives for a PR whose review is still running,
 * that session is cancelled, its delivery is marked superseded, its check
 * run is completed as cancelled, and the new head is reviewed. Two reviews
 * for one PR never exist, and neither do two check runs for one head sha.
 *
 * A GLOBAL cap (--max-concurrent, default 2), because the machine running
 * this is also doing other things and every review costs vendor tokens.
 *
 * A dead daemon LOSES NOTHING. monadd being down is not a delivery failure:
 * the row goes back to queued behind an exponential backoff and is tried
 * again. Only after maxAttempts does a delivery fail for good, with the
 * reason on the row.
 */

export interface HookWorkerOptions {
  queue: DeliveryQueue;
  daemon: DaemonAccess;
  /** An installation-scoped client, which is where the token handling lives. */
  octokitFor(installationId: number): Promise<OctokitLike>;
  repoRootFor(fullName: string): string | undefined;
  /** The daemon's database, for a session's last event. */
  dbPath: string;
  log: Logger;
  maxConcurrent?: number;
  maxAttempts?: number;
  backoffMs?: (attempts: number) => number;
  now?: () => Date;
}

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Exponential from two seconds, capped at five minutes. */
export function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts) * 1_000, MAX_BACKOFF_MS);
}

interface RunningJob {
  row: DeliveryRow;
  control: JobControl;
  done: Promise<void>;
}

export class HookWorker {
  private readonly options: Required<Omit<HookWorkerOptions, "octokitFor" | "repoRootFor">> &
    Pick<HookWorkerOptions, "octokitFor" | "repoRootFor">;
  private readonly running = new Map<string, RunningJob>();
  private readonly byPr = new Map<string, RunningJob>();
  private readonly idleWaiters: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pumping = false;

  constructor(options: HookWorkerOptions) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffMs: options.backoffMs ?? defaultBackoffMs,
      now: options.now ?? (() => new Date()),
      queue: options.queue,
      daemon: options.daemon,
      dbPath: options.dbPath,
      log: options.log,
      octokitFor: options.octokitFor,
      repoRootFor: options.repoRootFor,
    };
  }

  /**
   * Puts deliveries that were running when the process died back on the
   * queue, then starts working. Their review went with the process, so there
   * is nothing to resume; they are run again, and the delivery id keeps that
   * from becoming a second review of anything already reported.
   */
  start(): void {
    this.stopped = false;
    for (const row of this.options.queue.recoverRunning()) {
      this.options.log.warn(`${describeRow(row)} was running at shutdown; queued again`);
    }
    this.wake();
  }

  /** Nothing new starts; in-flight jobs are awaited. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await Promise.all([...this.running.values()].map((job) => job.done));
  }

  /** Something changed; look for work. */
  wake(): void {
    queueMicrotask(() => {
      this.pump();
    });
  }

  /** Resolves when nothing is running and nothing is ready to run. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running.size === 0 && this.options.queue.ready(this.options.now()).length === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  private notifyIdle(): void {
    for (const waiter of this.idleWaiters.splice(0)) {
      waiter();
    }
  }

  private pump(): void {
    if (this.pumping || this.stopped) {
      return;
    }
    this.pumping = true;
    try {
      const ready = this.options.queue.ready(this.options.now());
      // Supersede first, and for every waiting delivery rather than only the
      // ones a free slot reaches: a newer head makes a running review stale
      // whether or not there is room to start its replacement yet.
      for (const row of ready) {
        if (this.running.has(row.deliveryId)) {
          continue;
        }
        const key = prKeyOf(row);
        const busy = key === undefined ? undefined : this.byPr.get(key);
        if (busy !== undefined) {
          this.supersedeIfStale(busy, row);
        }
      }
      for (const row of ready) {
        if (this.running.size >= this.options.maxConcurrent) {
          break;
        }
        if (this.running.has(row.deliveryId)) {
          continue;
        }
        const key = prKeyOf(row);
        if (key !== undefined && this.byPr.has(key)) {
          continue;
        }
        this.begin(row, key);
      }
    } finally {
      this.pumping = false;
    }
    this.scheduleBackoffWake();
    if (this.running.size === 0 && this.options.queue.ready(this.options.now()).length === 0) {
      this.notifyIdle();
    }
  }

  /**
   * A newer review delivery for a pull request whose review is still
   * running: cancel the running session, mark that delivery superseded, and
   * let the pump start the new head as soon as the slot frees.
   *
   * A running COMMAND is never superseded. @monad fix is a person asking for
   * something specific; a push landing while it works does not make it
   * unwanted.
   */
  private supersedeIfStale(busy: RunningJob, arriving: DeliveryRow): void {
    if (busy.row.kind !== "review" || arriving.kind !== "review") {
      return;
    }
    if (busy.control.superseded !== undefined) {
      return;
    }
    const reason =
      `delivery ${arriving.deliveryId} brought a newer head for ` +
      `${arriving.repo}#${arriving.number}`;
    busy.control.superseded = {
      deliveryId: arriving.deliveryId,
      headSha: arriving.headSha,
      reason,
    };
    this.options.queue.finish(busy.row.deliveryId, "superseded", reason, this.options.now());
    this.options.log.info(`${describeRow(busy.row)} superseded by ${arriving.deliveryId}`);
    const sessionId = busy.control.sessionId;
    if (sessionId !== undefined) {
      void this.options.daemon.cancel(sessionId).catch((error: unknown) => {
        this.options.log.warn(`could not cancel session ${sessionId}: ${messageOf(error)}`);
      });
    }
  }

  private begin(row: DeliveryRow, key: string | undefined): void {
    const control: JobControl = {
      onSession: (sessionId) => {
        // Superseded before the session existed: cancel it now that it does.
        if (control.superseded !== undefined) {
          void this.options.daemon.cancel(sessionId).catch(() => {});
        }
      },
    };
    this.options.queue.markRunning(row.deliveryId, this.options.now());
    const job: RunningJob = { row, control, done: Promise.resolve() };
    job.done = this.run(row, control)
      .catch((error: unknown) => {
        this.finishRow(row, { status: "failed", reason: messageOf(error) });
      })
      .finally(() => {
        this.running.delete(row.deliveryId);
        if (key !== undefined && this.byPr.get(key) === job) {
          this.byPr.delete(key);
        }
        if (!this.stopped) {
          this.wake();
        } else {
          this.notifyIdle();
        }
      });
    this.running.set(row.deliveryId, job);
    if (key !== undefined) {
      this.byPr.set(key, job);
    }
  }

  private async run(row: DeliveryRow, control: JobControl): Promise<void> {
    this.options.log.info(`${describeRow(row)} started (attempt ${row.attempts + 1})`);
    if (row.installationId === undefined) {
      this.finishRow(row, { status: "failed", reason: "the delivery named no installation" });
      return;
    }
    let octokit: OctokitLike;
    try {
      octokit = await this.options.octokitFor(row.installationId);
    } catch (error) {
      this.finishRow(row, {
        status: "retry",
        reason: `no installation token: ${messageOf(error)}`,
      });
      return;
    }
    const ctx: JobContext = {
      octokit,
      daemon: this.options.daemon,
      log: this.options.log,
      dbPath: this.options.dbPath,
      repoRootFor: this.options.repoRootFor,
    };
    const outcome =
      row.kind === "review"
        ? await runReviewJob(ctx, row, control)
        : await runCommandJob(ctx, row);
    this.finishRow(row, outcome);
  }

  /**
   * Writes the outcome down. A superseded delivery was already finished by
   * the supersede path, so it is left alone: the row records why it stopped,
   * not that its last write happened to come later.
   */
  private finishRow(row: DeliveryRow, outcome: JobOutcome): void {
    const queue = this.options.queue;
    const now = this.options.now();
    if (outcome.status === "superseded") {
      return;
    }
    if (outcome.status === "retry") {
      const attempts = queue.get(row.deliveryId)?.attempts ?? row.attempts + 1;
      if (attempts >= this.options.maxAttempts) {
        queue.finish(
          row.deliveryId,
          "failed",
          `${outcome.reason ?? "retry"} (gave up after ${attempts} attempts)`,
          now,
        );
        this.options.log.error(
          `${describeRow(row)} failed after ${attempts} attempts: ${outcome.reason ?? ""}`,
        );
        return;
      }
      const delay = this.options.backoffMs(attempts);
      queue.retryLater(row.deliveryId, outcome.reason ?? "retry", new Date(now.getTime() + delay));
      this.options.log.warn(
        `${describeRow(row)} retrying in ${Math.round(delay / 1000)}s: ${outcome.reason ?? ""}`,
      );
      return;
    }
    queue.finish(row.deliveryId, outcome.status, outcome.reason, now);
    const line = `${describeRow(row)} ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`;
    if (outcome.status === "failed") {
      this.options.log.error(line);
    } else {
      this.options.log.info(line);
    }
  }

  /** Wakes the pump when the earliest backoff expires. */
  private scheduleBackoffWake(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.stopped) {
      return;
    }
    const waiting = this.options.queue
      .list("queued")
      .map((row) => row.nextAttemptAt)
      .filter((at): at is string => at !== undefined)
      .map((at) => Date.parse(at))
      .filter((at) => Number.isFinite(at));
    if (waiting.length === 0) {
      return;
    }
    const soonest = Math.min(...waiting);
    const delay = Math.max(10, soonest - this.options.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
    // Never hold the process open for a backoff.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
