import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDbPath } from "@aaroncx/engine";
import type { WebhookIntent } from "@aaroncx/github";

/**
 * The delivery queue: hook_deliveries, in the same ~/.monad/monad.db the
 * daemon keeps sessions in.
 *
 * Two properties matter and both come from the table rather than from
 * anything in the worker.
 *
 * Idempotency: the delivery id is the primary key, so GitHub redelivering
 * the same event (its retry, or a human pressing Redeliver) inserts nothing
 * and starts nothing. The receiver answers the second copy exactly as fast
 * as the first and does one review.
 *
 * Durability: the row is committed before the receiver answers 202, so a
 * crash between the answer and the work loses nothing. A row still marked
 * running when the process starts is one that died mid-review; it goes back
 * to queued, because the review that would have completed it is gone.
 *
 * What is stored is the NARROWED intent (@aaroncx/github's zod output), not
 * the raw delivery. The narrowing already dropped everything monad does not
 * read, so the queue structurally cannot hold a field nobody named, and the
 * log lines built from a row carry the delivery id, event, action, repo, and
 * PR number and nothing else.
 */

export type DeliveryStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  /** A newer head arrived for this PR before this delivery finished. */
  | "superseded"
  /** Accepted and deliberately not worked (an installation record). */
  | "skipped";

export type DeliveryKind = "review" | "command" | "record";

