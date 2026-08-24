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
} from "@agentclientprotocol/sdk";
import { deriveMountToken } from "@aaroncx/engine";
import { createHttpStream } from "@aaroncx/engine/transport";

/**
 * The M2 daemon MCP surface, end to end against the real monadd with the
 * fake ACP agent as the backend:
 *
 * - session/new injects the monad-checks http entry (name, per-session URL,
 *   bearer header) into the mcpServers forwarded to the vendor; the fake
 *   agent records what it received in <cwd>/fake-agent-mcp.jsonl.
 * - /mcp/<sessionId> answers tools/list for that session's derived mount
 *   token ONLY: the daemon token and another session's mount token are both
 *   401 there (decision record 0009).
 * - After a daemon restart, the vendor session/load path passes a
 *   monad-checks entry too (the fingerprint-preserving restore wiring).
 * - A vendor that does not advertise mcpCapabilities.http gets NO injection.
 */

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL(
  "../../../packages/backends/test/fixtures/fake-agent.ts",
  import.meta.url,
).pathname;

interface RunningDaemon {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
}

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

async function bootDaemon(home: string, backendArgs: string[] = []): Promise<RunningDaemon> {
  const infoPath = join(home, "monadd.json");
  rmSync(infoPath, { force: true });
  const proc = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT, ...backendArgs].join(" "),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(infoPath), "monadd.json to appear");
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as { port: number };
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return { proc, port: info.port, token };
}

async function stopDaemon(daemon: RunningDaemon): Promise<void> {
  daemon.proc.kill();
  await daemon.proc.exited;
}

function makeAcpClient(daemon: RunningDaemon): ClientConnection {
  const stream = createHttpStream(`http://127.0.0.1:${daemon.port}/acp`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  return client({ name: "mcp-test-client" })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => {
      throw new Error("unexpected permission request");
    })
    .connect(stream);
}

async function newSession(connection: ClientConnection, cwd: string): Promise<string> {
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const response = await connection.agent.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  });
  return response.sessionId;
}

interface RecordedMcp {
  method: string;
  mcpServers: Array<{
    type?: string;
    name?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
  }>;
}

function recordedMcp(cwd: string): RecordedMcp[] {
  const file = join(cwd, "fake-agent-mcp.jsonl");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedMcp);
}

/**
 * One raw Streamable HTTP JSON-RPC POST. The stateless server answers each
 * POST independently (spike 0a), so no initialize round trip is needed for
 * tools/list. Handles both JSON and SSE response bodies.
 */
async function mcpPost(
  daemon: RunningDaemon,
  sessionId: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json?: unknown }> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/mcp/${sessionId}`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  if (text.startsWith("data:") || text.includes("\ndata:")) {
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data:"));
    json = dataLine === undefined ? undefined : JSON.parse(dataLine.slice("data:".length).trim());
  } else if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, json };
}

let home: string;
let sessionCwd: string;
let otherCwd: string;
let daemon: RunningDaemon;
let connection: ClientConnection | undefined;
let sessionId = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-mcp-it-"));
  sessionCwd = mkdtempSync(join(tmpdir(), "monad-mcp-cwd-"));
  otherCwd = mkdtempSync(join(tmpdir(), "monad-mcp-other-"));
  daemon = await bootDaemon(home);
  connection = makeAcpClient(daemon);
  sessionId = await newSession(connection, sessionCwd);
});

afterAll(async () => {
  await stopDaemon(daemon).catch(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionCwd, { recursive: true, force: true });
  rmSync(otherCwd, { recursive: true, force: true });
});

describe("monad-checks injection on session/new", () => {
  test("the vendor received exactly one http entry with the session URL and bearer header", () => {
    const records = recordedMcp(sessionCwd);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.method).toBe("session/new");
    expect(record?.mcpServers).toHaveLength(1);
    const entry = record?.mcpServers[0];
    expect(entry).toEqual({
      type: "http",
      name: "monad-checks",
      url: `http://127.0.0.1:${daemon.port}/mcp/${sessionId}`,
      headers: [
        { name: "Authorization", value: `Bearer ${deriveMountToken(daemon.token, sessionId)}` },
      ],
    });
  });

  test("the entry handed to the vendor does not carry the daemon token", () => {
    const serialized = JSON.stringify(recordedMcp(sessionCwd));
    expect(serialized).not.toContain(daemon.token);
  });
});

