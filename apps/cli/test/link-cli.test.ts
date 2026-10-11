import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { client, type ClientConnection, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";
import { formatAccess, formatPeerMessage } from "../src/render.ts";
import {
  formatSessionRow,
  parseLsFlags,
  parseSearchFlags,
  parseSendArgs,
  parseShowFlags,
  parseSince,
  parseTitleArgs,
} from "../src/link.ts";

/**
 * monad Link from the terminal (decision record 0012): flag parsing and
 * formatting as units, then search, show, send, ls --repo and title against
 * a real monadd with the fake agent, through the CLI binary's entry point.
 */

describe("Link flag parsing", () => {
  test("search joins its words and resolves --repo, --since and --limit", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    expect(parseSearchFlags(["scroll", "clamp", "--limit", "5", "--since", "1d"], now)).toEqual({
      query: "scroll clamp",
      limit: 5,
      since: "2026-10-10T12:00:00.000Z",
    });
    expect(parseSearchFlags(["x", "--repo", "/abs/repo"]).repo).toBe("/abs/repo");
    expect(parseSearchFlags(["x", "--repo", "rel"]).repo).toBe(join(process.cwd(), "rel"));
    expect(() => parseSearchFlags([])).toThrow("needs a query");
    expect(() => parseSearchFlags(["x", "--deep"])).toThrow("unknown flag --deep");
    expect(() => parseSearchFlags(["x", "--limit"])).toThrow("--limit needs a number");
  });

  test("--since takes an ISO timestamp or a duration", () => {
    expect(parseSince("2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00.000Z");
    expect(parseSince("12h", new Date("2026-10-11T12:00:00.000Z"))).toBe("2026-10-11T00:00:00.000Z");
    expect(() => parseSince("soon")).toThrow("cannot parse soon");
  });

  test("show, send, title and ls", () => {
    expect(parseShowFlags(["0199", "--from", "40", "--limit", "10"])).toEqual({ id: "0199", from: 40, limit: 10 });
    expect(() => parseShowFlags([])).toThrow("needs a session id");
    expect(parseSendArgs(["0199", "what", "changed?"])).toEqual({ id: "0199", text: "what changed?" });
    expect(() => parseSendArgs(["0199"])).toThrow("needs a message");
    expect(parseTitleArgs(["0199", "meshyy", "scroll"])).toEqual({ id: "0199", title: "meshyy scroll" });
    expect(parseLsFlags([])).toEqual({ all: false });
    expect(parseLsFlags(["--all", "--repo", "/r"])).toEqual({ all: true, repo: "/r" });
    expect(() => parseLsFlags(["--everything"])).toThrow("unknown flag");
  });
});

describe("Link rendering", () => {
  test("a peer message line names the sender and how it was delivered", () => {
    expect(
      formatPeerMessage({
        sessionId: "s",
        from: "019a0000-0000-7000-8000-000000000001",
        fromTitle: "fix the clamp",
        text: "what\nchanged?",
        hop: 1,
        delivery: "queued",
      }),
    ).toBe('peer message from session 019a0000 "fix the clamp" (hop 1, queued for the next turn): what changed?');
    expect(formatPeerMessage({ sessionId: "s", from: "human", text: "hi", hop: 0, delivery: "turn" })).toBe(
      "peer message from the human (hop 0, delivered as a turn): hi",
    );
  });

  test("an access line says who did what, and refusals", () => {
    expect(formatAccess({ sessionId: "s", op: "read", by: "human", role: "target" })).toBe(
      "access: the human ran read on this session",
    );
    expect(
      formatAccess({
        sessionId: "s",
        op: "message",
        by: "s",
        role: "caller",
        target: "019a0000-0000-7000-8000-000000000002",
        refused: "rate limited",
      }),
    ).toBe("access: this session ran message on 019a0000 (refused: rate limited)");
  });

  test("an ls row carries the title and, with --repo, the repos", () => {
    const now = new Date().toISOString();
    const row = formatSessionRow(
      {
        id: "019a0000-0000-7000-8000-000000000003",
        cwd: "/home",
        backend: "claude-acp",
        mode: "interactive",
        status: "idle",
        trust: "trusted",
        title: "meshyy scroll",
        createdAt: now,
        updatedAt: now,
      },
      ["/r/meshyy", "/r/monad"],
    );
    expect(row).toContain('"meshyy scroll"');
    expect(row).toEndWith("repos: /r/meshyy, /r/monad");
  });
});

const DAEMON_MAIN = new URL("../../daemon/src/main.ts", import.meta.url).pathname;
const CLI_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL("../../../packages/backends/test/fixtures/fake-agent.ts", import.meta.url).pathname;
const PLANTED_TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

let home = "";
let repo = "";
let daemon: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let connection: ClientConnection | undefined;
let sessionId = "";

async function waitFor(condition: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function monad(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    env: { ...process.env, MONAD_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-linkcli-home-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "monad-linkcli-repo-")));
  mkdirSync(join(repo, ".git"));
  daemon = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: { ...process.env, MONAD_HOME: home, MONAD_BACKEND_CMD: `${process.execPath} ${FAKE_AGENT}` },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(join(home, "monadd.json")), "monadd.json");
  const port = (JSON.parse(readFileSync(join(home, "monadd.json"), "utf8")) as { port: number }).port;
  const token = readFileSync(join(home, "token"), "utf8").trim();
  connection = client({ name: "link-cli-test" })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }))
    .connect(createHttpStream(`http://127.0.0.1:${port}/acp`, { headers: { Authorization: `Bearer ${token}` } }));
  await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  sessionId = (await connection.agent.request(methods.agent.session.new, { cwd: repo, mcpServers: [] })).sessionId;
  await connection.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: `Fix the walrus scroll clamp; the key is ${PLANTED_TOKEN}` }],
  });
}, 30_000);