export interface DeliveryRow {
  deliveryId: string;
  event: string;
  action: string;
  kind: DeliveryKind;
  repo?: string;
  number?: number;
  headSha?: string;
  installationId?: number;
  /** The narrowed intent as it was resolved from the signed payload. */
  intent: WebhookIntent;
  receivedAt: string;
  status: DeliveryStatus;
  attempts: number;
  error?: string;
  /** Set while a delivery is waiting out a backoff; queued rows only. */
  nextAttemptAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface DeliveryDbRow {
  delivery_id: string;
  event: string;
  action: string;
  kind: string;
  repo: string | null;
  number: number | null;
  head_sha: string | null;
  installation_id: number | null;
  intent: string;
  received_at: string;
  status: string;
  attempts: number;
  error: string | null;
  next_attempt_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface DeliveryQueueOptions {
  /** Defaults to ~/.monad/monad.db, the daemon's own database. */
  dbPath?: string;
}

function rowToDelivery(row: DeliveryDbRow): DeliveryRow {
  return {
    deliveryId: row.delivery_id,
    event: row.event,
    action: row.action,
    kind: row.kind as DeliveryKind,
    repo: row.repo ?? undefined,
    number: row.number ?? undefined,
    headSha: row.head_sha ?? undefined,
    installationId: row.installation_id ?? undefined,
    intent: JSON.parse(row.intent) as WebhookIntent,
    receivedAt: row.received_at,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    error: row.error ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

/** What a review or command intent says about which PR it belongs to. */
function detailsOf(intent: WebhookIntent): {
  kind: DeliveryKind;
  repo?: string;
  number?: number;
  headSha?: string;
  installationId?: number;
} {
  if (intent.kind === "review") {
    return {
      kind: "review",
      repo: intent.repo.fullName,
      number: intent.number,
      headSha: intent.headSha,
      installationId: intent.installationId,
    };
  }
  if (intent.kind === "command") {
    return {
      kind: "command",
      repo: intent.repo.fullName,
      number: intent.number,
      installationId: intent.installationId,
    };
  }
  if (intent.kind === "record") {
    return { kind: "record", installationId: intent.installationId };
  }
  // An ignored intent is answered 200 and never queued; this is the
  // defensive branch, and it stores nothing that would start work.
  return { kind: "record" };
}

/** repo#number: the key one review at a time is enforced on. */
export function prKeyOf(row: DeliveryRow): string | undefined {
  return row.repo !== undefined && row.number !== undefined
    ? `${row.repo}#${row.number}`
    : undefined;
}

export class DeliveryQueue {
  private readonly db: Database;

  constructor(options: DeliveryQueueOptions = {}) {
    const dbPath = options.dbPath ?? defaultDbPath();
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    // monadd is the other writer on this file; wait rather than fail.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT NOT NULL,
        kind TEXT NOT NULL,
        repo TEXT,
        number INTEGER,
        head_sha TEXT,
        installation_id INTEGER,
        intent TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        next_attempt_at TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hook_deliveries_status
        ON hook_deliveries(status, received_at);
    `);
  }

  /**
   * Writes a delivery down. Returns inserted: false when this delivery id is
   * already known, which is the whole idempotency story: the caller answers
   * GitHub either way and starts nothing the second time.
   */
  enqueue(
    intent: WebhookIntent,
    options: { status?: DeliveryStatus; error?: string; now?: Date } = {},
  ): { inserted: boolean; row: DeliveryRow } {
    const existing = this.get(intent.delivery.id);
    if (existing) {
      return { inserted: false, row: existing };
    }
    const details = detailsOf(intent);
    const now = (options.now ?? new Date()).toISOString();
    this.db
      .query(
        `INSERT INTO hook_deliveries
           (delivery_id, event, action, kind, repo, number, head_sha, installation_id,
            intent, received_at, status, attempts, error)
         VALUES ($deliveryId, $event, $action, $kind, $repo, $number, $headSha, $installationId,
            $intent, $receivedAt, $status, 0, $error)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .run({
        deliveryId: intent.delivery.id,
        event: intent.delivery.event,
        action: intent.delivery.action,
        kind: details.kind,
        repo: details.repo ?? null,
        number: details.number ?? null,
        headSha: details.headSha ?? null,
        installationId: details.installationId ?? null,
        intent: JSON.stringify(intent),
        receivedAt: now,
        status: options.status ?? "queued",
        error: options.error ?? null,
      });
    const row = this.get(intent.delivery.id);
    if (!row) {
      throw new Error(`enqueue lost delivery ${intent.delivery.id}`);
    }
    return { inserted: true, row };
  }

  get(deliveryId: string): DeliveryRow | undefined {
    const row = this.db
      .query<DeliveryDbRow, { deliveryId: string }>(
        "SELECT * FROM hook_deliveries WHERE delivery_id = $deliveryId",
      )
      .get({ deliveryId });
    return row ? rowToDelivery(row) : undefined;
  }

  /** Every delivery, oldest first. */
  list(status?: DeliveryStatus): DeliveryRow[] {
    const rows =
      status === undefined
        ? this.db
            .query<DeliveryDbRow, []>(
              "SELECT * FROM hook_deliveries ORDER BY received_at ASC, rowid ASC",
            )
            .all()
        : this.db
            .query<DeliveryDbRow, { status: string }>(
              "SELECT * FROM hook_deliveries WHERE status = $status ORDER BY received_at ASC, rowid ASC",
            )
            .all({ status });
    return rows.map(rowToDelivery);
  }

  /** Queued deliveries whose backoff has expired, oldest first. */
  ready(now: Date = new Date()): DeliveryRow[] {
    const rows = this.db
      .query<DeliveryDbRow, { now: string }>(
        `SELECT * FROM hook_deliveries
          WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= $now)
          ORDER BY received_at ASC, rowid ASC`,
      )
      .all({ now: now.toISOString() });
    return rows.map(rowToDelivery);
  }

  markRunning(deliveryId: string, now: Date = new Date()): void {
    this.db
      .query(
        `UPDATE hook_deliveries
            SET status = 'running', attempts = attempts + 1, started_at = $now,
                next_attempt_at = NULL, error = NULL
          WHERE delivery_id = $deliveryId`,
      )
      .run({ deliveryId, now: now.toISOString() });
  }

  /** Terminal state, with the reason when there is one. */
  finish(
    deliveryId: string,
    status: Extract<DeliveryStatus, "done" | "failed" | "superseded" | "skipped">,
    reason?: string,
    now: Date = new Date(),
  ): void {
    this.db
      .query(
        `UPDATE hook_deliveries
            SET status = $status, error = $error, finished_at = $now, next_attempt_at = NULL
          WHERE delivery_id = $deliveryId`,
      )
      .run({ deliveryId, status, error: reason ?? null, now: now.toISOString() });
  }

  /**
   * Back to queued, not before nextAttemptAt. This is what a dead daemon
   * gets: the delivery is not lost and not retried in a tight loop.
   */
  retryLater(deliveryId: string, error: string, nextAttemptAt: Date): void {
    this.db
      .query(
        `UPDATE hook_deliveries
            SET status = 'queued', error = $error, next_attempt_at = $nextAttemptAt
          WHERE delivery_id = $deliveryId`,
      )
      .run({ deliveryId, error, nextAttemptAt: nextAttemptAt.toISOString() });
  }

  /**
   * Crash recovery. A row still marked running when the process starts is
   * one whose review died with the process, so it goes back to queued.
   * Returns the rows that were recovered, for the log line.
   */
  recoverRunning(): DeliveryRow[] {
    const stranded = this.list("running");
    if (stranded.length === 0) {
      return [];
    }
    this.db.exec(
      `UPDATE hook_deliveries
          SET status = 'queued', next_attempt_at = NULL,
              error = 'monad-hook restarted while this delivery was running'
        WHERE status = 'running'`,
    );
    return stranded;
  }

  counts(): Record<string, number> {
    const rows = this.db
      .query<{ status: string; n: number }, []>(
        "SELECT status, count(*) AS n FROM hook_deliveries GROUP BY status",
      )
      .all();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  close(): void {
    this.db.close();
  }
}
