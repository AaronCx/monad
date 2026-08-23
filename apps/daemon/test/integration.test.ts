import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  type ClientConnection,
  client,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";
import { REPLAY_COUNT_META_KEY, SESSION_STATUS_META_KEY } from "@aaroncx/protocol";

/**
 * Boots the real monadd (src/main.ts under bun) on a random port with the
 * fake ACP agent as the backend (MONAD_BACKEND_CMD), then drives it over the
 * HTTP transport exactly like the CLI does: one createHttpStream connection
 * per client. No Claude auth anywhere.
 */

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL(
  "../../../packages/backends/test/fixtures/fake-agent.ts",
  import.meta.url,
).pathname;

let home: string;
let port = 0;
let token = "";
let daemon: Subprocess<"ignore", "pipe", "pipe"> | undefined;

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface TestClient {
  connection: ClientConnection;
  updates: SessionNotification[];
  errors: Array<Record<string, unknown>>;
  permissionAnswer?: RequestPermissionResponse;
  /** Never answer: the request stays open until the connection dies. */
  holdPermissions?: boolean;
  permissionRequests: unknown[];
}

function makeClient(name: string, permissionAnswer?: RequestPermissionResponse): TestClient {
  const updates: SessionNotification[] = [];
  const errors: Array<Record<string, unknown>> = [];
  const permissionRequests: unknown[] = [];
  const holder: TestClient = { updates, errors, permissionRequests, permissionAnswer } as TestClient;
  const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  holder.connection = client({ name })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onNotification("_monad.sh/error", (params: unknown) => params as Record<string, unknown>, (ctx) => {
      errors.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      permissionRequests.push(ctx.params);
      if (holder.holdPermissions) {
        return new Promise<RequestPermissionResponse>(() => {});
      }
      if (!holder.permissionAnswer) {
        throw new Error(`client ${name} has no permission answer`);
      }
      return holder.permissionAnswer;
    })
    .connect(stream);
  return holder;
}

async function initialize(c: TestClient) {
  return await c.connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
}