afterAll(async () => {
  connection?.close();
  daemon?.kill();
  await daemon?.exited;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("monad search, show, send, ls and title against monadd", () => {
  test("search finds the session, redacted", async () => {
    const { code, out } = await monad("search", "walrus");
    expect(code).toBe(0);
    expect(out).toContain(sessionId);
    expect(out).toContain("Fix the walrus scroll clamp");
    expect(out).not.toContain(PLANTED_TOKEN);
  }, 20_000);

  test("send delivers as the human, and show displays the exchange and the access events", async () => {
    const sent = await monad("send", sessionId.slice(0, 13), "what", "is", "left?");
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("it started the session's next turn");
    // The peer_message and the prompt that delivers it are logged before
    // send returns, so show sees both at once.
    const shown = await monad("show", sessionId.slice(0, 13));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("user: Fix the walrus scroll clamp; the key is [REDACTED:");
    expect(shown.out).toContain("peer message from human (hop 0, delivered as a turn): what is left?");
    expect(shown.out).toContain("user (peer message, hop 0): [message from the human at the monad CLI]");
    // The earlier search and this send are on the record.
    expect(shown.out).toContain("access: human search (target)");
    expect(shown.out).toContain("access: human message (target)");
    expect(shown.out).not.toContain(PLANTED_TOKEN);
  }, 20_000);

  test("ls --repo lists the session that touched the repo; title renames it", async () => {
    const titled = await monad("title", sessionId, "walrus", "fix");
    expect(titled.code).toBe(0);
    const listed = await monad("ls", "--repo", repo);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(sessionId);
    expect(listed.out).toContain('"walrus fix"');
    expect(listed.out).toContain(`repos: ${repo}`);
    const elsewhere = await monad("ls", "--repo", home);
    expect(elsewhere.out.trim()).toBe("no sessions");
  }, 20_000);

  test("errors are one line, not a stack", async () => {
    const missing = await monad("show", "ffffffff");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no session matches ffffffff");
  }, 20_000);
});
