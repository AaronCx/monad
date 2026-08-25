import { Database } from "bun:sqlite";

/**
 * Reading a session's log from outside the daemon.
 *
 * @monad status answers with the session's last event, and the event log is
 * the daemon's own table in the same database. This opens it read only: the
 * daemon owns the writes, and a second writer on that table is not something
 * a status reply is worth.
 */

export interface LastEvent {
  kind: string;
  ts: string;
}

export function lastEventOf(dbPath: string, sessionId: string): LastEvent | undefined {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, strict: true });
    const row = db
      .query<{ kind: string; ts: string }, { sessionId: string }>(
        "SELECT kind, ts FROM events WHERE session_id = $sessionId ORDER BY seq DESC LIMIT 1",
      )
      .get({ sessionId });
    return row ?? undefined;
  } catch {
    // A database that is not there yet, or a table that is not, is not worth
    // failing a status reply over.
    return undefined;
  } finally {
    db?.close();
  }
}