function updateKinds(c: TestClient): string[] {
  return c.updates.map((u) => u.update.sessionUpdate);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-it-"));
  daemon = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_BACKEND_CMD: `${process.execPath} ${FAKE_AGENT}`,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(join(home, "monadd.json")), "monadd.json to appear");
  const info = JSON.parse(readFileSync(join(home, "monadd.json"), "utf8")) as { port: number };
  port = info.port;
  token = readFileSync(join(home, "token"), "utf8").trim();
  expect(port).toBeGreaterThan(0);
  expect(token).toHaveLength(64);
});

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("monadd over the HTTP transport", () => {
  let sessionId = "";
  let clientA: TestClient;
  let clientB: TestClient;

  test(
    "initialize advertises the M1 agent capability shape",
    async () => {
      clientA = makeClient("client-a", {
        outcome: { outcome: "selected", optionId: "allow" },
      });
      const init = await initialize(clientA);
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(init.agentCapabilities?.loadSession).toBe(true);
      expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({});
      expect(init.agentInfo?.name).toBe("monadd");
    },
    30_000,
  );

  test(
    "session/new plus prompt streams the turn to the creating client",
    async () => {
      const created = await clientA.connection.agent.request(methods.agent.session.new, {
        cwd: home,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      // monad's own id, not the vendor's.
      expect(sessionId.startsWith("fake-vendor-")).toBe(false);

      const response = await clientA.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(response.stopReason).toBe("end_turn");
      // Trailing updates can arrive after the prompt response resolves (the
      // response and the updates ride the same SSE mailbox but the fan-out
      // chain is asynchronous); wait instead of asserting immediately.
      await waitFor(() => clientA.updates.length >= 4, "client A turn updates");
      expect(updateKinds(clientA)).toEqual([
        "available_commands_update",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]);
      for (const update of clientA.updates) {
        expect(update.sessionId).toBe(sessionId);
      }
    },
    30_000,
  );

  test(
    "session/load from a second client replays identical history",
    async () => {
      clientB = makeClient("client-b");
      await initialize(clientB);
      const loaded = await clientB.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: home,
        mcpServers: [],
      });
      const replayCount = (loaded._meta as Record<string, unknown>)[REPLAY_COUNT_META_KEY];
      // 4 stored updates plus the prompt replayed as one user_message_chunk.
      expect(replayCount).toBe(5);
      await waitFor(() => clientB.updates.length >= 5, "client B replay");
      expect(updateKinds(clientB)).toEqual([
        "available_commands_update",
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]);
      // The prompt replay carries the original text.
      expect(clientB.updates[1]?.update).toMatchObject({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      });
      // Update events are verbatim: strip the injected user chunk and the
      // remaining notifications must equal what client A saw live.
      const replayedUpdates = clientB.updates.filter(
        (u) => u.update.sessionUpdate !== "user_message_chunk",
      );
      expect(replayedUpdates).toEqual(clientA.updates);
    },
    30_000,
  );

  test(
    "both clients receive the next live turn",
    async () => {
      const aBefore = clientA.updates.length;
      const bBefore = clientB.updates.length;
      const response = await clientA.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "again" }],
      });
      expect(response.stopReason).toBe("end_turn");
      await waitFor(() => clientA.updates.length >= aBefore + 3, "client A live updates");
      await waitFor(() => clientB.updates.length >= bBefore + 4, "client B live updates");
      // The prompting client gets the turn's updates but not its own echo.
      expect(updateKinds(clientA).slice(aBefore)).toEqual([
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]);
      // The attached client additionally sees the peer's prompt.
      expect(updateKinds(clientB).slice(bBefore)).toEqual([
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]);
      expect(clientB.updates[bBefore]?.update).toMatchObject({
        content: { type: "text", text: "again" },
      });
    },
    30_000,
  );

  test(
    "permission requests route to the most recently active client",
    async () => {
      const bBefore = clientB.updates.length;
      const response = await clientA.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "perm please" }],
      });
      expect(response.stopReason).toBe("end_turn");
      expect(clientA.permissionRequests).toHaveLength(1);
      expect(clientB.permissionRequests).toHaveLength(0);
      await waitFor(
        () =>
          clientB.updates.some(
            (u) =>
              u.update.sessionUpdate === "agent_message_chunk" &&
              u.update.content.type === "text" &&
              u.update.content.text === "permission outcome: allow",
          ),
        "permission outcome fan-out to client B",
      );
      expect(clientB.updates.length).toBeGreaterThan(bBefore);
    },
    30_000,
  );

  test(
    "control API serves sessions and status behind the bearer token",
    async () => {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/sessions`);
      expect(unauthorized.status).toBe(401);

      const headers = { Authorization: `Bearer ${token}` };
      const sessions = (await (
        await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers })
      ).json()) as { sessions: Array<{ id: string; status: string; cwd: string }> };
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.id).toBe(sessionId);
      expect(sessions.sessions[0]?.status).toBe("idle");
      expect(sessions.sessions[0]?.cwd).toBe(home);

      const status = (await (
        await fetch(`http://127.0.0.1:${port}/v1/status`, { headers })
      ).json()) as { version: string; activeBackends: Array<{ sessionId: string; backend: string }> };
      expect(status.activeBackends).toEqual([{ sessionId, backend: "claude-acp" }]);
    },
    30_000,
  );

  test(
    "session/list over ACP carries the status extension meta",
    async () => {
      const list = await clientB.connection.agent.request(methods.agent.session.list, {});
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0]?.sessionId).toBe(sessionId);
      expect(list.sessions[0]?.cwd).toBe(home);
      expect(list.sessions[0]?._meta?.[SESSION_STATUS_META_KEY]).toBe("idle");
    },
    30_000,
  );

  test(
    "a client dying mid-permission holds the request for the next attacher",
    async () => {
      // The acceptance-run regression: close every answering client while
      // the agent is asking, then confirm ls shows waiting_for_permission
      // and a fresh attach is immediately asked and can finish the turn.
      const dying = makeClient("dying");
      dying.holdPermissions = true;
      await initialize(dying);
      await dying.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: home,
        mcpServers: [],
      });
      const inFlight = dying.connection.agent
        .request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "perm again" }],
        })
        .catch(() => undefined);
      await waitFor(() => dying.permissionRequests.length === 1, "permission reaches the dying client");
      dying.connection.close();
      await inFlight;

      const headers = { Authorization: `Bearer ${token}` };
      await waitFor(async () => {
        const body = (await (
          await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers })
        ).json()) as { sessions: Array<{ status: string }> };
        return body.sessions[0]?.status === "waiting_for_permission";
      }, "session to report waiting_for_permission");

      const rescuer = makeClient("rescuer", {
        outcome: { outcome: "selected", optionId: "allow_once" },
      });
      await initialize(rescuer);
      await rescuer.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: home,
        mcpServers: [],
      });
      await waitFor(() => rescuer.permissionRequests.length === 1, "pending request re-delivered on attach");
      await waitFor(async () => {
        const body = (await (
          await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers })
        ).json()) as { sessions: Array<{ status: string }> };
        return body.sessions[0]?.status === "idle";
      }, "turn to finish after the rescuer answers");
      await waitFor(
        () =>
          rescuer.updates.some(
            (u) =>
              u.update.sessionUpdate === "agent_message_chunk" &&
              u.update.content.type === "text" &&
              u.update.content.text === "permission outcome: allow",
          ),
        "post-permission outcome reaches the rescuer",
      );
      rescuer.connection.close();
    },
    30_000,
  );

  test(
    "SIGTERM shuts down cleanly and removes the discovery files",
    async () => {
      const proc = daemon;
      if (!proc) {
        throw new Error("daemon not running");
      }
      proc.kill("SIGTERM");
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(existsSync(join(home, "monadd.json"))).toBe(false);
      expect(existsSync(join(home, "monadd.pid"))).toBe(false);
    },
    30_000,
  );
});
