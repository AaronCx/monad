import type { ReviewResultLine } from "@aaroncx/engine";
import type { EventRecord, SessionMode, SessionRecord } from "@aaroncx/protocol";
import { HEAD_SHA } from "../../../../packages/github/test/fixtures/payloads.ts";
import type { DaemonAccess } from "../../src/daemon.ts";

/**
 * monadd, faked at the DaemonAccess seam.
 *
 * The worker's scheduling, supersede, and backoff are what these tests are
 * about, and driving a real vendor session for each of them would trade
 * minutes of test time for nothing: the real daemon is exercised end to end
 * in e2e.test.ts, against the real playbook and the real fake agent.
 */

export interface ReviewCall {
  body: {
    repoRoot: string;
    pr: { repo: string; number: number; headSha: string; title: string };
    trust: "trusted" | "untrusted";
  };
  onEvent: (event: EventRecord) => void;
  resolve: (result: ReviewResultLine) => void;
  reject: (error: Error) => void;
  /** Set when this review's session was cancelled. */
  cancelled: boolean;
  settled: boolean;
  sessionId: string;
}

let seq = 0;

export function sessionId(): string {
  seq += 1;
  return `0193${String(seq).padStart(4, "0")}-0000-7000-8000-000000000000`;
}

export function eventRecord(
  session: string,
  kind: EventRecord["kind"],
  payload: unknown,
): EventRecord {
  seq += 1;
  return { seq, sessionId: session, ts: new Date().toISOString(), kind, payload };
}

export function reviewResult(overrides: Partial<ReviewResultLine> = {}): ReviewResultLine {
  return {
    type: "result",
    sessionId: overrides.sessionId ?? sessionId(),
    worktree: "/tmp/worktree",
    report: {
      summary: "It looks fine.",
      verdict: "comment",
      findings: [],
      checks_acknowledged: true,
    },
    structured: true,
    checksFailed: false,
    failed: false,
    checksTable: "| check | status | findings |",
    baseSha: "b".repeat(40),
    headSha: HEAD_SHA,
    trust: "untrusted",
    ...overrides,
  } as ReviewResultLine;
}

export class FakeDaemon implements DaemonAccess {
  /** Set to make ensure() throw, which is monadd being down. */
  ensureError: Error | undefined;
  readonly reviews: ReviewCall[] = [];
  readonly cancels: string[] = [];
  readonly modeSwitches: Array<{ sessionId: string; mode: SessionMode }> = [];
  readonly prompts: Array<{ sessionId: string; texts: string[] }> = [];
  sessionList: SessionRecord[] = [];
  /** Set to answer reviews automatically; leave unset to drive them by hand. */
  autoReview: ((call: ReviewCall) => void) | undefined;
  sessionsError: Error | undefined;
  setModeError: Error | undefined;
  promptError: Error | undefined;

  async ensure(): Promise<void> {
    if (this.ensureError) {
      throw this.ensureError;
    }
  }

  review(
    body: unknown,
    onEvent: (event: EventRecord) => void,
  ): Promise<ReviewResultLine> {
    return new Promise<ReviewResultLine>((resolve, reject) => {
      const call: ReviewCall = {
        body: body as ReviewCall["body"],
        onEvent,
        resolve: (result) => {
          call.settled = true;
          resolve(result);
        },
        reject: (error) => {
          call.settled = true;
          reject(error);
        },
        cancelled: false,
        settled: false,
        sessionId: sessionId(),
      };
      this.reviews.push(call);
      this.autoReview?.(call);
    });
  }

  /** What the playbook emits before it gets to work, in log order. */
  announce(call: ReviewCall, results?: unknown): void {
    call.onEvent(
      eventRecord(call.sessionId, "session_created", {
        id: call.sessionId,
        cwd: "/tmp/worktree",
      }),
    );
    if (results !== undefined) {
      call.onEvent(eventRecord(call.sessionId, "checks", results));
    }
  }

  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
    const call = this.reviews.find((review) => review.sessionId === id);
    if (call) {
      call.cancelled = true;
      // The daemon ends the review stream after a cancel: the turn stops and
      // the playbook returns whatever it had, which is an unparsable report.
      call.resolve(
        reviewResult({
          sessionId: id,
          structured: false,
          report: { structured: false, raw: "cancelled" },
          failed: true,
        }),
      );
    }
  }

  /** Answers every review still held open, so a test can shut the worker down. */
  settleAll(): void {
    for (const call of this.reviews) {
      if (!call.settled) {
        call.resolve(reviewResult({ sessionId: call.sessionId }));
      }
    }
  }

  async sessions(): Promise<SessionRecord[]> {
    if (this.sessionsError) {
      throw this.sessionsError;
    }
    return this.sessionList;
  }

  async setMode(id: string, mode: SessionMode): Promise<SessionRecord> {
    if (this.setModeError) {
      throw this.setModeError;
    }
    this.modeSwitches.push({ sessionId: id, mode });
    const record = this.sessionList.find((session) => session.id === id);
    if (!record) {
      throw new Error(`fake daemon has no session ${id}`);
    }
    const updated = { ...record, mode };
    this.sessionList = this.sessionList.map((session) =>
      session.id === id ? updated : session,
    );
    return updated;
  }

  async prompt(record: SessionRecord, texts: string[]): Promise<void> {
    if (this.promptError) {
      throw this.promptError;
    }
    this.prompts.push({ sessionId: record.id, texts });
  }
}

export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = overrides.id ?? sessionId();
  return {
    id,
    cwd: "/tmp/worktree",
    backend: "claude-acp",
    mode: "review",
    status: "idle",
    trust: "untrusted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as SessionRecord;
}