describe("/mcp/<sessionId> behind the session's mount token", () => {
  test("tools/list answers with the three checks tools", async () => {
    const { status, json } = await mcpPost(
      daemon,
      sessionId,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      deriveMountToken(daemon.token, sessionId),
    );
    expect(status).toBe(200);
    const result = (json as { result: { tools: Array<{ name: string }> } }).result;
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["check_config", "list_checks", "run_checks"]);
  });

  test("requests without the bearer get 401", async () => {
    const { status } = await mcpPost(daemon, sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(status).toBe(401);
  });

  test("the daemon token gets 401 on the mount", async () => {
    const { status } = await mcpPost(
      daemon,
      sessionId,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      daemon.token,
    );
    expect(status).toBe(401);
  });

  test("another session's mount token gets 401", async () => {
    const other = await newSession(makeAcpClient(daemon), otherCwd);
    expect(other).not.toBe(sessionId);
    const { status } = await mcpPost(
      daemon,
      sessionId,
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      deriveMountToken(daemon.token, other),
    );
    expect(status).toBe(401);
    // ...and that session's own mount still opens, so the refusal above is
    // the token binding, not a broken mount.
    const own = await mcpPost(
      daemon,
      other,
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
      deriveMountToken(daemon.token, other),
    );
    expect(own.status).toBe(200);
  }, 20_000);

  test("an unknown session id gets 404 once its mount token is right", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    const { status } = await mcpPost(
      daemon,
      unknown,
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      deriveMountToken(daemon.token, unknown),
    );
    expect(status).toBe(404);
  });

  test("an unknown session id with the daemon token is 401, not 404", async () => {
    const { status } = await mcpPost(
      daemon,
      "00000000-0000-7000-8000-000000000001",
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      daemon.token,
    );
    expect(status).toBe(401);
  });
});

describe("restore after a daemon restart", () => {
  test("vendor session/load receives a monad-checks entry too", async () => {
    await stopDaemon(daemon);
    daemon = await bootDaemon(home);
    connection = makeAcpClient(daemon);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    // Prompting the stored session forces the backend restart, which goes
    // through the vendor session/load path with the shared entry builder.
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello after restart" }],
    });
    const records = recordedMcp(sessionCwd);
    expect(records).toHaveLength(2);
    const load = records[1];
    expect(load?.method).toBe("session/load");
    expect(load?.mcpServers).toHaveLength(1);
    const entry = load?.mcpServers[0];
    expect(entry?.name).toBe("monad-checks");
    // The entry carries the CURRENT port. With --port 0 the restarted
    // daemon landed elsewhere, which is exactly the documented consequence:
    // the vendor fingerprint changes and the vendor recreates its
    // subprocess. A fixed-port daemon (the default 7331) keeps it stable.
    expect(entry?.url).toBe(`http://127.0.0.1:${daemon.port}/mcp/${sessionId}`);
    expect(entry?.headers).toEqual([
      { name: "Authorization", value: `Bearer ${deriveMountToken(daemon.token, sessionId)}` },
    ]);
  }, 20_000);
});

describe("vendors without mcpCapabilities.http", () => {
  test("injection is skipped: the vendor receives an empty mcpServers array", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "monad-mcp-nohttp-"));
    const cwd2 = mkdtempSync(join(tmpdir(), "monad-mcp-nohttp-cwd-"));
    const daemon2 = await bootDaemon(home2, ["--no-mcp-http"]);
    try {
      const connection2 = makeAcpClient(daemon2);
      await newSession(connection2, cwd2);
      const records = recordedMcp(cwd2);
      expect(records).toHaveLength(1);
      expect(records[0]?.method).toBe("session/new");
      expect(records[0]?.mcpServers).toEqual([]);
    } finally {
      await stopDaemon(daemon2).catch(() => {});
      rmSync(home2, { recursive: true, force: true });
      rmSync(cwd2, { recursive: true, force: true });
    }
  }, 20_000);
});
