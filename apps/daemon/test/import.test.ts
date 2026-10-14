import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { type ClientConnection, client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { deriveSessionsMountToken, SessionManager, SessionStore } from "@aaroncx/engine";
import { createHttpStream } from "@aaroncx/engine/transport";
import { defaultLinkConfig, Importer, LinkService } from "@aaroncx/link";
import type { ImportSummary, SearchResponse, SessionRecord, TranscriptResponse } from "@aaroncx/protocol";
import { createControlHandler } from "../src/control.ts";

/**
 * Link phase 4 end to end against the real monadd: link.json turns the
 * watcher on, the daemon imports a Claude Code log from the (temp) home's
 * ~/.claude/projects at start and again when the log grows, POST /v1/import
 * reports a summary, and the imported session is searchable and readable
 * but absent from ACP session/list and refused by session/load,
 * session/prompt, the mode switch, peer messages and its sessions mount.
 */

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL("../../../packages/backends/test/fixtures/fake-agent.ts", import.meta.url).pathname;
const FIXTURES = new URL("../../../packages/link/test/fixtures/import/", import.meta.url).pathname;
const MAIN_ID = "6f0c8a52-3b1d-4e7a-9c2f-5d8e1a4b7c90";
const CODEX_ID = "019c30d4-0000-7462-95a2-4e1fda3b0001";
const MAIN_FIXTURE = join(FIXTURES, "claude", "project", `${MAIN_ID}.jsonl`);
const CODEX_FIXTURE = join(FIXTURES, "codex", "2026", "02", "05", `rollout-2026-02-05T21-42-28-${CODEX_ID}.jsonl`);

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let root: string;
let home: string;
let monadHome: string;
let mainLog: string;
let daemon: { proc: Subprocess<"ignore", "pipe", "pipe">; port: number; token: string };
let acp: ClientConnection;

function fill(text: string): string {
  return text
    .replaceAll("{{HOME}}", home)
    .replaceAll("{{REPO_A}}", join(root, "repoA"))
    .replaceAll("{{REPO_B}}", join(root, "repoB"))
    .replaceAll("{{TOKEN}}", "not-a-token");
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${daemon.token}`, "content-type": "application/json", ...init.headers },
  });
}

async function search(q: string): Promise<SearchResponse["hits"]> {
  const response = await api(`/v1/search?q=${encodeURIComponent(q)}`);
  return ((await response.json()) as SearchResponse).hits;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "monad-import-e2e-")));
  home = join(root, "home");
  monadHome = join(root, "monad-home");
  for (const dir of [join(root, "repoA", ".git"), join(root, "repoB", ".git"), monadHome]) {
    mkdirSync(dir, { recursive: true });
  }
  // The daemon runs with HOME pointed here, so its default roots are this
  // home's ~/.claude/projects and ~/.codex/sessions, never Aaron's.
  mainLog = join(home, ".claude", "projects", "-tmp-home", `${MAIN_ID}.jsonl`);
  mkdirSync(dirname(mainLog), { recursive: true });
  writeFileSync(mainLog, fill(readFileSync(MAIN_FIXTURE, "utf8")));
  writeFileSync(join(monadHome, "link.json"), JSON.stringify({ import: { watch: true } }));
  const infoPath = join(monadHome, "monadd.json");
  daemon = {
    proc: Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
      env: {
        ...process.env,
        HOME: home,
        MONAD_HOME: monadHome,
        MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT].join(" "),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
    port: 0,
    token: "",
  };
  await waitFor(() => existsSync(infoPath), "monadd.json to appear");
  daemon.port = (JSON.parse(readFileSync(infoPath, "utf8")) as { port: number }).port;
  daemon.token = readFileSync(join(monadHome, "token"), "utf8").trim();
  acp = client({ name: "import-test" })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => {
      throw new Error("unexpected permission request");
    })
    .connect(
      createHttpStream(`http://127.0.0.1:${daemon.port}/acp`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      }),
    );
  await acp.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
}, 30_000);

afterAll(async () => {
  daemon.proc.kill();
  await daemon.proc.exited;
  rmSync(root, { recursive: true, force: true });
});

