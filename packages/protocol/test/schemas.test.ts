import { describe, expect, test } from "bun:test";
import {
  DaemonInfoSchema,
  DaemonStatusSchema,
  ERROR_NOTIFICATION_METHOD,
  EventKindSchema,
  EventRecordSchema,
  ListSessionsResponseSchema,
  MonadErrorNotificationSchema,
  REPLAY_COUNT_META_KEY,
  SearchHitSchema,
  SessionIdSchema,
  SessionRecordSchema,
  UpdateSessionRequestSchema,
} from "../src/index.ts";

const now = new Date().toISOString();

function makeSessionRecord() {
  return {
    id: Bun.randomUUIDv7(),
    cwd: "/tmp/repo",
    backend: "claude-acp",
    mode: "interactive",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

describe("SessionIdSchema", () => {
  test("accepts a uuid v7", () => {
    expect(SessionIdSchema.safeParse(Bun.randomUUIDv7()).success).toBe(true);
  });

  test("accepts a uuid v4: imported vendor sessions keep their own ids", () => {
    expect(SessionIdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });

  test("rejects junk and a uuid-shaped string with no RFC variant", () => {
    expect(SessionIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(SessionIdSchema.safeParse("").success).toBe(false);
    expect(
      SessionIdSchema.safeParse("019a0000-0000-7000-0000-000000000000").success,
    ).toBe(false);
  });
});

describe("SessionRecordSchema", () => {
  test("accepts a full record, agentSessionId optional", () => {
    const record = makeSessionRecord();
    expect(SessionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      SessionRecordSchema.safeParse({ ...record, agentSessionId: "vendor-1" }).success,
    ).toBe(true);
  });

  test("title, parent and spawn depth are optional and round trip", () => {
    const parent = Bun.randomUUIDv7();
    const record = {
      ...makeSessionRecord(),
      title: "fix the scroll clamp",
      titleSource: "prompt",
      parentId: parent,
      spawnDepth: 1,
    };
    const parsed = SessionRecordSchema.parse(record);
    expect(parsed.title).toBe("fix the scroll clamp");
    expect(parsed.titleSource).toBe("prompt");
    expect(parsed.parentId).toBe(parent);
    expect(parsed.spawnDepth).toBe(1);
  });

  test("an unknown titleSource reads back as absent, not a failed record", () => {
    const parsed = SessionRecordSchema.parse({
      ...makeSessionRecord(),
      title: "t",
      titleSource: "guessed",
    });
    expect(parsed.title).toBe("t");
    expect(parsed.titleSource).toBeUndefined();
  });

  test("a negative spawn depth is rejected", () => {
    expect(
      SessionRecordSchema.safeParse({ ...makeSessionRecord(), spawnDepth: -1 }).success,
    ).toBe(false);
  });

  test("rejects unknown status and backend", () => {
    const record = makeSessionRecord();
    expect(SessionRecordSchema.safeParse({ ...record, status: "paused" }).success).toBe(false);
    expect(SessionRecordSchema.safeParse({ ...record, backend: "codex-acp" }).success).toBe(
      false,
    );
  });
});

describe("EventRecordSchema", () => {
  test("has the exact kind list", () => {
    expect(EventKindSchema.options).toEqual([
      "session_created",
      "prompt",
      "update",
      "permission_requested",
      "permission_resolved",
      "worktree_ready",
      "checks",
      "review_report",
      "turn_ended",
      "error",
      "closed",
    ]);
  });

  test("keeps payloads verbatim, vendor fields included", () => {
    const payload = {
      sessionUpdate: "usage_update",
      some_vendor_field: { nested: true },
      _meta: { "vendor/key": 1 },
    };
    const parsed = EventRecordSchema.parse({
      seq: 1,
      sessionId: Bun.randomUUIDv7(),
      ts: now,
      kind: "update",
      payload,
    });
    expect(parsed.payload).toEqual(payload);
  });
});

describe("control API schemas", () => {
  test("ListSessionsResponse round trip", () => {
    const response = { sessions: [makeSessionRecord()] };
    expect(ListSessionsResponseSchema.safeParse(response).success).toBe(true);
  });

  test("DaemonStatus round trip", () => {
    const status = {
      version: "0.1.0",
      startedAt: now,
      uptimeMs: 1234,
      activeBackends: [{ sessionId: Bun.randomUUIDv7(), backend: "claude-acp" }],
    };
    expect(DaemonStatusSchema.safeParse(status).success).toBe(true);
  });
});

test("replay count meta key is the documented one", () => {
  expect(REPLAY_COUNT_META_KEY).toBe("monad.sh/replayCount");
});

describe("daemon discovery and extension notification schemas", () => {
  test("DaemonInfo round trip", () => {
    const info = { port: 7331, pid: 4242, startedAt: now };
    expect(DaemonInfoSchema.safeParse(info).success).toBe(true);
    expect(DaemonInfoSchema.safeParse({ ...info, port: 0 }).success).toBe(false);
  });

  test("error notification keeps extra context fields", () => {
    expect(ERROR_NOTIFICATION_METHOD).toBe("_monad.sh/error");
    const parsed = MonadErrorNotificationSchema.parse({
      sessionId: Bun.randomUUIDv7(),
      message: "context was not restored",
      agentSessionId: "vendor-123",
    });
    expect(parsed.agentSessionId).toBe("vendor-123");
  });
});

describe("UpdateSessionRequestSchema", () => {
  test("trims a title and accepts null to re-derive", () => {
    expect(UpdateSessionRequestSchema.parse({ title: "  my session  " }).title).toBe(
      "my session",
    );
    expect(UpdateSessionRequestSchema.parse({ title: null }).title).toBeNull();
  });

  test("rejects an empty or oversized title and unknown fields", () => {
    expect(UpdateSessionRequestSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({ title: "a", mode: "fix" }).success).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("SearchHitSchema", () => {
  test("accepts a hit with a seq range", () => {
    expect(
      SearchHitSchema.safeParse({
        sessionId: Bun.randomUUIDv7(),
        kind: "agent",
        firstSeq: 3,
        lastSeq: 9,
        ts: now,
        snippet: "the «scroll» clamp",
        rank: -1.5,
      }).success,
    ).toBe(true);
  });
});
