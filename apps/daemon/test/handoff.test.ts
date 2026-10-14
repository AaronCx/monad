import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type ClientConnection, client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";

/**
 * monad Link phase 3 end to end against the real monadd with the fake ACP
 * agent as the vendor (decision record 0012):
 *
 * - a session idle past MONAD_HANDOFF_IDLE_MS gets exactly one handoff, and
 *   one left idle under a previous daemon is caught up when the next starts;
 * - `POST /v1/sessions/<id>/handoff { summarize: true }` runs a summarizer
 *   session that is untrusted, whose vendor was handed NO monad-sessions
 *   entry, in an empty directory under $MONAD_HOME/summaries, and stores its
 *   answer on the target as a summary event;
 * - a session's vendor appends a repo note over its injected monad-sessions
 *   entry, and the note lands under $MONAD_HOME/notes stamped with its id.
 */

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL("../../../packages/backends/test/fixtures/fake-agent.ts", import.meta.url).pathname;
const PLANTED_TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

interface Daemon {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
  connection: ClientConnection;
}

let home = "";
let repo = "";
let mcpLog = "";
let daemon: Daemon | undefined;
const dirs: string[] = [];

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

async function startDaemon(idleMs: number): Promise<Daemon> {
  const infoPath = join(home, "monadd.json");
  rmSync(infoPath, { force: true });
  const proc = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_HANDOFF_IDLE_MS: String(idleMs),
      MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT, "--link", "--mcp-log", mcpLog].join(" "),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(infoPath), "monadd.json to appear");
  const port = (JSON.parse(readFileSync(infoPath, "utf8")) as { port: number }).port;
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const connection = client({ name: "handoff-test" })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }))
    .connect(createHttpStream(`http://127.0.0.1:${port}/acp`, { headers: { Authorization: `Bearer ${token}` } }));
  await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return { proc, port, token, connection };
}

async function stopDaemon(d: Daemon): Promise<void> {
  d.connection.close();
  d.proc.kill("SIGTERM");
  await d.proc.exited;
}

async function newSession(d: Daemon, cwd: string): Promise<string> {
  return (await d.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })).sessionId;
}

async function prompt(d: Daemon, sessionId: string, text: string): Promise<void> {
  await d.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
}