describe("monadd imports vendor logs", () => {
  test("the watcher imports the home's Claude Code logs at start", async () => {
    await waitFor(async () => (await search("no previous window")).length > 0, "the watcher's first import");
    const hits = await search("no previous window");
    expect(hits[0]).toMatchObject({ sessionId: MAIN_ID });
    const listed = (await (await api("/v1/sessions?status=imported")).json()) as {
      sessions: SessionRecord[];
      repos: Record<string, string[]>;
    };
    expect(listed.sessions.find((s) => s.id === MAIN_ID)).toMatchObject({
      backend: "import:claude-code",
      status: "imported",
      cwd: home,
    });
    expect(listed.repos[MAIN_ID]).toEqual([join(root, "repoA"), join(root, "repoB")]);
  });

  test("POST /v1/import reports what it did, and a repeat appends nothing", async () => {
    const again = (await (await api("/v1/import", { method: "POST", body: "{}" })).json()) as ImportSummary;
    expect(again).toMatchObject({ eventsAppended: 0, sessionsCreated: 0 });
    expect(again.roots).toEqual([join(home, ".claude", "projects"), join(home, ".codex", "sessions")]);

    const codexDir = join(root, "elsewhere");
    mkdirSync(codexDir);
    const codexLog = join(codexDir, `rollout-2026-02-05T21-42-28-${CODEX_ID}.jsonl`);
    writeFileSync(codexLog, fill(readFileSync(CODEX_FIXTURE, "utf8")));
    const response = await api("/v1/import", { method: "POST", body: JSON.stringify({ paths: [codexDir] }) });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as ImportSummary;
    expect(summary).toMatchObject({ roots: [codexDir], filesScanned: 1, sessionsCreated: 1, skippedCount: 0 });
    expect(summary.eventsAppended).toBeGreaterThan(0);
    expect((await api("/v1/import", { method: "POST", body: '{"paths": "x"}' })).status).toBe(400);
  });

  test("an imported session reads like any other", async () => {
    const response = await api(`/v1/sessions/${MAIN_ID}/transcript`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as TranscriptResponse;
    expect(page.title).toBe("Why does scrolling in the pager say no previous window?");
    expect(page.text).toContain("user: Why does scrolling in the pager");
    expect(page.text).toContain(`tool Read ${join(root, "repoA")}/src/scroll.ts (read)`);
  });

  test("ACP never offers it, and load, prompt, mode and messages are refused", async () => {
    const live = await acp.agent.request(methods.agent.session.new, { cwd: home, mcpServers: [] });
    const list = await acp.agent.request(methods.agent.session.list, {});
    const ids = list.sessions.map((s) => s.sessionId);
    expect(ids).toContain(live.sessionId);
    expect(ids).not.toContain(MAIN_ID);
    expect(ids).not.toContain(CODEX_ID);

    await expect(
      acp.agent.request(methods.agent.session.load, { sessionId: MAIN_ID, cwd: home, mcpServers: [] }),
    ).rejects.toThrow(/imported claude-code log/);
    await expect(
      acp.agent.request(methods.agent.session.prompt, {
        sessionId: MAIN_ID,
        prompt: [{ type: "text", text: "continue" }],
      }),
    ).rejects.toThrow(/imported/);
    const mode = await api(`/v1/sessions/${MAIN_ID}/mode`, { method: "POST", body: '{"mode":"fix"}' });
    expect(mode.status).toBe(409);
    const message = await api(`/v1/sessions/${MAIN_ID}/messages`, { method: "POST", body: '{"text":"status?"}' });
    expect(message.status).toBe(409);
    // Its sessions mount does not exist, whatever the token.
    const mount = await fetch(`http://127.0.0.1:${daemon.port}/mcp-sessions/${MAIN_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deriveSessionsMountToken(daemon.token, MAIN_ID)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mount.status).toBe(404);
    const record = (await (await api("/v1/sessions")).json()) as { sessions: SessionRecord[] };
    expect(record.sessions.find((s) => s.id === MAIN_ID)?.status).toBe("imported");
  });

  test("the watcher picks up lines appended to a log", async () => {
    appendFileSync(
      mainLog,
      `${JSON.stringify({
        type: "user",
        sessionId: MAIN_ID,
        cwd: home,
        isSidechain: false,
        timestamp: "2026-07-29T19:00:00.000Z",
        message: { role: "user", content: "the watched marmalade question" },
      })}\n`,
    );
    await waitFor(async () => (await search("marmalade")).length > 0, "the appended line to be imported", 15_000);
    expect((await search("marmalade"))[0]?.sessionId).toBe(MAIN_ID);
  }, 20_000);
});

describe("POST /v1/import without an enabled importer", () => {
  let dir: string;
  let store: SessionStore;
  let server: Server;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "monad-import-control-"));
    store = new SessionStore({ dbPath: join(dir, "monad.db") });
    const manager = new SessionManager({
      store,
      createBackend: () => ({
        prompt: async () => ({ stopReason: "end_turn" as const }),
        cancel: async () => {},
        close: async () => {},
      }),
    });
    const link = new LinkService({ manager, store, config: defaultLinkConfig() });
    const importer = new Importer({ store, config: { enabled: false, watch: false, roots: [] }, home: dir });
    server = createServer(createControlHandler({ manager, link, importer, version: "test", startedAt: new Date() }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("import.enabled: false is a 409 that says so", async () => {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/import`, { method: "POST", body: "" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("import.enabled is false");
  });
});
