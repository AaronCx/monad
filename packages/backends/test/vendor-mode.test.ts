import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SessionStore } from "@aaroncx/engine";
import { createClaudeBackend } from "../src/index.ts";

/**
 * Decision 0007 vendor layering: review sessions get session/set_mode
 * { modeId: "plan" } right after the vendor session/new (or session/load),
 * fix sessions get "default", interactive sessions get no set_mode call at
 * all. The empty acknowledgment is success; nothing waits for a
 * current_mode_update (the vendor never sends one for client-initiated
 * switches).
 *
 * The fake agent records every session/set_mode it receives as one JSON
 * line in <cwd>/fake-agent-modes.jsonl.
 */

const FIXTURE = new URL("./fixtures/fake-agent.ts", import.meta.url).pathname;

interface RecordedMode {
  method: string;
  sessionId: string;
  modeId: string;
}

function recordedModes(cwd: string): RecordedMode[] {
  const file = join(cwd, "fake-agent-modes.jsonl");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedMode);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function makeHarness(): { manager: SessionManager; store: SessionStore; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "monad-vendor-mode-"));
  const store = new SessionStore({ dbPath: ":memory:" });
  const manager = new SessionManager({
    store,
    createBackend: createClaudeBackend({ command: [process.execPath, FIXTURE] }),
  });
  cleanups.push(async () => {
    await manager.shutdown();
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { manager, store, cwd };
}

describe("vendor mode layering (decision 0007)", () => {
  test("a review session sets plan mode right after session/new", async () => {
    const { manager, cwd } = makeHarness();
    await manager.create({ cwd, mode: "review" });
    const modes = recordedModes(cwd);
    expect(modes).toHaveLength(1);
    expect(modes[0]?.modeId).toBe("plan");
  });

  test("a fix session sets default mode explicitly", async () => {
    const { manager, cwd } = makeHarness();
    await manager.create({ cwd, mode: "fix" });
    const modes = recordedModes(cwd);
    expect(modes).toHaveLength(1);
    expect(modes[0]?.modeId).toBe("default");
  });

  test("an interactive session sends no set_mode at all", async () => {
    const { manager, cwd } = makeHarness();
    await manager.create({ cwd, mode: "interactive" });
    expect(recordedModes(cwd)).toHaveLength(0);
  });

  test("setMode on a live session re-layers the vendor mode", async () => {
    const { manager, cwd } = makeHarness();
    const record = await manager.create({ cwd, mode: "review" });
    await manager.setMode(record.id, "fix");
    const modes = recordedModes(cwd).map((entry) => entry.modeId);
    expect(modes).toEqual(["plan", "default"]);
    expect(manager.get(record.id)?.mode).toBe("fix");
  });

  test("a restored review session re-applies plan mode after session/load", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "monad-vendor-mode-"));
    const store = new SessionStore({ dbPath: ":memory:" });
    cleanups.push(() => {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    });
    const first = new SessionManager({
      store,
      createBackend: createClaudeBackend({ command: [process.execPath, FIXTURE] }),
    });
    const record = await first.create({ cwd, mode: "review" });
    await first.shutdown();

    const second = new SessionManager({
      store,
      createBackend: createClaudeBackend({ command: [process.execPath, FIXTURE] }),
    });
    cleanups.push(() => second.shutdown());
    // Prompting forces the backend restart through the session/load path.
    await second.prompt(record.id, {
      sessionId: record.id,
      prompt: [{ type: "text", text: "hello again" }],
    });
    const modes = recordedModes(cwd).map((entry) => entry.modeId);
    expect(modes).toEqual(["plan", "plan"]);
  });
});
