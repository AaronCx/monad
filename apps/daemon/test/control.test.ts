import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SessionStore } from "@aaroncx/engine";
import type { SessionRecord } from "@aaroncx/protocol";
import { createControlHandler } from "../src/control.ts";

/**
 * PATCH /v1/sessions/<id> (monad Link phase 1) against the control handler
 * in process: a real store and manager, no daemon, no backend. Bearer auth
 * sits in the transport in front of this handler and is covered by the
 * integration tests; this file is about the route itself.
 */

let dir: string;
let store: SessionStore;
let manager: SessionManager;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "monad-control-"));
  store = new SessionStore({ dbPath: join(dir, "monad.db") });
  manager = new SessionManager({
    store,
    createBackend: () => {
      throw new Error("no backend in this test");
    },
  });
  server = createServer(createControlHandler({ manager, version: "test", startedAt: new Date() }));
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
