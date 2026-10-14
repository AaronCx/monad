import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SessionStore } from "@aaroncx/engine";
import { defaultLinkConfig, LinkService } from "@aaroncx/link";
import type { SessionRecord } from "@aaroncx/protocol";
import { createControlHandler } from "../src/control.ts";

/**
 * The Link control routes against the control handler in process: a real
 * store, manager and LinkService, no daemon, and a backend whose turns end
 * at once. Bearer auth sits in the transport in front of this handler and is
 * covered by the integration tests; this file is about the routes
 * themselves.
 */

let dir: string;
let store: SessionStore;
let manager: SessionManager;
let link: LinkService;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "monad-control-"));
  store = new SessionStore({ dbPath: join(dir, "monad.db") });
  manager = new SessionManager({
    store,
    createBackend: () => ({
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: async () => {},
      close: async () => {},
    }),
  });
  link = new LinkService({ manager, store, config: defaultLinkConfig() });
  server = createServer(createControlHandler({ manager, link, version: "test", startedAt: new Date() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function newSession(): SessionRecord {
  const record = manager.createRecord({ cwd: dir });
  store.append(record.id, "prompt", {
    sessionId: record.id,
    prompt: [{ type: "text", text: "Fix the scroll clamp\nplease" }],
  });
  return record;
}

async function patch(id: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/v1/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /v1/sessions/<id>", () => {
  test("a prompt-derived title is shown in the session list", async () => {
    const record = newSession();
    const { sessions } = (await (await fetch(`${base}/v1/sessions`)).json()) as {
      sessions: SessionRecord[];
    };
    expect(sessions.find((s) => s.id === record.id)).toMatchObject({
      title: "Fix the scroll clamp",
      titleSource: "prompt",
    });
  });

  test("sets a manual title, one line, and later prompts do not replace it", async () => {
    const record = newSession();
    const updatedAt = store.get(record.id)?.updatedAt;
    const response = await patch(record.id, { title: "  meshyy\n scrolling  " });
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: SessionRecord };
    expect(session).toMatchObject({ id: record.id, title: "meshyy scrolling", titleSource: "manual" });
    expect(session.updatedAt).toBe(updatedAt ?? "");

    store.append(record.id, "prompt", {
      sessionId: record.id,
      prompt: [{ type: "text", text: "another ask" }],
    });
    expect(store.get(record.id)?.title).toBe("meshyy scrolling");
  });

  test("null drops the manual title and re-derives from the first prompt", async () => {
    const record = newSession();
    await patch(record.id, { title: "temporary" });
    const response = await patch(record.id, { title: null });
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: SessionRecord };
    expect(session).toMatchObject({ title: "Fix the scroll clamp", titleSource: "prompt" });
  });

  test("bad bodies are 400, unknown sessions 404, other methods and paths refused", async () => {
    const record = newSession();
    expect((await patch(record.id, "{not json")).status).toBe(400);
    expect((await patch(record.id, { title: "" })).status).toBe(400);
    expect((await patch(record.id, { title: "x".repeat(201) })).status).toBe(400);
    expect((await patch(record.id, { title: "ok", mode: "fix" })).status).toBe(400);
    expect((await patch(record.id, {})).status).toBe(400);
    expect((await patch(Bun.randomUUIDv7(), { title: "x" })).status).toBe(404);
    expect((await patch("not-a-session", { title: "x" })).status).toBe(404);
    const nested = await fetch(`${base}/v1/sessions/${record.id}/extra`, {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
    });
    expect(nested.status).toBe(404);
    const put = await fetch(`${base}/v1/sessions/${record.id}`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(405);
    expect(store.get(record.id)?.title).toBe("Fix the scroll clamp");
  });
});

describe("monad Link routes (the human as caller)", () => {
  const TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

  function sessionWithHistory(text: string): SessionRecord {
    const record = manager.createRecord({ cwd: dir });
    store.append(record.id, "prompt", { sessionId: record.id, prompt: [{ type: "text", text }] });
    return record;
  }

  test("GET /v1/search returns redacted hits and logs the access on the target", async () => {
    const record = sessionWithHistory(`the walrus key is ${TOKEN}`);
    const response = await fetch(`${base}/v1/search?q=walrus`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hits: Array<{ sessionId: string; snippet: string }> };
    expect(body.hits.map((hit) => hit.sessionId)).toContain(record.id);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    const access = store.replayKinds(record.id, ["access"]).map((e) => e.payload);
    expect(access).toEqual([expect.objectContaining({ op: "search", by: "human", role: "target", query: "walrus" })]);
    expect((await fetch(`${base}/v1/search`)).status).toBe(400);
  });

  test("GET /v1/sessions/<id>/transcript pages the redacted transcript", async () => {
    const record = sessionWithHistory(`deploy with ${TOKEN}`);
    const response = await fetch(`${base}/v1/sessions/${record.id}/transcript?from=0&limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string; nextFromSeq: number | null; sessionId: string };
    expect(body.sessionId).toBe(record.id);
    expect(body.text).toContain("user: deploy with [REDACTED:");
    expect(body.nextFromSeq).toBeNull();
    expect(store.replayKinds(record.id, ["access"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ op: "read", by: "human", role: "target" }),
    ]);
    expect((await fetch(`${base}/v1/sessions/${Bun.randomUUIDv7()}/transcript`)).status).toBe(404);
  });

  test("POST /v1/sessions/<id>/messages delivers under the human header", async () => {
    const target = await manager.activate(manager.createRecord({ cwd: dir }).id);
    const response = await fetch(`${base}/v1/sessions/${target.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "status?" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { delivery: string }).delivery).toBe("turn");
    const prompt = store.replayKinds(target.id, ["prompt"]).at(-1)?.payload as {
      prompt: Array<{ text: string }>;
    };
    expect(prompt.prompt[0]?.text).toBe("[message from the human at the monad CLI]\n\nstatus?");

    const review = manager.createRecord({ cwd: dir, mode: "review", trust: "trusted" });
    const refused = await fetch(`${base}/v1/sessions/${review.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(refused.status).toBe(409);
    const empty = await fetch(`${base}/v1/sessions/${target.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "  " }),
    });
    expect(empty.status).toBe(400);
  });

  test("GET /v1/sessions filters by repo and status and reports repos; no filter is the M1 list", async () => {
    const all = (await (await fetch(`${base}/v1/sessions`)).json()) as { sessions: SessionRecord[]; repos?: unknown };
    expect(all.repos).toBeUndefined();
    const closed = manager.createRecord({ cwd: dir });
    store.setStatus(closed.id, "closed");
    const filtered = (await (await fetch(`${base}/v1/sessions?status=closed`)).json()) as {
      sessions: SessionRecord[];
      repos: Record<string, string[]>;
    };
    expect(filtered.sessions.map((s) => s.id)).toEqual([closed.id]);
    expect(filtered.repos[closed.id]).toEqual([]);
    expect((await fetch(`${base}/v1/sessions?status=paused`)).status).toBe(400);
  });
});
