import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@aaroncx/protocol";
import { importedSessionRefusal, SessionManager } from "../src/session.ts";
import { type ImportState, SessionStore } from "../src/store.ts";

/**
 * The store side of Link phase 4: imported events keep the vendor log's
 * timestamps and go through the ordinary indexer, a batch and its import
 * state commit together, and a reset forgets what was read from the file
 * while keeping what monad wrote about the session.
 */

let dirs: string[] = [];
let stores: SessionStore[] = [];

function openStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "monad-import-store-"));
  dirs.push(dir);
  const store = new SessionStore({ dbPath: join(dir, "monad.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

const ID = "6f0c8a52-3b1d-4e7a-9c2f-5d8e1a4b7c90";

function importedRecord(): SessionRecord {
  return {
    id: ID,
    cwd: "/nowhere",
    backend: "import:claude-code",
    mode: "interactive",
    status: "imported",
    trust: "trusted",
    createdAt: "2026-07-29T15:00:00.000Z",
    updatedAt: "2026-07-29T15:00:00.000Z",
  };
}

function state(offset: number): ImportState {
  return {
    sourcePath: "/logs/a.jsonl",
    sessionId: ID,
    vendor: "claude-code",
    offset,
    size: offset,
    mtimeMs: 1,
    ino: 2,
    line: offset,
    head: "h",
  };
}

function prompt(text: string, ts: string) {
  return { kind: "prompt" as const, ts, payload: { sessionId: ID, prompt: [{ type: "text", text }] } };
}

describe("SessionStore imports", () => {
  test("a batch keeps the log's timestamps, is indexed, and moves updated_at only forward", () => {
    const store = openStore();
    const appended = store.appendImported({
      sessionId: ID,
      create: importedRecord(),
      events: [prompt("why is scrolling broken", "2026-07-29T15:01:00.000Z")],
      state: state(10),
    });
    expect(appended.map((event) => event.ts)).toEqual(["2026-07-29T15:01:00.000Z"]);
    expect(store.get(ID)).toMatchObject({ status: "imported", updatedAt: "2026-07-29T15:01:00.000Z" });
    // The ordinary indexer ran: searchable, and titled from the prompt.
    expect(store.search("scrolling").map((hit) => hit.sessionId)).toEqual([ID]);
    expect(store.get(ID)?.title).toBe("why is scrolling broken");
    expect(store.importState("/logs/a.jsonl")).toEqual(state(10));
    expect(store.importStateForSession(ID)?.sourcePath).toBe("/logs/a.jsonl");

    // An out-of-order older line never moves updated_at back.
    store.appendImported({ sessionId: ID, events: [prompt("older", "2026-07-29T14:00:00.000Z")], state: state(20) });
    expect(store.get(ID)?.updatedAt).toBe("2026-07-29T15:01:00.000Z");
    // An import title replaces the derived one; a manual one is never replaced.
    store.appendImported({ sessionId: ID, title: "the real ask", events: [], state: state(20) });
    expect(store.get(ID)).toMatchObject({ title: "the real ask", titleSource: "import" });
    store.setTitle(ID, "mine", "manual");
    store.appendImported({ sessionId: ID, title: "another", events: [], state: state(20) });
    expect(store.get(ID)).toMatchObject({ title: "mine", titleSource: "manual" });
  });

  test("the events and the import state commit together or not at all", () => {
    const store = openStore();
    // A batch that fails on its SECOND event, after the session row and the
    // first event were written: none of it lands, the state included.
    const unserializable = { kind: "prompt" as const, ts: "2026-07-29T15:01:01.000Z", payload: { n: 1n } };
    expect(() =>
      store.appendImported({
        sessionId: ID,
        create: importedRecord(),
        events: [prompt("first", "2026-07-29T15:01:00.000Z"), unserializable],
        state: state(10),
      }),
    ).toThrow();
    expect(store.get(ID)).toBeUndefined();
    expect(store.replay(ID)).toEqual([]);
    expect(store.importState("/logs/a.jsonl")).toBeUndefined();
    expect(store.search("first")).toEqual([]);

    // The same after a batch that did commit: the log and the state stay
    // exactly where that batch left them, so the next run neither repeats
    // nor skips a line.
    store.appendImported({
      sessionId: ID,
      create: importedRecord(),
      events: [prompt("committed", "2026-07-29T15:01:00.000Z")],
      state: state(10),
    });
    expect(() =>
      store.appendImported({
        sessionId: ID,
        events: [prompt("second", "2026-07-29T15:02:00.000Z"), unserializable],
        state: state(20),
      }),
    ).toThrow();
    expect(store.replay(ID).map((event) => event.kind)).toEqual(["prompt"]);
    expect(store.importState("/logs/a.jsonl")).toEqual(state(10));
    expect(store.search("second")).toEqual([]);
  });

  test("a reset drops what was read from the file and keeps what monad wrote about the session", () => {
    const store = openStore();
    store.appendImported({
      sessionId: ID,
      create: importedRecord(),
      events: [prompt("scrolling is broken", "2026-07-29T15:01:00.000Z")],
      state: state(10),
    });
    store.append(ID, "access", { op: "read", by: "human", role: "target", target: ID });
    store.append(ID, "summary", {
      text: "summary of the scroll work",
      summarizerSessionId: Bun.randomUUIDv7(),
      fromSeq: 1,
      toSeq: 1,
    });
    store.resetImported(ID);

    expect(store.replay(ID).map((event) => event.kind)).toEqual(["access", "summary"]);
    expect(store.importState("/logs/a.jsonl")).toBeUndefined();
    expect(store.get(ID)).toMatchObject({ status: "imported" });
    expect(store.get(ID)?.title).toBeUndefined();
    // The kept summary is indexed again, once; the dropped prompt is gone.
    expect(store.search("scrolling").map((hit) => hit.kind)).toEqual(["summary"]);
    store.appendImported({
      sessionId: ID,
      events: [prompt("scrolling is broken", "2026-07-29T15:01:00.000Z")],
      state: state(10),
    });
    expect(
      store
        .search("scrolling")
        .map((hit) => hit.kind)
        .sort(),
    ).toEqual(["prompt", "summary"]);
  });

  test("agentSessionIds names the vendor sessions monad ran, not imported ones", () => {
    const store = openStore();
    const now = new Date().toISOString();
    const ran: SessionRecord = {
      id: Bun.randomUUIDv7(),
      cwd: "/tmp",
      backend: "claude-acp",
      mode: "interactive",
      status: "idle",
      trust: "trusted",
      createdAt: now,
      updatedAt: now,
    };
    store.create(ran);
    store.setAgentSessionId(ran.id, "vendor-1");
    store.appendImported({ sessionId: ID, create: importedRecord(), events: [], state: state(0) });
    expect([...store.agentSessionIds()]).toEqual(["vendor-1"]);
    // A restore whose session/load failed started a fresh vendor session:
    // the old vendor log is still monad's work.
    store.setAgentSessionId(ran.id, "vendor-2");
    expect(store.get(ran.id)?.agentSessionId).toBe("vendor-2");
    expect([...store.agentSessionIds()].sort()).toEqual(["vendor-1", "vendor-2"]);
  });

  test("a database from before the id history recovers replaced ids from the error events", () => {
    const dir = mkdtempSync(join(tmpdir(), "monad-import-store-"));
    dirs.push(dir);
    const dbPath = join(dir, "monad.db");
    const old = new SessionStore({ dbPath });
    const now = new Date().toISOString();
    const id = Bun.randomUUIDv7();
    old.create({
      id,
      cwd: "/tmp",
      backend: "claude-acp",
      mode: "interactive",
      status: "idle",
      trust: "trusted",
      createdAt: now,
      updatedAt: now,
    });
    old.setAgentSessionId(id, "vendor-new");
    // What claude.ts logs when session/load fails and it starts afresh.
    old.append(id, "error", { message: "vendor session/load failed", agentSessionId: "vendor-old" });
    old.append(id, "error", { message: "unrelated" });
    old.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE agent_session_ids;");
    raw.close();

    const reopened = new SessionStore({ dbPath });
    stores.push(reopened);
    expect([...reopened.agentSessionIds()].sort()).toEqual(["vendor-new", "vendor-old"]);
  });
});

describe("SessionManager and an imported session", () => {
  test("nothing drives it: attach, prompt, mode, cancel, close and activate are refused", async () => {
    const store = openStore();
    let backends = 0;
    const manager = new SessionManager({
      store,
      createBackend: () => {
        backends += 1;
        return { prompt: async () => ({ stopReason: "end_turn" as const }), cancel: async () => {}, close: async () => {} };
      },
    });
    store.appendImported({
      sessionId: ID,
      create: importedRecord(),
      events: [prompt("history", "2026-07-29T15:01:00.000Z")],
      state: state(10),
    });
    const message = importedSessionRefusal(importedRecord()).message;
    const client = { onEvent() {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
    expect(() => manager.attach(ID, client)).toThrow(message);
    await expect(manager.prompt(ID, { sessionId: ID, prompt: [{ type: "text", text: "go" }] })).rejects.toThrow(
      message,
    );
    await expect(manager.setMode(ID, "review")).rejects.toThrow(message);
    await expect(manager.cancel(ID)).rejects.toThrow(message);
    await expect(manager.close(ID)).rejects.toThrow(message);
    await expect(manager.activate(ID)).rejects.toThrow(message);
    expect(store.get(ID)).toMatchObject({ status: "imported", mode: "interactive" });
    expect(store.replay(ID)).toHaveLength(1);
    expect(backends).toBe(0);
    // Reading it is fine, and titling it by hand too.
    expect(manager.setTitle(ID, "named").title).toBe("named");
  });
});
