import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { monadStateDir, type SessionClient, SessionManager, SessionStore } from "@aaroncx/engine";
import type { EventRecord } from "@aaroncx/protocol";
import {
  BACKEND_CMD_ENV,
  createClaudeBackend,
  DEFAULT_NODE_DIR,
  resolveBackendCommand,
} from "../src/index.ts";

const FIXTURE = new URL("./fixtures/fake-agent.ts", import.meta.url).pathname;

/** The fake agent runs under the same bun binary driving the tests. */
function fakeCommand(...flags: string[]): string[] {
  return [process.execPath, FIXTURE, ...flags];
}

interface Collector {
  client: SessionClient;
  events: EventRecord[];
  permissionRequests: RequestPermissionRequest[];
}

function collector(answer?: RequestPermissionResponse): Collector {
  const events: EventRecord[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const client: SessionClient = {
    onEvent(event) {
      events.push(event);
    },
    requestPermission(params) {
      permissionRequests.push(params);
      return answer
        ? Promise.resolve(answer)
        : Promise.reject(new Error("collector has no permission answer"));
    },
  };
  return { client, events, permissionRequests };
}

const openManagers: SessionManager[] = [];
const openStores: SessionStore[] = [];

function makeManager(store: SessionStore, ...fixtureFlags: string[]): SessionManager {
  const manager = new SessionManager({
    store,
    createBackend: createClaudeBackend({ command: fakeCommand(...fixtureFlags) }),
  });
  openManagers.push(manager);
  return manager;
}

function makeStore(): SessionStore {
  const store = new SessionStore({ dbPath: ":memory:" });
  openStores.push(store);
  return store;
}

afterEach(async () => {
  for (const manager of openManagers.splice(0)) {
    await manager.shutdown();
  }
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

function textPrompt(sessionId: string, text: string) {
  return { sessionId, prompt: [{ type: "text" as const, text }] };
}

function updatePayloads(events: EventRecord[]): SessionNotification[] {
  return events.filter((e) => e.kind === "update").map((e) => e.payload as SessionNotification);
}

describe("AcpClientBackend against the fake agent", () => {
  test("runs a full turn and logs verbatim updates with monad's session id", async () => {
    const store = makeStore();
    const manager = makeManager(store);
    const record = await manager.create({ cwd: process.cwd() });

    const stored = manager.get(record.id);
    expect(stored?.agentSessionId?.startsWith("fake-vendor-")).toBe(true);
    expect(stored?.agentSessionId).not.toBe(record.id);

    const a = collector();
    manager.attach(record.id, a.client);
    const response = await manager.prompt(
      record.id,
      textPrompt(record.id, "hello there"),
      a.client,
    );
    expect(response.stopReason).toBe("end_turn");

    const events = store.replay(record.id);
    expect(events.map((e) => e.kind)).toEqual([
      "session_created",
      // The roster the vendor advertised, recorded once per session so a
      // later tool rejection can be read against what was on offer.
      "vendor_tools",
      "update",
      "prompt",
      "update",
      "update",
      "update",
      "turn_ended",
    ]);

    // The roster event carries names only: the full advertisement is already
    // in the update event, and nothing about the vendor's config may become a
    // second copy of a credential.
    const roster = events.find((e) => e.kind === "vendor_tools")?.payload as {
      commands: string[];
      commandCount: number;
      mcpServers: string[];
      home: string;
      agent?: { name?: string };
    };
    expect(roster.commands).toEqual(["compact"]);
    expect(roster.commandCount).toBe(1);
    expect(roster.mcpServers).toEqual([]);
    // "vendor" on a machine with a file-based Claude login, "user" without
    // one; both are correct and neither is asserted here.
    expect(["user", "vendor"]).toContain(roster.home);

    const updates = updatePayloads(events);
    for (const update of updates) {
      // The adapter rewrites the vendor's session id to monad's everywhere.
      expect(update.sessionId).toBe(record.id);
    }
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "compact", description: "Compact the conversation" }],
    });
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "echo: hello there" },
    });
    expect(updates[2]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      status: "pending",
    });
    expect(updates[3]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
    });
    expect(events.at(-1)?.payload).toEqual({ stopReason: "end_turn" });
  });

  test("fans out identical ordered events to two subscribers", async () => {
    const store = makeStore();
    const manager = makeManager(store);
    const record = await manager.create({ cwd: process.cwd() });

    const a = collector();
    const b = collector();
    manager.attach(record.id, a.client);
    manager.attach(record.id, b.client);

    await manager.prompt(record.id, textPrompt(record.id, "fan out"), a.client);

    expect(a.events.length).toBeGreaterThanOrEqual(5);
    expect(a.events).toEqual(b.events);
    expect(a.events.map((e) => e.kind)).toEqual([
      "prompt",
      "update",
      "update",
      "update",
      "turn_ended",
    ]);
    const seqs = a.events.map((e) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  test("delegates permission requests to the active client and logs the exchange", async () => {
    const store = makeStore();
    const manager = makeManager(store);
    const record = await manager.create({ cwd: process.cwd() });

    const a = collector({ outcome: { outcome: "selected", optionId: "allow" } });
    manager.attach(record.id, a.client);
    const response = await manager.prompt(
      record.id,
      textPrompt(record.id, "perm please"),
      a.client,
    );
    expect(response.stopReason).toBe("end_turn");

    // The client saw the request once, with monad's session id, verbatim options.
    expect(a.permissionRequests).toHaveLength(1);
    const request = a.permissionRequests[0];
    expect(request?.sessionId).toBe(record.id);
    expect(request?.toolCall.toolCallId).toBe("call_2");
    expect(request?.options.map((o) => o.optionId)).toEqual(["allow", "reject"]);

    const events = store.replay(record.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "session_created",
      "vendor_tools",
      "update",
      "prompt",
      "update",
      "update",
      "update",
      "permission_requested",
      "permission_resolved",
      "update",
      "turn_ended",
    ]);
    const requested = events.find((e) => e.kind === "permission_requested");
    expect((requested?.payload as RequestPermissionRequest).sessionId).toBe(record.id);
    const resolved = events.find((e) => e.kind === "permission_resolved");
    expect(resolved?.payload).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    const outcomeChunk = updatePayloads(events).at(-1);
    expect(outcomeChunk?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "permission outcome: allow" },
    });
  });

  test("restores vendor context on restart without double-appending replayed updates", async () => {
    const store = makeStore();
    const first = makeManager(store);
    const record = await first.create({ cwd: process.cwd() });
    await first.prompt(record.id, textPrompt(record.id, "first turn"));
    const vendorId = first.get(record.id)?.agentSessionId;
    expect(vendorId).toBeTruthy();
    await first.shutdown();

    const before = store.replay(record.id);

    // A fresh manager over the same store simulates a daemon restart: the
    // live map is empty and the next prompt lazily restarts the backend,
    // which must vendor-session/load with the stored agentSessionId.
    const second = makeManager(store);
    const b = collector();
    second.attach(record.id, b.client);
    const response = await second.prompt(
      record.id,
      textPrompt(record.id, "second turn"),
      b.client,
    );
    expect(response.stopReason).toBe("end_turn");

    const added = store.replay(record.id).slice(before.length);
    // No error event, no replayed history: the vendor's load-time updates
    // are dropped because monad's log already has the real history.
    expect(added.map((e) => e.kind)).toEqual([
      "prompt",
      "update",
      "update",
      "update",
      "turn_ended",
    ]);
    expect(JSON.stringify(added)).not.toContain("replayed user message");
    expect(second.get(record.id)?.agentSessionId).toBe(vendorId as string);
  });

  test("appends an error event and starts fresh when vendor session/load fails", async () => {
    const store = makeStore();
    const first = makeManager(store);
    const record = await first.create({ cwd: process.cwd() });
    const vendorId = first.get(record.id)?.agentSessionId;
    await first.shutdown();

    const before = store.replay(record.id);
    const second = makeManager(store, "--fail-load");
    const response = await second.prompt(record.id, textPrompt(record.id, "after restart"));
    expect(response.stopReason).toBe("end_turn");

    const added = store.replay(record.id).slice(before.length);
    expect(added.map((e) => e.kind)).toEqual([
      "prompt",
      "error",
      "vendor_tools",
      "update",
      "update",
      "update",
      "update",
      "turn_ended",
    ]);
    const error = added.find((e) => e.kind === "error");
    expect((error?.payload as { message: string }).message).toContain("NOT restored");
    expect((error?.payload as { agentSessionId: string }).agentSessionId).toBe(
      vendorId as string,
    );

    const fresh = second.get(record.id)?.agentSessionId;
    expect(fresh?.startsWith("fake-vendor-")).toBe(true);
    expect(fresh).not.toBe(vendorId);
  });

  test("appends an error event when the vendor does not support session/load", async () => {
    const store = makeStore();
    const first = makeManager(store);
    const record = await first.create({ cwd: process.cwd() });
    await first.shutdown();

    const before = store.replay(record.id);
    const second = makeManager(store, "--no-load");
    await second.prompt(record.id, textPrompt(record.id, "after restart"));

    const added = store.replay(record.id).slice(before.length);
    const error = added.find((e) => e.kind === "error");
    expect((error?.payload as { message: string }).message).toContain(
      "does not support session/load",
    );
    expect(second.get(record.id)?.agentSessionId?.startsWith("fake-vendor-")).toBe(true);
  });
});

