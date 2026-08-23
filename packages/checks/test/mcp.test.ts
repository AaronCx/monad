import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createChecksMcpServer, type ChecksMcpServer } from "../src/mcp";
import type { CheckRunResults } from "../src/index";
import { makeFixtureRepo, type FixtureRepo } from "./fixtures/make-repo";

/**
 * The checks MCP server, driven exactly like the daemon mounts it: a
 * node:http server with a bearer check in front, one mount path per session,
 * stateless Streamable HTTP underneath. The MCP SDK client plays the role of
 * the vendor's MCP client; the raw fetch tests pin the auth and edge-case
 * behavior spike 0a proved the vendor tolerates.
 */

const TOKEN = "monad-mcp-test-token";
const SESSION_ID = "0198f000-0000-7000-8000-000000000001";

let repo: FixtureRepo;
let reviewHandler: ChecksMcpServer;
let interactiveHandler: ChecksMcpServer;
let server: Server;
let baseUrl = "";

function mcpUrl(sessionId: string): string {
  return `${baseUrl}/mcp/${sessionId}`;
}

async function connectClient(sessionId: string): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(sessionId)), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  repo = makeFixtureRepo();
  const lintOverride = {
    checks: {
      lint: {
        enabled: true,
        severity: "fail" as const,
        command: `${repo.biomeBin} check ${repo.planted.lintError.file}`,
      },
    },
  };
  // Review-style binding: base and head pinned to the fixture's branch diff.
  reviewHandler = createChecksMcpServer({
    cwd: repo.dir,
    base: repo.baseSha,
    head: repo.headSha,
    config: lintOverride,
    sessionId: SESSION_ID,
  });
  // Interactive-style binding: no base/head; the diff is computed at call
  // time against the default-branch merge-base (fixture HEAD is `feature`,
  // default branch detection lands on `main`).
  interactiveHandler = createChecksMcpServer({
    cwd: repo.dir,
    config: lintOverride,
    sessionId: "interactive",
  });
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === `/mcp/${SESSION_ID}`) {
      void reviewHandler.handleRequest(req, res);
      return;
    }
    if (pathname === "/mcp/interactive") {
      void interactiveHandler.handleRequest(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected server address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(repo.dir, { recursive: true, force: true });
});

describe("auth and transport edges", () => {
  test("POST without the bearer token gets 401", async () => {
    const response = await fetch(mcpUrl(SESSION_ID), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  test("standalone GET (SSE attempt) gets 405", async () => {
    const response = await fetch(mcpUrl(SESSION_ID), {
      headers: { Authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
  });

  test("the nonstandard server/discover POST gets a method-not-found error", async () => {
    const response = await fetch(mcpUrl(SESSION_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
  });

  test("a malformed body gets a JSON-RPC parse error", async () => {
    const response = await fetch(mcpUrl(SESSION_ID), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe("tools over the MCP client", () => {
  test("tools/list exposes run_checks, list_checks, check_config", async () => {
    const client = await connectClient(SESSION_ID);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["check_config", "list_checks", "run_checks"]);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  });

  test("run_checks returns CheckRunResults JSON plus a markdown table with file:line", async () => {
    const client = await connectClient(SESSION_ID);
    try {
      const result = await client.callTool({
        name: "run_checks",
        arguments: { only: ["secrets", "lint", "file_patterns"] },
      });
      const structured = result.structuredContent as unknown as CheckRunResults;
      expect(structured.hasFailures).toBe(true);
      expect(Array.isArray(structured.checks)).toBe(true);
      const secretCheck = structured.checks.find((c) => c.type === "secrets");
      expect(secretCheck?.status).toBe("fail");
      const findings = secretCheck?.details.findings as Array<{ file: string; line: number }>;
      expect(findings.some((f) => f.file === repo.planted.secret.file)).toBe(true);

      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("| check | status | findings |");
      expect(text).toContain(
        `${repo.planted.secret.file}:${repo.planted.secret.line}`,
      );
      expect(text).toContain(
        `${repo.planted.lintError.file}:${repo.planted.lintError.line}`,
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  test("run_checks rejects an unknown check name", async () => {
    const client = await connectClient(SESSION_ID);
    try {
      const promise = client.callTool({
        name: "run_checks",
        arguments: { only: ["nonsense"] },
      });
      expect(promise).rejects.toThrow(/only must be an array of check names/);
    } finally {
      await client.close();
    }
  });

  test("run_checks without base/head diffs against the default-branch merge-base", async () => {
    const client = await connectClient("interactive");
    try {
      const result = await client.callTool({
        name: "run_checks",
        arguments: { only: ["secrets"] },
      });
      const structured = result.structuredContent as unknown as CheckRunResults;
      const secretCheck = structured.checks.find((c) => c.type === "secrets");
      expect(secretCheck?.status).toBe("fail");
      const findings = secretCheck?.details.findings as Array<{ file: string; line: number }>;
      expect(
        findings.some(
          (f) => f.file === repo.planted.secret.file && f.line === repo.planted.secret.line,
        ),
      ).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("list_checks reports all eight checks and the config source", async () => {
    const client = await connectClient(SESSION_ID);
    try {
      const result = await client.callTool({ name: "list_checks", arguments: {} });
      const structured = result.structuredContent as {
        checks: Array<{ key: string; enabled: boolean; severity: string; profile: string }>;
        source: string;
      };
      expect(structured.checks).toHaveLength(8);
      expect(structured.source).toBe("defaults");
      const lint = structured.checks.find((c) => c.key === "lint");
      expect(lint?.enabled).toBe(true);
      expect(lint?.severity).toBe("fail");
    } finally {
      await client.close();
    }
  });

  test("check_config returns the effective config and loader warnings", async () => {
    const client = await connectClient(SESSION_ID);
    try {
      const result = await client.callTool({ name: "check_config", arguments: {} });
      const structured = result.structuredContent as {
        config: { checks: Record<string, { command?: string }> };
        source: string;
        warnings: string[];
      };
      expect(structured.source).toBe("defaults");
      expect(Array.isArray(structured.warnings)).toBe(true);
      // The session override made it into the effective config.
      expect(structured.config.checks.lint?.command).toContain("biome");
    } finally {
      await client.close();
    }
  });
});