function query<T>(sql: string, ...params: string[]): T[] {
  const db = new Database(join(home, "monad.db"), { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function events(sessionId: string, kind: string): Array<Record<string, any>> {
  return query<{ payload: string }>(
    "select payload from events where session_id = ? and kind = ? order by seq",
    sessionId,
    kind,
  ).map((row) => JSON.parse(row.payload));
}

function loggedMcp(): Array<{ method: string; cwd: string; mcpServers: Array<{ name?: string }> }> {
  if (!existsSync(mcpLog)) {
    return [];
  }
  return readFileSync(mcpLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function control(d: Daemon, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

let stale = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-handoff-home-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "monad-handoff-repo-")));
  mkdirSync(join(repo, ".git"));
  dirs.push(home, repo);
  mcpLog = join(home, "fake-agent-mcp-log.jsonl");
  // The previous daemon: a ten-minute window, so its session goes idle and
  // is never handed off before it stops.
  const first = await startDaemon(600_000);
  stale = await newSession(first, repo);
  await prompt(first, stale, `remember the walrus; key ${PLANTED_TOKEN}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(events(stale, "handoff")).toEqual([]);
  await stopDaemon(first);
  // The next daemon, with a short window, catches it up at start.
  daemon = await startDaemon(300);
}, 60_000);

afterAll(async () => {
  if (daemon) {
    await stopDaemon(daemon);
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("idle handoffs in the daemon", () => {
  test("a session idle under the previous daemon is handed off when the next one starts", async () => {
    await waitFor(() => events(stale, "handoff").length === 1, "the catch-up handoff");
    const [handoff] = events(stale, "handoff");
    expect(handoff?.reason).toBe("idle");
    expect(handoff?.text.split("\n")[0]).toContain('idle: last asked "remember the walrus; key [REDACTED:');
    expect(JSON.stringify(handoff)).not.toContain(PLANTED_TOKEN);
  });

  test("a session going idle now gets exactly one handoff after the window", async () => {
    const d = daemon as Daemon;
    const id = await newSession(d, repo);
    await prompt(d, id, "tidy the status row");
    await waitFor(() => events(id, "handoff").length === 1, "the idle handoff", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(events(id, "handoff")).toHaveLength(1);
    const listed = await control(d, "GET", `/v1/sessions?repo=${encodeURIComponent(repo)}`);
    expect(listed.json.handoffs[id]).toStartWith('idle: last asked "tidy the status row"');
  });
});

describe("the summary is on demand, by an untrusted summarizer", () => {
  test("POST /v1/sessions/<id>/handoff { summarize: true }", async () => {
    const d = daemon as Daemon;
    const before = new Set(query<{ id: string }>("select id from sessions").map((row) => row.id));
    const response = await control(d, "POST", `/v1/sessions/${stale}/handoff`, { summarize: true });
    expect(response.status).toBe(200);
    expect(response.json.handoff.reason).toBe("manual");
    const summarizer: string = response.json.summary.summarizerSessionId;
    expect(before.has(summarizer)).toBe(false);

    // The record: untrusted, review, in an empty directory of its own, closed.
    const [record] = query<{ trust: string; mode: string; cwd: string; status: string }>(
      "select trust, mode, cwd, status from sessions where id = ?",
      summarizer,
    );
    expect(record).toEqual({
      trust: "untrusted",
      mode: "review",
      cwd: join(home, "summaries", stale),
      status: "closed",
    });
    // Its vendor got the checks mount every session gets, and NO
    // monad-sessions entry: it cannot reach another session.
    const handed = loggedMcp().filter((entry) => entry.cwd === record?.cwd);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.mcpServers.map((server) => server.name)).toEqual(["monad-checks"]);
    // Nothing in its directory but the fake vendor's own recordings.
    expect(readdirSync(record?.cwd ?? "").filter((name) => !name.startsWith("fake-agent-"))).toEqual([]);

    // The answer is on the TARGET's log; the fake agent echoes its prompt,
    // which proves the summarizer saw fenced, redacted history.
    const [summary] = events(stale, "summary");
    expect(summary?.summarizerSessionId).toBe(summarizer);
    expect(summary?.text).toStartWith("echo: Summarize monad session");
    expect(summary?.text).toContain("[monad: quoted history from session");
    expect(JSON.stringify(summary)).not.toContain(PLANTED_TOKEN);
    expect(events(stale, "access").map((access) => access.op)).toEqual(["handoff", "summarize"]);
    // A summarizer is a tool run: no handoff of its own on close.
    expect(events(summarizer, "handoff")).toEqual([]);
  }, 30_000);
});

describe("repo notes from a session", () => {
  test("a vendor's notes_append over its mount lands under MONAD_HOME/notes, stamped with its session", async () => {
    const d = daemon as Daemon;
    const id = await newSession(d, repo);
    await prompt(d, id, `link:notes_append ${JSON.stringify({ repo, text: "never commit to main" })}`);
    const files = readdirSync(join(home, "notes"));
    expect(files).toHaveLength(1);
    const file = join(home, "notes", files[0] as string);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [note] = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(note).toMatchObject({ by: id, repo, text: "never commit to main" });
    expect(readdirSync(repo)).toEqual([".git"]);
    const read = await control(d, "GET", `/v1/notes?repo=${encodeURIComponent(repo)}`);
    expect(read.json.notes.map((n: { text: string }) => n.text)).toEqual(["never commit to main"]);
    expect((await control(d, "GET", "/v1/notes")).status).toBe(400);
  }, 20_000);
});