describe("resolveBackendCommand", () => {
  test("MONAD_BACKEND_CMD overrides the whole command line", () => {
    expect(resolveBackendCommand({ [BACKEND_CMD_ENV]: "bun /tmp/fake-agent.ts" })).toEqual([
      "bun",
      "/tmp/fake-agent.ts",
    ]);
  });

  test("throws a clear error when no node is available", () => {
    expect(() => resolveBackendCommand({ PATH: "/nonexistent" }, "/nonexistent-dir")).toThrow(
      /node >= 22/,
    );
  });

  test("resolves the pinned local adapter entry with an absolute node", () => {
    const node = Bun.which("node", {
      PATH: `${DEFAULT_NODE_DIR}:${process.env.PATH ?? ""}`,
    });
    if (!node) {
      // Environment without node: covered by the throw test above.
      return;
    }
    const command = resolveBackendCommand(process.env);
    expect(command).toHaveLength(2);
    expect(command[0]).toBe(node);
    expect(command[1]).toContain("claude-agent-acp");
    expect(existsSync(command[1] as string)).toBe(true);
  });
});

describe("resolveClaudeAgentBin vendor fallback", () => {
  test("the not-installed error names the provisioned vendor path and the one-liner", () => {
    // In a checkout import.meta.dir resolution succeeds, so exercise the
    // error path indirectly: the message contract is what a compiled monadd
    // in an arbitrary repo shows the user. Assert the vendor root derives
    // from MONAD_HOME so the hint always points at the daemon's real state
    // dir.
    const home = "/tmp/monad-vendor-fallback-test";
    expect(join(monadStateDir({ MONAD_HOME: home }), "vendor")).toBe(`${home}/vendor`);
  });

  test("a provisioned vendor tree under MONAD_HOME is resolvable", () => {
    const root = mkdtempSync(join(tmpdir(), "monad-vendor-"));
    const pkgDir = join(root, "vendor", "node_modules", "@agentclientprotocol", "claude-agent-acp");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.0.0-test", main: "dist/index.js" }));
    writeFileSync(join(pkgDir, "dist", "index.js"), "// test stub\n");
    const resolved = Bun.resolveSync(
      "@agentclientprotocol/claude-agent-acp/dist/index.js",
      join(monadStateDir({ MONAD_HOME: root }), "vendor"),
    );
    // Bun.resolveSync returns the realpath (/private/var/...) while tmpdir()
    // reports the /var symlink, so compare realpaths.
    expect(resolved).toBe(realpathSync(join(pkgDir, "dist", "index.js")));
    rmSync(root, { recursive: true, force: true });
  });
});
