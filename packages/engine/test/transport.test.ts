import { afterEach, describe, expect, test } from "bun:test";
import { agent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  type AcpHttpServer,
  createAcpHttpServer,
  createHttpStream,
} from "../src/transport/index.ts";

const TOKEN = "t".repeat(64);

function makeTestAgent() {
  return agent({ name: "engine-transport-test" }).onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
  }));
}

let servers: AcpHttpServer[] = [];

async function startServer(options: { fallback?: Parameters<typeof createAcpHttpServer>[1]["fallback"] } = {}) {
  const server = createAcpHttpServer(makeTestAgent(), {
    authToken: TOKEN,
    fallback: options.fallback,
  });
  servers.push(server);
  const { port, host } = await server.listen(0);
  return { server, url: `http://${host}:${port}` };
}

afterEach(async () => {
  for (const server of servers) {
    await server.close();
  }
  servers = [];
});

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
  });
}

describe("createAcpHttpServer auth middleware", () => {
  test("rejects a request with no token", async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: initializeBody(),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("rejects a request with the wrong token", async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/acp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${"x".repeat(64)}`,
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(401);
  });

  test("accepts the right token and serves ACP initialize", async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/acp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
    // The transport mints the connection id on the initialize response.
    expect(response.headers.get("acp-connection-id")).toBeTruthy();
    const body = (await response.json()) as {
      result: { protocolVersion: number; agentCapabilities: { loadSession: boolean } };
    };
    expect(body.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.result.agentCapabilities.loadSession).toBe(true);
  });

  test("guards the fallback (control API) routes with the same token", async () => {
    const { url } = await startServer({
      fallback: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    const unauthorized = await fetch(`${url}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${url}/v1/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ ok: true });
  });

  test("returns 404 for unknown paths when no fallback is mounted", async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("createAcpHttpServer with a per-connection factory", () => {
  test("builds a fresh agent per accepted connection", async () => {
    let built = 0;
    const server = createAcpHttpServer(
      () => {
        built += 1;
        return makeTestAgent();
      },
      { authToken: TOKEN },
    );
    servers.push(server);
    const { port, host } = await server.listen(0);
    const url = `http://${host}:${port}`;

    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${url}/acp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: initializeBody(),
      });
      expect(response.status).toBe(200);
    }
    expect(built).toBe(2);
  });
});

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("SSE liveness reaper", () => {
  async function startReapingServer(sseGraceMs: number) {
    const dead: string[] = [];
    const server = createAcpHttpServer(makeTestAgent(), {
      authToken: TOKEN,
      sseGraceMs,
      onConnectionDead: (id) => dead.push(id),
    });
    servers.push(server);
    const { port, host } = await server.listen(0);
    return { url: `http://${host}:${port}`, dead };
  }

  async function initializeConnection(url: string): Promise<string> {
    const response = await fetch(`${url}/acp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
    const connectionId = response.headers.get("acp-connection-id");
    if (!connectionId) {
      throw new Error("initialize response had no connection id");
    }
    return connectionId;
  }

  function openSse(url: string, connectionId: string) {
    const aborter = new AbortController();
    const response = fetch(`${url}/acp`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "text/event-stream",
        "acp-connection-id": connectionId,
      },
      signal: aborter.signal,
    });
    return { response, aborter };
  }

  async function postOnConnection(url: string, connectionId: string): Promise<number> {
    const response = await fetch(`${url}/acp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        "acp-connection-id": connectionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} }),
    });
    // Drain so keep-alive sockets are returned cleanly.
    await response.text();
    return response.status;
  }

  test("an SSE receiver dying without DELETE tears the connection down after the grace window", async () => {
    const { url, dead } = await startReapingServer(100);
    const connectionId = await initializeConnection(url);

    const { response, aborter } = openSse(url, connectionId);
    const sse = await response;
    expect(sse.status).toBe(200);
    // Abrupt death: kill the socket, never send a DELETE.
    aborter.abort();

    await waitFor(() => dead.includes(connectionId), "onConnectionDead for the dropped receiver");
    // The SDK registry no longer knows the connection: POSTs are refused.
    expect(await postOnConnection(url, connectionId)).toBe(404);
  });

  test("a receiver returning within the grace window keeps the connection alive", async () => {
    const { url, dead } = await startReapingServer(400);
    const connectionId = await initializeConnection(url);

    const first = openSse(url, connectionId);
    expect((await first.response).status).toBe(200);
    first.aborter.abort();
    // Reconnect well inside the window, like a client re-establishing SSE.
    // The server releases the old lease only once it observes the socket
    // close, so a too-quick GET can 409; retry like a real client would.
    let second = openSse(url, connectionId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = (await second.response).status;
      if (status === 200) {
        break;
      }
      expect(status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 15));
      second = openSse(url, connectionId);
    }
    expect((await second.response).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(dead).toEqual([]);
    expect(await postOnConnection(url, connectionId)).toBe(202);
    second.aborter.abort();
  });
});

describe("createHttpStream against the wrapper", () => {
  test("initialize round trips through the SDK's own client transport", async () => {
    const { url } = await startServer();
    const stream = createHttpStream(`${url}/acp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
    });
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value).toMatchObject({
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION },
    });
    // Cleanup quirk from decision record 0004: the writable stays locked, so
    // release instead of closing.
    writer.releaseLock();
    await reader.cancel().catch(() => {});
  });
});
