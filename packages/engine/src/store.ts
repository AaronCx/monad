import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type EventKind,
  type EventRecord,
  EventRecordSchema,
  type SessionId,
  type SessionMode,
  type SessionRecord,
  SessionRecordSchema,
  type SessionStatus,
} from "@aaroncx/protocol";
import { monadStateDir } from "./paths.ts";

export interface SessionStoreOptions {
  /** Database file path. Defaults to ~/.monad/monad.db. Injectable for tests. */
  dbPath?: string;
}

export function defaultDbPath(): string {
  return join(monadStateDir(), "monad.db");
}

interface SessionRow {
  id: string;
  cwd: string;
  backend: string;
  agent_session_id: string | null;
  mode: string;
  status: string;
  base: string | null;
  head: string | null;
  pr: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  session_id: string;
  ts: string;
  kind: string;
  payload: string;
}

function rowToSession(row: SessionRow): SessionRecord {
  return SessionRecordSchema.parse({
    id: row.id,
    cwd: row.cwd,
    backend: row.backend,
    agentSessionId: row.agent_session_id ?? undefined,
    mode: row.mode,
    status: row.status,
    base: row.base ?? undefined,
    head: row.head ?? undefined,
    pr: row.pr === null ? undefined : JSON.parse(row.pr),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToEvent(row: EventRow): EventRecord {
  return EventRecordSchema.parse({
    seq: row.seq,
    sessionId: row.session_id,
    ts: row.ts,
    kind: row.kind,
    payload: JSON.parse(row.payload),
  });
}

/**
 * Append-only session and event storage on bun:sqlite, WAL mode.
 *
 * The event log is the daemon's source of truth: the ACP HTTP transport does
 * not replay messages a disconnected client missed, so attach means replaying
 * from here plus a live subscription. Event payloads are stored verbatim as
 * JSON, including non-message update kinds like available_commands_update
 * and usage_update.
 */
export class SessionStore {
  private readonly db: Database;

  constructor(options: SessionStoreOptions = {}) {
    const dbPath = options.dbPath ?? defaultDbPath();
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        backend TEXT NOT NULL,
        agent_session_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        base TEXT,
        head TEXT,
        pr TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
    `);
    // M1 databases predate the base/head/pr columns; add them in place.
    // SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error
    // means the migration already ran. pr holds the SessionPr as JSON.
    for (const column of ["base", "head", "pr"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT;`);
      } catch {
        // Column already present.
      }
    }
  }

  /** Inserts a new session record. Throws if the id already exists. */
  create(record: SessionRecord): SessionRecord {
    const parsed = SessionRecordSchema.parse(record);
    this.db
      .query(
        `INSERT INTO sessions (id, cwd, backend, agent_session_id, mode, status, base, head, pr, created_at, updated_at)
         VALUES ($id, $cwd, $backend, $agentSessionId, $mode, $status, $base, $head, $pr, $createdAt, $updatedAt)`,
      )
      .run({
        id: parsed.id,
        cwd: parsed.cwd,
        backend: parsed.backend,
        agentSessionId: parsed.agentSessionId ?? null,
        mode: parsed.mode,
        status: parsed.status,
        base: parsed.base ?? null,
        head: parsed.head ?? null,
        pr: parsed.pr === undefined ? null : JSON.stringify(parsed.pr),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    return parsed;
  }

  /** Appends one event and returns it with its assigned sequence number. */
  append(sessionId: SessionId, kind: EventKind, payload: unknown): EventRecord {
    const ts = new Date().toISOString();
    const row = this.db
      .query<{ seq: number }, { sessionId: string; ts: string; kind: string; payload: string }>(
        `INSERT INTO events (session_id, ts, kind, payload)
         VALUES ($sessionId, $ts, $kind, $payload)
         RETURNING seq`,
      )
      .get({ sessionId, ts, kind, payload: JSON.stringify(payload ?? null) });
    if (!row) {
      throw new Error(`append failed for session ${sessionId}`);
    }
    this.touch(sessionId);
    return { seq: row.seq, sessionId, ts, kind, payload: payload ?? null };
  }

  /**
   * Returns a session's events in seq order, starting at fromSeq inclusive.
   * With the default of 0 the whole log is returned; pass lastSeenSeq + 1 to
   * resume.
   */
  replay(sessionId: SessionId, fromSeq = 0): EventRecord[] {
    const rows = this.db
      .query<EventRow, { sessionId: string; fromSeq: number }>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND seq >= $fromSeq
         ORDER BY seq ASC`,
      )
      .all({ sessionId, fromSeq });
    return rows.map(rowToEvent);
  }

  /** All sessions, oldest first (uuid v7 ids sort by creation time). */
  list(): SessionRecord[] {
    const rows = this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY id ASC")
      .all();
    return rows.map(rowToSession);
  }

  get(id: SessionId): SessionRecord | undefined {
    const row = this.db
      .query<SessionRow, { id: string }>("SELECT * FROM sessions WHERE id = $id")
      .get({ id });
    return row ? rowToSession(row) : undefined;
  }

  setStatus(id: SessionId, status: SessionStatus): void {
    const result = this.db
      .query("UPDATE sessions SET status = $status, updated_at = $updatedAt WHERE id = $id")
      .run({ id, status, updatedAt: new Date().toISOString() });
    if (result.changes === 0) {
      throw new Error(`setStatus: unknown session ${id}`);
    }
  }

  setMode(id: SessionId, mode: SessionMode): void {
    const result = this.db
      .query("UPDATE sessions SET mode = $mode, updated_at = $updatedAt WHERE id = $id")
      .run({ id, mode, updatedAt: new Date().toISOString() });
    if (result.changes === 0) {
      throw new Error(`setMode: unknown session ${id}`);
    }
  }

  setAgentSessionId(id: SessionId, agentSessionId: string): void {
    const result = this.db
      .query(
        "UPDATE sessions SET agent_session_id = $agentSessionId, updated_at = $updatedAt WHERE id = $id",
      )
      .run({ id, agentSessionId, updatedAt: new Date().toISOString() });
    if (result.changes === 0) {
      throw new Error(`setAgentSessionId: unknown session ${id}`);
    }
  }

  /** Checkpoints the WAL and closes the database. */
  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.close();
  }

  private touch(id: SessionId): void {
    this.db
      .query("UPDATE sessions SET updated_at = $updatedAt WHERE id = $id")
      .run({ id, updatedAt: new Date().toISOString() });
  }
}
