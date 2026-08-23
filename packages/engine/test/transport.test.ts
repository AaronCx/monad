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
