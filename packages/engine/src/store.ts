import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type EventKind,
  type EventRecord,
  EventRecordSchema,
  type SearchHit,
  type SearchKind,
  type SessionId,
  type SessionMode,
  type SessionRecord,
  SessionRecordSchema,
  type SessionRepo,
  type SessionStatus,
  type TitleSource,
} from "@aaroncx/protocol";
import {
  agentChunkText,
  type OpenAgentRow,
  planIndex,
  replayAgentRows,
  type SettlingAgentRow,
  toFtsQuery,
} from "./indexer.ts";
import { monadStateDir } from "./paths.ts";
import { eventPaths, RepoResolver } from "./repos.ts";

export interface SessionStoreOptions {
  /** Database file path. Defaults to ~/.monad/monad.db. Injectable for tests. */
  dbPath?: string;
  /**
   * Maps tool-call paths to repository roots for session_repos. Injectable so
   * tests can point `~` at a fixture home.
   */
  repoResolver?: RepoResolver;
}

/**
 * Generation of the derived index (search_fts, session_repos, index_state),
 * kept in PRAGMA user_version. A database below it has its derived tables
 * wiped and rebuilt from the event log at open, so changing what the indexer
 * writes means bumping this, never migrating rows by hand. 1 is the first
 * Link index; 2 redacts split agent rows and derived titles with context
 * (rows a generation 1 index wrote may hold part of a token).
 */
export const INDEX_GENERATION = 2;

/**
 * Event kinds that do not move a session's updated_at: they record something
 * ABOUT the session (another session reading it, a handoff or summary of
 * it), not something it did.
 */
const PASSIVE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["access", "handoff", "summary"]);

/** Events per transaction while backfilling, so a huge log never holds the write lock for long. */
const BACKFILL_BATCH = 500;

export interface SearchOptions {
  /** Only sessions tagged with this exact repository root (see reposFor). */
  repo?: string;
  /** Only rows at or after this ISO timestamp. */
  since?: string;
  /** Default 20 (also for a non-finite value), clamped to 1..200. */
  limit?: number;
  /** Only these sessions. An empty list matches nothing. */
  sessionIds?: SessionId[];
  /** Never these sessions (applied before the limit, so they do not crowd out other hits). */
  excludeSessionIds?: SessionId[];
  /** Only these row kinds. An empty list matches nothing. */
  kinds?: SearchKind[];
  /**
   * At most this many hits from any one session (its best ranked), applied
   * before the limit, so one session's many near-identical rows (the same
   * file path edited twenty times) cannot crowd every other session out.
   * Unset means no cap.
   */
  maxPerSession?: number;
}

/**
 * How many ranked rows a capped search reads before applying the
 * per-session cap and the limit. bm25 ordering already scores every match,
 * so reading more rows costs little; the bound keeps a query that matches
 * most of the index from building a huge result array.
 */
const CAPPED_SEARCH_SCAN = 5000;

/** Snippet highlight markers around each matched term. */
export const SNIPPET_OPEN = "\u00ab";
export const SNIPPET_CLOSE = "\u00bb";

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
  trust: string | null;
  base: string | null;
  head: string | null;
  pr: string | null;
  exec_allowlist: string | null;
  title: string | null;
  title_source: string | null;
  parent_id: string | null;
  spawn_depth: number | null;
  created_at: string;
  updated_at: string;
}

/** Per-session indexing state, cached in memory after first use. */
interface IndexCache {
  cwd: string;
  titled: boolean;
  lastIndexedSeq: number;
  open?: OpenAgentRow;
  settling?: SettlingAgentRow;
}

/** One search_fts hit as SQLite returns it. */
interface SearchRow {
  session_id: string;
  kind: SearchKind;
  first_seq: number;
  last_seq: number;
  ts: string;
  snippet: string;
  rank: number;
}

/**
 * How far the importer has read one vendor log file (Link phase 4). offset is
 * the byte just past the last whole line consumed and line the number of
 * lines consumed; size, mtimeMs and ino are the file as last seen (size is
 * the offset itself while a file is only partly read), so an unchanged file
 * is skipped with one stat; a new inode means the file was replaced. head
 * is a fingerprint of the consumed bytes (a hash of their first and last 4
 * KiB), so a file rewritten in place is recognized and read again from the
 * start.
 */
export interface ImportState {
  sourcePath: string;
  sessionId: SessionId;
  vendor: "claude-code" | "codex";
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
  line: number;
  head: string;
}

/** One event read from a vendor log, with the timestamp the log gave it. */
export interface ImportedEventInput {
  kind: EventKind;
  payload: unknown;
  ts: string;
}

/** One batch for SessionStore.appendImported. */
export interface ImportBatch {
  sessionId: SessionId;
  /** Inserted first when no session with this id exists yet. */
  create?: SessionRecord;
  /** Names the session (title source import), unless a human named it. */
  title?: string;
  events: ImportedEventInput[];
  /** The file's import state after this batch. */
  state: ImportState;
}

interface ImportRow {
  source_path: string;
  session_id: string;
  vendor: string;
  byte_offset: number;
  size: number;
  mtime_ms: number;
  ino: number;
  line: number;
  head: string;
}

