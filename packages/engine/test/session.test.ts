import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { EventRecord } from "@aaroncx/protocol";
import {
  type BackendHooks,
  PROMPT_IN_FLIGHT_ERROR_CODE,
  type SessionBackend,
  type SessionClient,
  SessionManager,
} from "../src/session.ts";
import { SessionStore } from "../src/store.ts";

let dirs: string[] = [];
let stores: SessionStore[] = [];

function openStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "monad-session-"));
  dirs.push(dir);
  const store = new SessionStore({ dbPath: join(dir, "monad.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // Already closed.
    }
  }
  stores = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeBackend implements SessionBackend {
  hooks: BackendHooks;
  pendingTurns: Deferred<PromptResponse>[] = [];
  cancelled = false;
  closed = false;

  constructor(hooks: BackendHooks) {
    this.hooks = hooks;
  }

  prompt(_params: PromptRequest): Promise<PromptResponse> {
    const turn = deferred<PromptResponse>();
    this.pendingTurns.push(turn);
    return turn.promise;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makePrompt(sessionId: string): PromptRequest {
  return { sessionId, prompt: [{ type: "text", text: "hello" }] };
}

function collectorClient(events: EventRecord[]): SessionClient {
  return {
    onEvent: (event) => {
      events.push(event);
    },
    requestPermission: () =>
      Promise.resolve({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
  };
}

function makeManager() {
  const store = openStore();
  const backends: FakeBackend[] = [];
  const manager = new SessionManager({
    store,
    createBackend: (_record, hooks) => {
      const backend = new FakeBackend(hooks);
      backends.push(backend);
      return backend;
    },
  });
  return { store, manager, backends };
}

describe("SessionManager prompt", () => {
  test("a second prompt while one is in flight returns a JSON-RPC error", async () => {
    const { manager, backends } = makeManager();
    const record = await manager.create({ cwd: "/tmp/repo" });
    const backend = backends[0]!;

    const first = manager.prompt(record.id, makePrompt(record.id));
    await Bun.sleep(1); // Let the first prompt reach the backend.
    expect(backend.pendingTurns).toHaveLength(1);
    expect(manager.get(record.id)?.status).toBe("running");

    const rejection = await manager.prompt(record.id, makePrompt(record.id)).catch((e) => e);
    expect(rejection).toBeInstanceOf(RequestError);
    expect((rejection as RequestError).code).toBe(PROMPT_IN_FLIGHT_ERROR_CODE);

    backend.pendingTurns[0]!.resolve({ stopReason: "end_turn" });
    const response = await first;
    expect(response.stopReason).toBe("end_turn");
    expect(manager.get(record.id)?.status).toBe("idle");

    // The lock is released: a third prompt goes through.
    const third = manager.prompt(record.id, makePrompt(record.id));
    await Bun.sleep(1);
    backend.pendingTurns[1]!.resolve({ stopReason: "end_turn" });
    await third;
  });

  test("prompt and turn_ended land in the event log in order", async () => {
    const { store, manager, backends } = makeManager();
    const record = await manager.create({ cwd: "/tmp/repo" });
    const turn = manager.prompt(record.id, makePrompt(record.id));
    await Bun.sleep(1);
    backends[0]!.pendingTurns[0]!.resolve({ stopReason: "end_turn" });
    await turn;

    const kinds = store.replay(record.id).map((e) => e.kind);
    expect(kinds).toEqual(["session_created", "prompt", "turn_ended"]);
    const turnEnded = store.replay(record.id).at(-1);
    expect(turnEnded?.payload).toEqual({ stopReason: "end_turn" });
  });

  test("a failing backend turn appends an error event and frees the lock", async () => {
    const { store, manager, backends } = makeManager();
    const record = await manager.create({ cwd: "/tmp/repo" });
    const turn = manager.prompt(record.id, makePrompt(record.id));
    await Bun.sleep(1);
    backends[0]!.pendingTurns[0]!.reject(new Error("vendor exploded"));
    await expect(turn).rejects.toThrow("vendor exploded");

    const kinds = store.replay(record.id).map((e) => e.kind);
    expect(kinds).toEqual(["session_created", "prompt", "error"]);
    expect(manager.get(record.id)?.status).toBe("idle");

    const retry = manager.prompt(record.id, makePrompt(record.id));
    await Bun.sleep(1);
    backends[0]!.pendingTurns[1]!.resolve({ stopReason: "end_turn" });
    await retry;
  });
});

describe("SessionManager fan-out", () => {
  test("updates from the backend reach every subscriber and the log", async () => {
    const { store, manager, backends } = makeManager();
    const record = await manager.create({ cwd: "/tmp/repo" });
    const seenByA: EventRecord[] = [];
    const seenByB: EventRecord[] = [];
    manager.attach(record.id, collectorClient(seenByA));
    manager.attach(record.id, collectorClient(seenByB));

    const update = {
      sessionId: record.id,
      update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text: "hi" } },
    };
    backends[0]!.hooks.onUpdate(update);

    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.kind).toBe("update");
    expect(seenByA[0]?.payload).toEqual(update);
    expect(seenByB).toHaveLength(1);
    expect(store.replay(record.id).at(-1)?.payload).toEqual(update);
  });

  test("attach replays the full log and detach stops the fan-out", async () => {
    const { manager, backends } = makeManager();
    const record = await manager.create({ cwd: "/tmp/repo" });
    backends[0]!.hooks.onUpdate({
      sessionId: record.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } },
    });

    const seen: EventRecord[] = [];
    const client = collectorClient(seen);
    const { events } = manager.attach(record.id, client);
    expect(events.map((e) => e.kind)).toEqual(["session_created", "update"]);

    manager.detach(record.id, client);
    backends[0]!.hooks.onUpdate({
      sessionId: record.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } },
    });
    expect(seen).toHaveLength(0);
  });
});
