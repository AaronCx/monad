import { methods } from "@agentclientprotocol/sdk";
import {
  cancelSession,
  connectAcp,
  ensureDaemon,
  fetchSessions,
  type ReviewResultLine,
  setSessionMode,
  streamReview,
} from "@aaroncx/engine";
import type { EventRecord, SessionMode, SessionRecord } from "@aaroncx/protocol";

/**
 * How monad-hook reaches monadd.
 *
 * Every method is the shared client from @aaroncx/engine, which is the same
 * authenticated HTTP the CLI uses; there is no second client and no second
 * idea of where the daemon is. What this interface adds is a seam: the
 * worker takes a DaemonAccess, so a test can drive the scheduling, the
 * supersede path, and the backoff without a daemon, while the end-to-end
 * test hands it the live one.
 */
export interface DaemonAccess {
  /** Starts monadd when it is not running. Throws when it cannot. */
  ensure(): Promise<void>;
  /** POST /v1/review, streaming the playbook's events as they happen. */
  review(body: unknown, onEvent: (event: EventRecord) => void): Promise<ReviewResultLine>;
  /** POST /v1/sessions/<id>/cancel: what supersede does to a running review. */
  cancel(sessionId: string): Promise<void>;
  sessions(): Promise<SessionRecord[]>;
  setMode(sessionId: string, mode: SessionMode): Promise<SessionRecord>;
  /** Sends prompts to an existing session over ACP, in order. */
  prompt(record: SessionRecord, texts: string[]): Promise<void>;
}

/**
 * The permission answer monad-hook gives, which is none.
 *
 * The fix policy forwards a non-allowlisted execute (git push above all) to
 * the attached human and holds it when nobody is attached. A client that
 * ANSWERS that question is the human, so monad-hook must not: it rejects,
 * the daemon's policy treats the rejection like a client that vanished, and
 * the request is held for whoever runs `monad attach <id>`. This one
 * rejection is what "fix mode from a webhook never pushes" is made of.
 */
const NO_HUMAN_HERE =
  "monad-hook cannot answer permission requests: an unattended session has no human, " +
  "so the request is held for monad attach";

export function liveDaemonAccess(): DaemonAccess {
  return {
    async ensure(): Promise<void> {
      await ensureDaemon();
    },
    async review(body, onEvent): Promise<ReviewResultLine> {
      return streamReview(await ensureDaemon(), body, onEvent);
    },
    async cancel(sessionId): Promise<void> {
      await cancelSession(await ensureDaemon(), sessionId);
    },
    async sessions(): Promise<SessionRecord[]> {
      return fetchSessions(await ensureDaemon());
    },
    async setMode(sessionId, mode): Promise<SessionRecord> {
      return setSessionMode(await ensureDaemon(), sessionId, mode);
    },
    async prompt(record, texts): Promise<void> {
      const handle = await ensureDaemon();
      const session = await connectAcp(
        handle,
        { requestPermission: () => Promise.reject(new Error(NO_HUMAN_HERE)) },
        { name: "monad-hook" },
      );
      try {
        await session.connection.agent.request(methods.agent.session.load, {
          sessionId: record.id,
          cwd: record.cwd,
          mcpServers: [],
        });
        for (const text of texts) {
          await session.connection.agent.request(methods.agent.session.prompt, {
            sessionId: record.id,
            prompt: [{ type: "text", text }],
          });
        }
      } finally {
        session.connection.close();
      }
    },
  };
}

/**
 * The session a comment command acts on: the newest session monad opened for
 * that pull request that is still open. Review sessions are left idle rather
 * than closed exactly so this can find them.
 */
export function sessionForPr(
  sessions: SessionRecord[],
  repo: string,
  number: number,
): SessionRecord | undefined {
  const candidates = sessions.filter(
    (record) =>
      record.pr?.repo === repo && record.pr?.number === number && record.status !== "closed",
  );
  // Ids are uuid v7, so lexicographic order is creation order.
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).at(-1);
}
