import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@aaroncx/protocol";
import { SessionStore } from "../src/store.ts";

let dirs: string[] = [];
let stores: SessionStore[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "monad-store-"));
  dirs.push(dir);
  return join(dir, "monad.db");
}

function openStore(dbPath = tempDbPath()): SessionStore {
  const store = new SessionStore({ dbPath });
  stores.push(store);
  return store;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: Bun.randomUUIDv7(),
    cwd: "/tmp/repo",
    backend: "claude-acp",
    mode: "interactive",
    status: "idle",
    // M2 records had no trust level; the column and the default arrived with
    // decision record 0009, so the fixture states one explicitly.
    trust: "trusted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  stores = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("SessionStore trust column", () => {
  test("a row written before decision record 0009 reads back as untrusted", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const record = store.create(makeRecord({ mode: "review" }));
    // Simulate an M2 row: the column exists after the migration but holds
    // NULL, which is exactly what ALTER TABLE ADD COLUMN leaves behind.
    const db = new Database(dbPath, { strict: true });
    db.query("UPDATE sessions SET trust = NULL WHERE id = $id").run({ id: record.id });
    db.close();

    expect(store.get(record.id)?.trust).toBe("untrusted");
    expect(store.list().find((r) => r.id === record.id)?.trust).toBe("untrusted");
  });

  test("a trust level survives a round trip", () => {
    const store = openStore();
    const trusted = store.create(makeRecord({ trust: "trusted" }));
    const untrusted = store.create(makeRecord({ trust: "untrusted" }));
    expect(store.get(trusted.id)?.trust).toBe("trusted");
    expect(store.get(untrusted.id)?.trust).toBe("untrusted");
  });
});

describe("SessionStore events", () => {
  test("append then replay keeps ordering across 1000 events", () => {
    const store = openStore();
    const record = store.create(makeRecord());
    for (let i = 0; i < 1000; i++) {
      store.append(record.id, "update", { i });
    }
    const events = store.replay(record.id);
    expect(events).toHaveLength(1000);
    for (let i = 0; i < 1000; i++) {
      expect(events[i]?.payload).toEqual({ i });
      if (i > 0) {
        expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      }
    }
  });

  test("replay from a sequence number is inclusive", () => {
    const store = openStore();
    const record = store.create(makeRecord());
    const appended = [];
    for (let i = 0; i < 10; i++) {
      appended.push(store.append(record.id, "update", { i }));
    }
    const fromSeq = appended[6]!.seq;
    const events = store.replay(record.id, fromSeq);
    expect(events.map((e) => e.seq)).toEqual(appended.slice(6).map((e) => e.seq));
    expect(events[0]?.payload).toEqual({ i: 6 });
  });

  test("replay only returns the requested session's events, in order", () => {
    const store = openStore();
    const a = store.create(makeRecord());
    const b = store.create(makeRecord());
    for (let i = 0; i < 20; i++) {
      store.append(i % 2 === 0 ? a.id : b.id, "update", { i });
    }
    const eventsA = store.replay(a.id);
    const eventsB = store.replay(b.id);
    expect(eventsA).toHaveLength(10);
    expect(eventsB).toHaveLength(10);
    expect(eventsA.every((e) => e.sessionId === a.id)).toBe(true);
    expect(eventsA.map((e) => (e.payload as { i: number }).i)).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18,
    ]);
  });

  test("payloads round trip verbatim, vendor _meta included", () => {
    const store = openStore();
    const record = store.create(makeRecord());
    const payload = {
      sessionId: "vendor-id",
      update: { sessionUpdate: "usage_update", tokens: { input: 10, output: 3 } },
      _meta: { "vendor/extra": [1, 2, 3] },
    };
    store.append(record.id, "update", payload);
    expect(store.replay(record.id)[0]?.payload).toEqual(payload);
  });

  test("events survive close and reopen (daemon restart)", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", { text: "hello" });
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });
    store.close();

    const reopened = openStore(dbPath);
    const events = reopened.replay(record.id);
    expect(events.map((e) => e.kind)).toEqual(["prompt", "turn_ended"]);
    expect(reopened.get(record.id)?.cwd).toBe("/tmp/repo");
  });
});

describe("SessionStore sessions", () => {
  test("create, get, list", () => {
    const store = openStore();
    const first = store.create(makeRecord());
    const second = store.create(makeRecord());
    expect(store.get(first.id)).toEqual(first);
    expect(store.list().map((s) => s.id)).toEqual([first.id, second.id]);
    expect(store.get(Bun.randomUUIDv7())).toBeUndefined();
  });

  test("setStatus and setAgentSessionId update the record", () => {
    const store = openStore();
    const record = store.create(makeRecord());
    store.setStatus(record.id, "waiting_for_permission");
    store.setAgentSessionId(record.id, "vendor-session-1");
    const updated = store.get(record.id);
    expect(updated?.status).toBe("waiting_for_permission");
    expect(updated?.agentSessionId).toBe("vendor-session-1");
  });

  test("setStatus on an unknown session throws", () => {
    const store = openStore();
    expect(() => store.setStatus(Bun.randomUUIDv7(), "idle")).toThrow(/unknown session/);
  });
});