function rowToImportState(row: ImportRow): ImportState {
  return {
    sourcePath: row.source_path,
    sessionId: row.session_id,
    vendor: row.vendor === "codex" ? "codex" : "claude-code",
    offset: row.byte_offset,
    size: row.size,
    mtimeMs: row.mtime_ms,
    ino: row.ino,
    line: row.line,
    head: row.head,
  };
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
    // Null on an M2 row; the schema's catch turns that into "untrusted".
    trust: row.trust ?? undefined,
    base: row.base ?? undefined,
    head: row.head ?? undefined,
    pr: row.pr === null ? undefined : JSON.parse(row.pr),
    // Unreadable JSON reads back as absent, which the fix policy treats as an
    // empty allowlist (record 0009): a corrupt row denies, it never allows.
    execAllowlist: parseJsonArray(row.exec_allowlist),
    title: row.title ?? undefined,
    titleSource: row.title_source ?? undefined,
    parentId: row.parent_id ?? undefined,
    spawnDepth: row.spawn_depth ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** A stored JSON string array, or undefined when absent or unreadable. */
function parseJsonArray(value: string | null): string[] | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
 *
 * monad Link (decision record 0012) derives three things from the log, in the
 * same transaction as every append: the full-text index (search_fts), the
 * repositories each session touched (session_repos), and the session title.
 * All three are rebuildable from the log alone; index_state records how far
 * each session has been indexed, so a database that predates the index (or
 * a crash between the append and anything later) is caught up at open by
 * feeding the missing events through the same planner.
 */
export class SessionStore {
  private readonly db: Database;
  private readonly repos: RepoResolver;
  private readonly indexCache = new Map<SessionId, IndexCache>();

  constructor(options: SessionStoreOptions = {}) {
    this.repos = options.repoResolver ?? new RepoResolver();
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
        trust TEXT,
        base TEXT,
        head TEXT,
        pr TEXT,
        exec_allowlist TEXT,
        title TEXT,
        title_source TEXT,
        parent_id TEXT,
        spawn_depth INTEGER,
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
      CREATE TABLE IF NOT EXISTS imports (
        source_path TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        vendor TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ino INTEGER NOT NULL,
        line INTEGER NOT NULL,
        head TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imports_session ON imports(session_id);
    `);
    // imports (Link phase 4) is NOT a derived table: it records how far each
    // vendor log has been read into the event log, so it survives an index
    // generation bump exactly as the events it accounts for do.
    // M1 databases predate the base/head/pr columns and M2 databases predate
    // trust and exec_allowlist; add them in place. SQLite has no ADD COLUMN IF
    // NOT EXISTS, so a duplicate-column error means the migration already ran.
    // pr holds the SessionPr as JSON and exec_allowlist the frozen fix
    // allowlist as a JSON string array; a null trust reads back as untrusted
    // and a null exec_allowlist as no allowlist at all (record 0009).
    // Link adds title, title_source, parent_id and spawn_depth the same way;
    // all nullable, so a pre-Link row reads back untitled and parentless.
    const columns: Array<[string, string]> = [
      ["base", "TEXT"],
      ["head", "TEXT"],
      ["pr", "TEXT"],
      ["trust", "TEXT"],
      ["exec_allowlist", "TEXT"],
      ["title", "TEXT"],
      ["title_source", "TEXT"],
      ["parent_id", "TEXT"],
      ["spawn_depth", "INTEGER"],
    ];
    for (const [column, type] of columns) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type};`);
      } catch {
        // Column already present.
      }
    }
    this.createAgentSessionHistory();
    this.createIndexTables();
    this.backfillIndex();
  }

  /**
   * Every vendor session id each session has had (agent_session_ids). A
   * restore whose vendor session/load fails starts a fresh vendor session
   * and replaces agent_session_id, but the vendor's log of the old one is
   * still on disk, and the importer must still know monad ran it (see
   * agentSessionIds). Not derived: a database from before this table gets
   * it filled once, from the current ids and from the error events that
   * recorded a replaced id (claude.ts writes the old id into them).
   */
  private createAgentSessionHistory(): void {
    this.db.transaction(() => {
      const exists = this.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_ids'")
        .get();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_session_ids (
          session_id TEXT NOT NULL REFERENCES sessions(id),
          agent_session_id TEXT NOT NULL,
          PRIMARY KEY (session_id, agent_session_id)
        );
      `);
      if (!exists) {
        this.db.exec(`
          INSERT OR IGNORE INTO agent_session_ids (session_id, agent_session_id)
            SELECT id, agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL;
          INSERT OR IGNORE INTO agent_session_ids (session_id, agent_session_id)
            SELECT session_id, id FROM (
              SELECT session_id,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.agentSessionId') END AS id
              FROM events WHERE kind = 'error'
            ) WHERE typeof(id) = 'text';
        `);
      }
    })();
  }

  /**
   * The derived index tables. search_fts is an FTS5 table: `text` is the only
   * indexed column and is always redacted (decision record 0012); the rest
   * locate the row in the log. bun:sqlite ships FTS5 on every platform monad
   * runs on (the static Linux build enables it, macOS's system SQLite has
   * it), and a build without it fails here, loudly, at daemon start.
   */
  private createIndexTables(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const stale = (version?.user_version ?? 0) < INDEX_GENERATION;
    if (stale) {
      // index_state is pure bookkeeping, and its columns change between
      // generations; recreate it rather than migrate it.
      this.db.exec("DROP TABLE IF EXISTS index_state;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_repos (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        repo_root TEXT NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, repo_root)
      );
      CREATE INDEX IF NOT EXISTS idx_session_repos_root ON session_repos(repo_root);
      CREATE TABLE IF NOT EXISTS index_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id),
        last_indexed_seq INTEGER NOT NULL DEFAULT 0,
        open_rowid INTEGER,
        open_bytes INTEGER NOT NULL DEFAULT 0,
        settling_rowid INTEGER
      );
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
          text,
          session_id UNINDEXED,
          kind UNINDEXED,
          first_seq UNINDEXED,
          last_seq UNINDEXED,
          ts UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `);
    } catch (error) {
      throw new Error(
        `this SQLite build has no FTS5, which monad's session index needs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stale) {
      // Older generation (or a pre-Link database): drop every derived row and
      // let backfill rebuild them from the log. Titles are not wiped; a
      // derived title only ever fills an empty one.
      this.db.transaction(() => {
        this.db.exec("DELETE FROM search_fts; DELETE FROM session_repos; DELETE FROM index_state;");
        this.db.exec(`PRAGMA user_version = ${INDEX_GENERATION};`);
      })();
    }
  }

  /** Inserts a new session record. Throws if the id already exists. */
  create(record: SessionRecord): SessionRecord {
    const parsed = SessionRecordSchema.parse(record);
    this.db
      .query(
        `INSERT INTO sessions (id, cwd, backend, agent_session_id, mode, status, trust, base, head, pr, exec_allowlist, title, title_source, parent_id, spawn_depth, created_at, updated_at)
         VALUES ($id, $cwd, $backend, $agentSessionId, $mode, $status, $trust, $base, $head, $pr, $execAllowlist, $title, $titleSource, $parentId, $spawnDepth, $createdAt, $updatedAt)`,
      )
      .run({
        id: parsed.id,
        cwd: parsed.cwd,
        backend: parsed.backend,
        agentSessionId: parsed.agentSessionId ?? null,
        mode: parsed.mode,
        status: parsed.status,
        trust: parsed.trust,
        base: parsed.base ?? null,
        head: parsed.head ?? null,
        pr: parsed.pr === undefined ? null : JSON.stringify(parsed.pr),
        execAllowlist:
          parsed.execAllowlist === undefined ? null : JSON.stringify(parsed.execAllowlist),
        title: parsed.title ?? null,
        titleSource: parsed.title === undefined ? null : (parsed.titleSource ?? null),
        parentId: parsed.parentId ?? null,
        spawnDepth: parsed.spawnDepth ?? null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    return parsed;
  }

  /**
   * Appends one event and returns it with its assigned sequence number. The
   * event, the updated_at bump and the index writes it implies commit
   * together, so the index can never run ahead of the log; the indexer never
   * fails an append (see indexOne).
   */
  append(sessionId: SessionId, kind: EventKind, payload: unknown): EventRecord {
    const ts = new Date().toISOString();
    const { event, cache } = this.db.transaction(() => {
      const appended = this.insertEvent(sessionId, kind, payload, ts, false);
      return { event: appended, cache: this.indexOne(appended, this.loadIndexCache(sessionId)) };
    })();
    // Only a committed transaction updates the in-memory cache; a rolled-back
    // append leaves it exactly as the database is.
    this.setIndexCache(sessionId, cache);
    return event;
  }

  /**
   * One event row, stamped `ts`. updated_at means "last activity", and Link
   * lists sessions by it. An access event records that someone ELSE looked
   * at this session, which is not this session doing anything (decision
   * record 0012). A handoff or summary describes activity rather than being
   * some: counting it would make every idle session look freshly active ten
   * minutes after its last turn, and reorder `monad ls` by when monad wrote
   * about it. An imported event (`historical`) carries the vendor log's own
   * timestamp, and moves updated_at to it, never backwards, so an imported
   * session sorts by when it last did something, not by when monad read it.
   */
  private insertEvent(
    sessionId: SessionId,
    kind: EventKind,
    payload: unknown,
    ts: string,
    historical: boolean,
  ): EventRecord {
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
    if (!PASSIVE_KINDS.has(kind)) {
      if (historical) {
        this.db
          .query("UPDATE sessions SET updated_at = MAX(updated_at, $ts) WHERE id = $id")
          .run({ id: sessionId, ts });
      } else {
        this.touch(sessionId);
      }
    }
    return { seq: row.seq, sessionId, ts, kind, payload: payload ?? null };
  }

  // ------------------------------------------------------------- imports

  /** Where the importer left off in one vendor log file, or undefined if it never read it. */
  importState(sourcePath: string): ImportState | undefined {
    const row = this.db
      .query<ImportRow, { sourcePath: string }>("SELECT * FROM imports WHERE source_path = $sourcePath")
      .get({ sourcePath });
    return row ? rowToImportState(row) : undefined;
  }

  /** The import state of the file a session was read from, if it is an imported session. */
  importStateForSession(sessionId: SessionId): ImportState | undefined {
    const row = this.db
      .query<ImportRow, { sessionId: string }>("SELECT * FROM imports WHERE session_id = $sessionId")
      .get({ sessionId });
    return row ? rowToImportState(row) : undefined;
  }

  /**
   * The vendor session ids of every session monad itself ran, including ids
   * a session had before a failed restore replaced them. The importer skips
   * a vendor log with one of these ids: monad's own log of that session is
   * the canonical one, and importing the vendor's copy would file the same
   * work twice.
   */
  agentSessionIds(): Set<string> {
    return new Set(
      this.db
        .query<{ agent_session_id: string }, []>(
          `SELECT agent_session_id FROM sessions
             WHERE agent_session_id IS NOT NULL AND backend NOT LIKE 'import:%'
           UNION
           SELECT h.agent_session_id FROM agent_session_ids h JOIN sessions s ON s.id = h.session_id
             WHERE s.backend NOT LIKE 'import:%'`,
        )
        .all()
        .map((row) => row.agent_session_id),
    );
  }

  /**
   * Appends one batch of events read from a vendor log, in one transaction
   * with the import state that says how far the file has been read: either
   * both land or neither does, so a crash mid-import never leaves events the
   * state does not account for (they would be appended twice) or a state
   * past events that were never written (they would be lost). `create` is
   * the session record, inserted first when the session does not exist yet.
   * `title`, when given, names the session (source import) unless a human
   * named it. Events keep the vendor log's timestamps and run through the
   * same indexer as every live append, so search, repo tags and titles
   * behave exactly as for a session monad ran. Returns the appended events.
   */
  appendImported(batch: ImportBatch): EventRecord[] {
    const { sessionId } = batch;
    const { events, cache } = this.db.transaction(() => {
      if (batch.create && !this.get(sessionId)) {
        this.create(batch.create);
      }
      if (batch.title !== undefined) {
        // An imported title replaces one the indexer derived from a prompt
        // that was not an ask (a task notification, a slash command), never
        // one a human set.
        this.db
          .query(
            `UPDATE sessions SET title = $title, title_source = 'import'
             WHERE id = $id AND (title_source IS NULL OR title_source <> 'manual')`,
          )
          .run({ id: sessionId, title: batch.title });
        const cached = this.indexCache.get(sessionId);
        if (cached) {
          cached.titled = true;
        }
      }
      let current: IndexCache | undefined = batch.events.length > 0 ? this.loadIndexCache(sessionId) : undefined;
      const appended: EventRecord[] = [];
      for (const item of batch.events) {
        const event = this.insertEvent(sessionId, item.kind, item.payload, item.ts, true);
        current = this.indexOne(event, current ?? this.loadIndexCache(sessionId));
        appended.push(event);
      }
      this.saveImportState(batch.state);
      return { events: appended, cache: current };
    })();
    if (cache) {
      this.setIndexCache(sessionId, cache);
    }
    return events;
  }

  /**
   * Moves an import state to another source path (the importer adopting a
   * copy of a log whose original is gone) in one step.
   */
  moveImportState(fromPath: string, state: ImportState): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM imports WHERE source_path = $fromPath").run({ fromPath });
      this.saveImportState(state);
    })();
  }

  /**
   * Forgets everything an imported session was read from its vendor log, so
   * the importer can read the file again from the start (it was truncated
   * or replaced). The session record stays, and so do the events monad
   * itself wrote ABOUT the session (access, handoff, summary): the access
   * record is the audit trail of who read it, and a reset must not erase
   * that. Its index rows and repo tags are dropped and rebuilt from what
   * remains, through the same indexer, so nothing is left behind twice. A
   * title a human set survives; an imported or derived one is re-derived.
   */
  resetImported(sessionId: SessionId): void {
    this.db.transaction(() => {
      this.db
        .query(
          `DELETE FROM events WHERE session_id = $sessionId
             AND kind NOT IN ('access', 'handoff', 'summary')`,
        )
        .run({ sessionId });
      this.db.query("DELETE FROM search_fts WHERE session_id = $sessionId").run({ sessionId });
      this.db.query("DELETE FROM session_repos WHERE session_id = $sessionId").run({ sessionId });
      this.db.query("DELETE FROM index_state WHERE session_id = $sessionId").run({ sessionId });
      this.db.query("DELETE FROM imports WHERE session_id = $sessionId").run({ sessionId });
      this.db
        .query(
          `UPDATE sessions SET title = NULL, title_source = NULL
           WHERE id = $sessionId AND (title_source IS NULL OR title_source <> 'manual')`,
        )
        .run({ sessionId });
    })();
    this.indexCache.delete(sessionId);
    this.indexSession(sessionId, 0);
  }

  private saveImportState(state: ImportState): void {
    this.db
      .query(
        `INSERT INTO imports (source_path, session_id, vendor, byte_offset, size, mtime_ms, ino, line, head)
         VALUES ($sourcePath, $sessionId, $vendor, $offset, $size, $mtimeMs, $ino, $line, $head)
         ON CONFLICT (source_path) DO UPDATE SET
           session_id = excluded.session_id,
           vendor = excluded.vendor,
           byte_offset = excluded.byte_offset,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           ino = excluded.ino,
           line = excluded.line,
           head = excluded.head`,
      )
      .run({
        sourcePath: state.sourcePath,
        sessionId: state.sessionId,
        vendor: state.vendor,
        offset: state.offset,
        size: state.size,
        mtimeMs: state.mtimeMs,
        ino: state.ino,
        line: state.line,
        head: state.head,
      });
  }

  /**
   * Catches the index up with the log: every session whose newest event is
   * past its index_state.last_indexed_seq has the missing events fed through
   * the same planner append() uses (full-text rows, repo tags, title).
   * Idempotent by construction, since an event at or below last_indexed_seq
   * is never fed twice. Runs at open; returns how many events it indexed.
   */
  backfillIndex(): number {
    const pending = this.db
      .query<{ id: string; done: number; max_seq: number | null }, []>(
        `SELECT s.id AS id,
                COALESCE(i.last_indexed_seq, 0) AS done,
                (SELECT MAX(seq) FROM events e WHERE e.session_id = s.id) AS max_seq
         FROM sessions s LEFT JOIN index_state i ON i.session_id = s.id
         ORDER BY s.created_at ASC, s.id ASC`,
      )
      .all()
      .filter((row) => row.max_seq !== null && row.max_seq > row.done);
    let indexed = 0;
    for (const { id, done } of pending) {
      indexed += this.indexSession(id, done);
    }
    return indexed;
  }

  /** Feeds a session's events after seq `after` through the indexer, in batches. */
  private indexSession(id: SessionId, after: number): number {
    let indexed = 0;
    let cursor = after;
    for (;;) {
      const rows = this.db
        .query<EventRow, { sessionId: string; after: number; limit: number }>(
          `SELECT seq, session_id, ts, kind, payload FROM events
           WHERE session_id = $sessionId AND seq > $after
           ORDER BY seq ASC LIMIT $limit`,
        )
        .all({ sessionId: id, after: cursor, limit: BACKFILL_BATCH });
      if (rows.length === 0) {
        break;
      }
      const cache = this.db.transaction(() => {
        let current = this.loadIndexCache(id);
        for (const row of rows) {
          current = this.indexOne(rowToEvent(row), current);
        }
        return current;
      })();
      this.setIndexCache(id, cache);
      indexed += rows.length;
      cursor = rows[rows.length - 1]?.seq ?? cursor;
    }
    return indexed;
  }

  /**
   * Returns a session's events in seq order, starting at fromSeq inclusive.
   * With the default of 0 the whole log is returned; pass lastSeenSeq + 1 to
   * resume. `limit` caps how many events come back.
   */
  replay(sessionId: SessionId, fromSeq = 0, limit?: number): EventRecord[] {
    if (limit !== undefined) {
      // A bounded window, for readers that page (Link's sessions_read).
      return this.db
        .query<EventRow, { sessionId: string; fromSeq: number; limit: number }>(
          `SELECT seq, session_id, ts, kind, payload FROM events
           WHERE session_id = $sessionId AND seq >= $fromSeq
           ORDER BY seq ASC LIMIT $limit`,
        )
        .all({ sessionId, fromSeq, limit: Math.max(0, Math.trunc(limit)) })
        .map(rowToEvent);
    }
    const rows = this.db
      .query<EventRow, { sessionId: string; fromSeq: number }>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND seq >= $fromSeq
         ORDER BY seq ASC`,
      )
      .all({ sessionId, fromSeq });
    return rows.map(rowToEvent);
  }

  /**
   * A session's events of the given kinds only, in seq order. The fix policy
   * uses this to reconstruct which files the session was granted permission
   * to edit without replaying an entire turn's worth of update events on
   * every permission decision.
   */
  replayKinds(sessionId: SessionId, kinds: EventKind[]): EventRecord[] {
    if (kinds.length === 0) {
      return [];
    }
    const params: Record<string, string> = { sessionId };
    const placeholders = kinds.map((kind, index) => {
      params[`kind${index}`] = kind;
      return `$kind${index}`;
    });
    const rows = this.db
      .query<EventRow, Record<string, string>>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND kind IN (${placeholders.join(", ")})
         ORDER BY seq ASC`,
      )
      .all(params);
    return rows.map(rowToEvent);
  }

  /**
   * All sessions, oldest first. Ordered by created_at, then id: monad's own
   * v7 ids sort by creation time, but imported sessions keep vendor v4 ids,
   * which sort randomly.
   */
  list(): SessionRecord[] {
    const rows = this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY created_at ASC, id ASC")
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

  /**
   * Freezes the fix policy's execute allowlist on the record. Written once,
   * when a session first enters fix mode; the SessionManager never calls this
   * a second time for a session, so the worktree cannot widen it later
   * (decision record 0009).
   */
  setExecAllowlist(id: SessionId, execAllowlist: string[]): void {
    const result = this.db
      .query(
        "UPDATE sessions SET exec_allowlist = $execAllowlist, updated_at = $updatedAt WHERE id = $id",
      )
      .run({ id, execAllowlist: JSON.stringify(execAllowlist), updatedAt: new Date().toISOString() });
    if (result.changes === 0) {
      throw new Error(`setExecAllowlist: unknown session ${id}`);
    }
  }

  /** Sets the session's vendor session id, keeping every earlier one in agent_session_ids. */
  setAgentSessionId(id: SessionId, agentSessionId: string): void {
    this.db.transaction(() => {
      const result = this.db
        .query(
          "UPDATE sessions SET agent_session_id = $agentSessionId, updated_at = $updatedAt WHERE id = $id",
        )
        .run({ id, agentSessionId, updatedAt: new Date().toISOString() });
      if (result.changes === 0) {
        throw new Error(`setAgentSessionId: unknown session ${id}`);
      }
      this.db
        .query("INSERT OR IGNORE INTO agent_session_ids (session_id, agent_session_id) VALUES ($id, $agentSessionId)")
        .run({ id, agentSessionId });
    })();
  }

  /**
   * Sets a session's title. `manual` titles come from a human over the
   * control API and are never replaced by derivation; `import` titles come
   * from an imported vendor log. Deliberately does not bump updated_at:
   * updated_at means "last activity", and Link lists sessions by it.
   */
  setTitle(id: SessionId, title: string, source: TitleSource): void {
    const result = this.db
      .query("UPDATE sessions SET title = $title, title_source = $source WHERE id = $id")
      .run({ id, title, source });
    if (result.changes === 0) {
      throw new Error(`setTitle: unknown session ${id}`);
    }
    const cache = this.indexCache.get(id);
    if (cache) {
      cache.titled = true;
    }
  }

  /**
   * Drops a session's title and derives it again from its prompts, exactly as
   * indexing would have: the first prompt with a usable first line wins. A
   * session with no such prompt is left untitled, and its next prompt names it.
   */
  resetTitle(id: SessionId): void {
    this.db.transaction(() => {
      const result = this.db
        .query("UPDATE sessions SET title = NULL, title_source = NULL WHERE id = $id")
        .run({ id });
      if (result.changes === 0) {
        throw new Error(`resetTitle: unknown session ${id}`);
      }
      let title: string | undefined;
      for (const event of this.replayKinds(id, ["prompt"])) {
        title = planIndex(event, { titled: false }).title;
        if (title !== undefined) {
          break;
        }
      }
      if (title !== undefined) {
        this.db
          .query("UPDATE sessions SET title = $title, title_source = 'prompt' WHERE id = $id")
          .run({ id, title });
      }
    })();
    this.indexCache.delete(id);
  }

  /**
   * Full-text search over every session's index. The query is free text
   * (see toFtsQuery for exactly how it is read); it never reaches MATCH as
   * written. Hits from what sessions said (prompts, agent text, errors,
   * handoffs, summaries) come before hits on tool call rows, each tier
   * ordered by bm25 relevance, then newest first; each hit carries the seq
   * range of the log it came from.
   *
   * The tiers exist because bm25 normalizes by row length. A tool call row is
   * a title and a few paths, so a query naming a file or a topic matches it
   * almost exactly, and most of the index is such rows. Measured live
   * (acceptance run 1): for "meshyy scroll", every one of the first sixteen
   * hits was a tool row (Reads of a brief whose file name holds both words,
   * edits to ScrollOracle*.swift), and the session whose prompts reported
   * the bug and whose replies explained each fix was seventeenth, behind
   * sessions that had only opened a file. The agent read those instead.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const match = toFtsQuery(query);
    if (match === undefined) {
      return [];
    }
    if (options.sessionIds?.length === 0 || options.kinds?.length === 0) {
      return [];
    }
    // Any non-finite limit (NaN from a parsed `?limit=abc`, Infinity) means
    // the default; binding NaN to LIMIT would throw "datatype mismatch".
    const requested = Number(options.limit);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 20;
    const requestedCap = Number(options.maxPerSession);
    const perSession = Number.isFinite(requestedCap) ? Math.max(Math.trunc(requestedCap), 1) : undefined;
    const params: Record<string, string | number> = {
      match,
      limit: perSession === undefined ? limit : CAPPED_SEARCH_SCAN,
      open: SNIPPET_OPEN,
      close: SNIPPET_CLOSE,
    };
    const where = ["search_fts MATCH $match"];
    if (options.repo !== undefined) {
      where.push("session_id IN (SELECT session_id FROM session_repos WHERE repo_root = $repo)");
      params.repo = options.repo;
    }
    if (options.since !== undefined) {
      where.push("ts >= $since");
      params.since = options.since;
    }
    if (options.sessionIds !== undefined) {
      const names = options.sessionIds.map((sessionId, index) => {
        params[`session${index}`] = sessionId;
        return `$session${index}`;
      });
      where.push(`session_id IN (${names.join(", ")})`);
    }
    if (options.excludeSessionIds !== undefined && options.excludeSessionIds.length > 0) {
      const names = options.excludeSessionIds.map((sessionId, index) => {
        params[`excluded${index}`] = sessionId;
        return `$excluded${index}`;
      });
      where.push(`session_id NOT IN (${names.join(", ")})`);
    }
    if (options.kinds !== undefined) {
      const names = options.kinds.map((kind, index) => {
        params[`kind${index}`] = kind;
        return `$kind${index}`;
      });
      where.push(`kind IN (${names.join(", ")})`);
    }
    let rows: SearchRow[];
    try {
      rows = this.runSearch(where, params);
    } catch (error) {
      // toFtsQuery's output should never be a bad MATCH expression; if one
      // ever is, a query the user typed is not a server error. Anything
      // else (a locked or corrupt database) still throws.
      if (error instanceof Error && /fts5: syntax error|unterminated string|malformed MATCH/i.test(error.message)) {
        return [];
      }
      throw error;
    }
    if (perSession !== undefined) {
      const taken = new Map<string, number>();
      rows = rows
        .filter((row) => {
          const count = taken.get(row.session_id) ?? 0;
          taken.set(row.session_id, count + 1);
          return count < perSession;
        })
        .slice(0, limit);
    }
    return rows.map((row) => ({
      sessionId: row.session_id,
      kind: row.kind,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
      ts: row.ts,
      snippet: row.snippet,
      rank: row.rank,
    }));
  }

  private runSearch(where: string[], params: Record<string, string | number>): SearchRow[] {
    return this.db
      .query<
        SearchRow,
        Record<string, string | number>
      >(
        `SELECT session_id, kind, first_seq, last_seq, ts,
                snippet(search_fts, 0, $open, $close, '...', 16) AS snippet,
                bm25(search_fts) AS rank
         FROM search_fts
         WHERE ${where.join(" AND ")}
         ORDER BY (kind = 'tool') ASC, rank ASC, ts DESC
         LIMIT $limit`,
      )
      .all(params);
  }

  /** The repositories a session touched, in the order it first touched them. */
  reposFor(sessionId: SessionId): SessionRepo[] {
    return this.db
      .query<{ repo_root: string; first_seq: number; last_seq: number }, { sessionId: string }>(
        `SELECT repo_root, first_seq, last_seq FROM session_repos
         WHERE session_id = $sessionId ORDER BY first_seq ASC, repo_root ASC`,
      )
      .all({ sessionId })
      .map((row) => ({ repoRoot: row.repo_root, firstSeq: row.first_seq, lastSeq: row.last_seq }));
  }

  /** Sessions that touched a repository root, most recently touched first. */
  sessionsForRepo(repoRoot: string): SessionId[] {
    return this.db
      .query<{ session_id: string }, { repoRoot: string }>(
        `SELECT session_id FROM session_repos
         WHERE repo_root = $repoRoot ORDER BY last_seq DESC`,
      )
      .all({ repoRoot })
      .map((row) => row.session_id);
  }

  /**
   * Sessions spawned by this one (Link sessions_spawn), oldest first. The
   * link lives on the child's record as parent_id.
   */
  childrenOf(parentId: SessionId): SessionRecord[] {
    return this.db
      .query<SessionRow, { parentId: string }>(
        "SELECT * FROM sessions WHERE parent_id = $parentId ORDER BY created_at ASC, id ASC",
      )
      .all({ parentId })
      .map(rowToSession);
  }

  /** A session's newest event of one kind, if it has any. */
  lastEventOfKind(sessionId: SessionId, kind: EventKind): EventRecord | undefined {
    const row = this.db
      .query<EventRow, { sessionId: string; kind: string }>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND kind = $kind
         ORDER BY seq DESC LIMIT 1`,
      )
      .get({ sessionId, kind });
    return row ? rowToEvent(row) : undefined;
  }

  /** A session's newest event of any of these kinds, if it has one. */
  lastEventOfKinds(sessionId: SessionId, kinds: EventKind[]): EventRecord | undefined {
    if (kinds.length === 0) {
      return undefined;
    }
    const params: Record<string, string> = { sessionId };
    const placeholders = kinds.map((kind, index) => {
      params[`kind${index}`] = kind;
      return `$kind${index}`;
    });
    const row = this.db
      .query<EventRow, Record<string, string>>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND kind IN (${placeholders.join(", ")})
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(params);
    return row ? rowToEvent(row) : undefined;
  }

  /**
   * A session's newest events of one kind, at most `limit`, returned oldest
   * first. Handoffs use it for the last few asks and errors without
   * replaying the whole log.
   */
  lastEventsOfKind(sessionId: SessionId, kind: EventKind, limit: number): EventRecord[] {
    return this.db
      .query<EventRow, { sessionId: string; kind: string; limit: number }>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND kind = $kind
         ORDER BY seq DESC LIMIT $limit`,
      )
      .all({ sessionId, kind, limit: Math.max(0, Math.trunc(limit)) })
      .map(rowToEvent)
      .reverse();
  }

  /** Checkpoints the WAL and closes the database. */
  close(): void {
    this.indexCache.clear();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.close();
  }

  /**
   * Indexes one event inside the caller's transaction and returns the
   * session's next index state. The planner's writes run in a nested
   * transaction (a SAVEPOINT): if indexing throws, its partial writes roll
   * back, the event itself still commits, and last_indexed_seq moves past it
   * so backfill does not retry it forever. A missed search hit is a far
   * smaller failure than a session that can no longer append. The warning
   * names the session and seq only, never payload text.
   */
  private indexOne(event: EventRecord, cache: IndexCache): IndexCache {
    try {
      return this.db.transaction(() => this.applyIndexPlan(event, cache))();
    } catch (error) {
      console.warn(
        `monad: indexing session ${event.sessionId} seq ${event.seq} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const next: IndexCache = { ...cache, lastIndexedSeq: event.seq, open: undefined, settling: undefined };
      this.saveIndexState(event.sessionId, next);
      return next;
    }
  }

  private applyIndexPlan(event: EventRecord, cache: IndexCache): IndexCache {
    const plan = planIndex(event, { open: cache.open, settling: cache.settling, titled: cache.titled });
    let open = cache.open;
    let settling = cache.settling;
    let titled = cache.titled;
    for (const op of plan.ops) {
      switch (op.type) {
        case "close":
          open = undefined;
          settling = undefined;
          break;
        case "split":
          if (!open) {
            throw new Error("index plan split an agent row that is not open");
          }
          settling = { rowid: open.rowid, context: open.context, raw: open.raw };
          open = undefined;
          break;
        case "insert":
          this.insertFtsRow(event.sessionId, op.kind, op.text, op.firstSeq, op.lastSeq, op.ts);
          break;
        case "open": {
          const rowid = this.insertFtsRow(
            event.sessionId,
            "agent",
            op.text,
            op.firstSeq,
            op.lastSeq,
            op.ts,
          );
          open = { rowid, firstSeq: op.firstSeq, context: op.context, raw: op.raw };
          break;
        }
        case "extend": {
          if (!open) {
            throw new Error("index plan extended an agent row that is not open");
          }
          this.db
            .query("UPDATE search_fts SET text = $text, last_seq = $lastSeq WHERE rowid = $rowid")
            .run({ text: op.text, lastSeq: op.lastSeq, rowid: open.rowid });
          open = { ...open, raw: op.raw };
          break;
        }
        case "settle": {
          if (!settling) {
            throw new Error("index plan settled an agent row that is not settling");
          }
          this.db
            .query("UPDATE search_fts SET text = $text WHERE rowid = $rowid")
            .run({ text: op.text, rowid: settling.rowid });
          if (op.done) {
            settling = undefined;
          }
          break;
        }
      }
    }
    if (plan.title !== undefined && !titled) {
      // The IS NULL guard keeps a manual title set by another writer safe.
      this.db
        .query(
          "UPDATE sessions SET title = $title, title_source = 'prompt' WHERE id = $id AND title IS NULL",
        )
        .run({ id: event.sessionId, title: plan.title });
      titled = true;
    }
    const roots = new Set<string>();
    for (const path of eventPaths(event, cache.cwd)) {
      const root = this.repos.resolve(path, cache.cwd);
      if (root !== undefined) {
        roots.add(root);
      }
    }
    for (const root of roots) {
      this.db
        .query(
          `INSERT INTO session_repos (session_id, repo_root, first_seq, last_seq)
           VALUES ($sessionId, $root, $seq, $seq)
           ON CONFLICT (session_id, repo_root) DO UPDATE SET
             first_seq = MIN(first_seq, excluded.first_seq),
             last_seq = MAX(last_seq, excluded.last_seq)`,
        )
        .run({ sessionId: event.sessionId, root, seq: event.seq });
    }
    const next: IndexCache = { cwd: cache.cwd, titled, lastIndexedSeq: event.seq, open, settling };
    this.saveIndexState(event.sessionId, next);
    return next;
  }

  private insertFtsRow(
    sessionId: SessionId,
    kind: SearchKind,
    text: string,
    firstSeq: number,
    lastSeq: number,
    ts: string,
  ): number {
    const result = this.db
      .query(
        `INSERT INTO search_fts (text, session_id, kind, first_seq, last_seq, ts)
         VALUES ($text, $sessionId, $kind, $firstSeq, $lastSeq, $ts)`,
      )
      .run({ text, sessionId, kind, firstSeq, lastSeq, ts });
    return Number(result.lastInsertRowid);
  }

  private saveIndexState(sessionId: SessionId, cache: IndexCache): void {
    this.db
      .query(
        `INSERT INTO index_state (session_id, last_indexed_seq, open_rowid, open_bytes, settling_rowid)
         VALUES ($sessionId, $seq, $openRowid, $openBytes, $settlingRowid)
         ON CONFLICT (session_id) DO UPDATE SET
           last_indexed_seq = excluded.last_indexed_seq,
           open_rowid = excluded.open_rowid,
           open_bytes = excluded.open_bytes,
           settling_rowid = excluded.settling_rowid`,
      )
      .run({
        sessionId,
        seq: cache.lastIndexedSeq,
        openRowid: cache.open?.rowid ?? null,
        openBytes: cache.open ? Buffer.byteLength(cache.open.raw) : 0,
        settlingRowid: cache.settling?.rowid ?? null,
      });
  }

  private setIndexCache(sessionId: SessionId, cache: IndexCache): void {
    this.indexCache.set(sessionId, cache);
  }

  /**
   * The session's index state, from memory or rebuilt from the database. An
   * open agent row's unredacted text is not stored anywhere but the log
   * (keeping a second raw copy would be one more place a token lives), so a
   * cold start replays the current turn's agent chunks through the same
   * row logic live indexing used, which also restores the open row's
   * redaction context and any row still settling after a split.
   */
  private loadIndexCache(sessionId: SessionId): IndexCache {
    const cached = this.indexCache.get(sessionId);
    if (cached) {
      return cached;
    }
    const session = this.db
      .query<{ cwd: string; title: string | null }, { id: string }>(
        "SELECT cwd, title FROM sessions WHERE id = $id",
      )
      .get({ id: sessionId });
    if (!session) {
      throw new Error(`index: unknown session ${sessionId}`);
    }
    const state = this.db
      .query<
        { last_indexed_seq: number; open_rowid: number | null; settling_rowid: number | null },
        { sessionId: string }
      >("SELECT last_indexed_seq, open_rowid, settling_rowid FROM index_state WHERE session_id = $sessionId")
      .get({ sessionId });
    const lastIndexedSeq = state?.last_indexed_seq ?? 0;
    let open: OpenAgentRow | undefined;
    let settling: SettlingAgentRow | undefined;
    if (state?.open_rowid !== null && state?.open_rowid !== undefined) {
      const span = this.db
        .query<{ first_seq: number }, { rowid: number }>("SELECT first_seq FROM search_fts WHERE rowid = $rowid")
        .get({ rowid: state.open_rowid });
      if (span) {
        const rows = this.replayTurn(sessionId, lastIndexedSeq);
        if (rows.open && rows.open.firstSeq === span.first_seq) {
          open = { ...rows.open, rowid: state.open_rowid };
          if (rows.settling && state.settling_rowid !== null) {
            settling = { ...rows.settling, rowid: state.settling_rowid };
          }
        } else {
          // The replay disagrees with the stored row (an indexing failure
          // dropped a row mid-turn): extend the stored row from its own
          // chunks, with no context, rather than guess.
          const chunks = this.agentChunks(sessionId, span.first_seq - 1, lastIndexedSeq);
          open = {
            rowid: state.open_rowid,
            firstSeq: span.first_seq,
            context: "",
            raw: chunks.map((chunk) => chunk.text).join(""),
          };
        }
      }
    }
    return { cwd: session.cwd, titled: session.title !== null, lastIndexedSeq, open, settling };
  }

  /** The agent rows of the turn in progress at `upTo`, rebuilt from the log. */
  private replayTurn(sessionId: SessionId, upTo: number) {
    // The last event at or before upTo that closes agent rows starts the turn.
    const start = this.db
      .query<{ seq: number | null }, { sessionId: string; upTo: number }>(
        `SELECT MAX(seq) AS seq FROM events
         WHERE session_id = $sessionId AND seq <= $upTo
           AND kind IN ('prompt', 'turn_ended', 'error', 'closed')`,
      )
      .get({ sessionId, upTo });
    return replayAgentRows(this.agentChunks(sessionId, start?.seq ?? 0, upTo));
  }

  /** Agent message chunk texts with after < seq <= upTo, in seq order. */
  private agentChunks(sessionId: SessionId, after: number, upTo: number): Array<{ seq: number; text: string }> {
    const chunks: Array<{ seq: number; text: string }> = [];
    const rows = this.db
      .query<EventRow, { sessionId: string; after: number; upTo: number }>(
        `SELECT seq, session_id, ts, kind, payload FROM events
         WHERE session_id = $sessionId AND kind = 'update' AND seq > $after AND seq <= $upTo
         ORDER BY seq ASC`,
      )
      .all({ sessionId, after, upTo });
    for (const row of rows) {
      const text = agentChunkText(rowToEvent(row));
      if (text !== undefined) {
        chunks.push({ seq: row.seq, text });
      }
    }
    return chunks;
  }

  private touch(id: SessionId): void {
    this.db
      .query("UPDATE sessions SET updated_at = $updatedAt WHERE id = $id")
      .run({ id, updatedAt: new Date().toISOString() });
  }
}
