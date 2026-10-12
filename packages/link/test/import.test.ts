import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { importedSessionRefusal } from "@aaroncx/engine";
import { type EventRecord, IMPORTED_META_KEY, SessionIdSchema } from "@aaroncx/protocol";
import { ImportDisabledError, Importer } from "../src/import/importer.ts";
import { ImportWatcher } from "../src/import/watch.ts";
import { LinkError } from "../src/service.ts";
import { type Harness, makeHarness, PLANTED_TOKEN, waitFor } from "./helpers.ts";

/**
 * The vendor log importer (monad Link phase 4, decision record 0012) against
 * small synthetic Claude Code and Codex logs (test/fixtures/import, modeled
 * on the real formats, never copies of real logs): what each line becomes,
 * incremental and idempotent re-import, truncated and replaced files, repo
 * tagging from tool paths in a session started outside any repo, subagents
 * as children, redaction, the skips, and that an imported session can be
 * read but never driven.
 */

const FIXTURES = new URL("./fixtures/import/", import.meta.url).pathname;
const MAIN_ID = "6f0c8a52-3b1d-4e7a-9c2f-5d8e1a4b7c90";
const CODEX_ID = "019c30d4-0000-7462-95a2-4e1fda3b0001";

interface Env {
  root: string;
  home: string;
  repoA: string;
  repoB: string;
  /** Where the materialized fixtures are: logs/claude/project/..., logs/codex/... */
  logs: string;
  mainLog: string;
  codexLog: string;
  h: Harness;
  importer: Importer;
}

const envs: Env[] = [];

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.h.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(path));
    } else if (entry.isFile() && entry.name !== "README.md") {
      out.push(path);
    }
  }
  return out;
}

/**
 * A temp world: a home that is NOT a repository, two repositories, and the
 * fixture logs with their placeholders filled in.
 */
function setup(options: { importEnabled?: boolean } = {}): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "monad-import-")));
  const home = join(root, "home");
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  for (const dir of [home, join(repoA, ".git"), join(repoA, "src"), join(repoB, ".git")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(repoA, "src", "scroll.ts"), "export function scroll() {}\n");
  const logs = join(root, "logs");
  for (const source of walkFiles(FIXTURES)) {
    const target = join(logs, relative(FIXTURES, source));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fill(readFileSync(source, "utf8"), { home, repoA, repoB }));
  }
  const h = makeHarness({ home });
  const importer = new Importer({
    store: h.store,
    config: { enabled: options.importEnabled ?? true, watch: false, roots: [] },
    home,
  });
  const env: Env = {
    root,
    home,
    repoA,
    repoB,
    logs,
    mainLog: join(logs, "claude", "project", `${MAIN_ID}.jsonl`),
    codexLog: join(logs, "codex", "2026", "02", "05", `rollout-2026-02-05T21-42-28-${CODEX_ID}.jsonl`),
    h,
    importer,
  };
  envs.push(env);
  return env;
}

function fill(text: string, paths: { home: string; repoA: string; repoB: string }): string {
  return text
    .replaceAll("{{HOME}}", paths.home)
    .replaceAll("{{REPO_A}}", paths.repoA)
    .replaceAll("{{REPO_B}}", paths.repoB)
    .replaceAll("{{TOKEN}}", PLANTED_TOKEN);
}

function updates(events: EventRecord[], kind: string): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.kind === "update")
    .map((event) => (event.payload as { update: Record<string, unknown> }).update)
    .filter((update) => update.sessionUpdate === kind);
}

function promptTexts(events: EventRecord[]): string[] {
  return events
    .filter((event) => event.kind === "prompt")
    .map((event) => (event.payload as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "");
}

/** Every search_fts row of one session, read straight from the database file. */
function ftsRows(env: Env, sessionId: string): Array<{ kind: string; text: string; first_seq: number }> {
  const db = new Database(join(env.h.dir, "monad.db"), { readonly: true });
  try {
    return db
      .query("SELECT kind, text, first_seq FROM search_fts WHERE session_id = ? ORDER BY first_seq")
      .all(sessionId) as Array<{ kind: string; text: string; first_seq: number }>;
  } finally {
    db.close();
  }
}

function claudeLine(env: Env, fields: Record<string, unknown>): string {
  return `${JSON.stringify({ sessionId: MAIN_ID, cwd: env.home, isSidechain: false, ...fields })}\n`;
}

/** A Claude Code log of `lines` asks, more than one import batch, in a directory of its own. */
function bigLog(env: Env, lines: number): { path: string; id: string } {
  const id = randomUUID();
  const dir = join(env.root, "big");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const parts: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    parts.push(
      `${JSON.stringify({
        sessionId: id,
        cwd: env.home,
        isSidechain: false,
        type: "user",
        timestamp: new Date(Date.UTC(2026, 6, 29, 15, 0, i)).toISOString(),
        origin: { kind: "human" },
        message: { role: "user", content: `ask number ${i}` },
      })}\n`,
    );
  }
  writeFileSync(path, parts.join(""));
  return { path, id };
}

describe("Claude Code logs", () => {
  test("each line kind becomes the right monad event, or nothing", async () => {
    const env = setup();
    const summary = await env.importer.run([env.logs]);
    // Two sessions, two subagents; the workflow journal is not a transcript.
    expect(summary).toMatchObject({ filesScanned: 4, sessionsCreated: 4, skippedCount: 0, linesMalformed: 0 });

    const record = env.h.store.get(MAIN_ID);
    expect(record).toMatchObject({
      backend: "import:claude-code",
      status: "imported",
      trust: "trusted",
      cwd: env.home,
      // Titled after the first real ask, not after /model or the task
      // notification that came before it.
      title: "Why does scrolling in the pager say no previous window?",
      titleSource: "import",
      createdAt: "2026-07-29T15:06:00.000Z",
      updatedAt: "2026-07-29T15:09:01.000Z",
    });
    const events = env.h.store.replay(MAIN_ID);
    expect(events[0]?.kind).toBe("session_created");
    // Timestamps are the log's own.
    expect(events.find((event) => event.kind === "prompt")?.ts).toBe("2026-07-29T15:06:01.000Z");

    // Prompts: the slash command, the task notification, the ask, the
    // queued ask and the compaction summary. Not the meta caveat, not the
    // command's stdout, not the sidechain line, not the tool results.
    const prompts = promptTexts(events);
    expect(prompts).toHaveLength(5);
    expect(prompts[0]).toBe("/model");
    expect(prompts[1]).toStartWith("<task-notification>");
    expect(prompts[2]).toStartWith("Why does scrolling");
    expect(prompts[3]).toContain("leaked into the build log");
    expect(prompts[4]).toStartWith("This session is being continued");
    const all = JSON.stringify(events);
    expect(all).not.toContain("Caveat: The messages below");
    expect(all).not.toContain("Set model to Opus");
    expect(all).not.toContain("a sidechain prompt");
    // An older Claude Code's summary line is client bookkeeping too.
    expect(all).not.toContain("Older Claude Code session summary");
    // Thinking is omitted, as for a live session.
    expect(all).not.toContain("secret scratch work");

    // One API message split over three lines: the text and the tool call
    // each land once.
    const texts = updates(events, "agent_message_chunk").map((u) => (u.content as { text: string }).text);
    expect(texts).toEqual([
      "That is tmux's message for a window switch. Let me read the scroll handler.",
      "Found it: the status-row clamp drops the scroll. Deferred: the resize divergence.",
    ]);
    const calls = updates(events, "tool_call");
    expect(calls).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_read",
        title: `Read ${env.repoA}/src/scroll.ts`,
        kind: "read",
        locations: [{ path: `${env.repoA}/src/scroll.ts` }],
      }),
      expect.objectContaining({ toolCallId: "toolu_bash", title: "Bash: Check the other repo", kind: "execute" }),
    ]);
    const results = updates(events, "tool_call_update");
    expect(results.map((u) => [u.toolCallId, u.status])).toEqual([
      ["toolu_read", "completed"],
      ["toolu_bash", "failed"],
    ]);
    expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "error").map((event) => event.payload)).toEqual([
      expect.objectContaining({ message: "You've hit your session limit" }),
    ]);
    // Every vendor-derived payload says where it came from.
    const fromLog = events.filter((event) => event.kind !== "session_created");
    for (const event of fromLog) {
      const meta = (event.payload as { _meta?: Record<string, { source: string; line: number }> })._meta;
      expect(meta?.[IMPORTED_META_KEY]?.source).toBe(env.mainLog);
    }
    const read = events.find((event) => event.kind === "update");
    expect((read?.payload as { _meta: Record<string, { line: number }> })._meta[IMPORTED_META_KEY]?.line).toBe(10);
  });

  test("a session started in a non-repo cwd is tagged by the repos its tool calls reached", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    // Read's file_path reached repo A; Bash's `cd` reached repo B. The cwd
    // (home) is not a repository and is not a tag.
    const repos = env.h.store.reposFor(MAIN_ID).map((repo) => repo.repoRoot);
    expect(repos).toEqual([env.repoA, env.repoB]);
    expect(env.h.store.sessionsForRepo(env.home)).toEqual([]);
  });

  test("subagents become children of their session, with stable version 8 ids", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    const children = env.h.store.childrenOf(MAIN_ID);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(SessionIdSchema.safeParse(child.id).success).toBe(true);
      expect(child.id[14]).toBe("8");
      expect(child).toMatchObject({ parentId: MAIN_ID, spawnDepth: 1, status: "imported" });
    }
    // Named by the description its parent gave it, from the .meta.json.
    const a1 = children.find((child) => child.cwd === env.repoA);
    expect(a1?.title).toBe("Reproduce the scroll bug");
    expect(env.h.store.reposFor(a1?.id ?? "").map((repo) => repo.repoRoot)).toEqual([env.repoA]);
    // The workflow agent has no meta file: its first ask names it.
    expect(children.find((child) => child.cwd === env.repoB)?.title).toBe("Review the clamp fix.");
    // A second run (or another daemon) lands on the same ids.
    const again = setup();
    await again.importer.run([again.logs]);
    expect(again.h.store.childrenOf(MAIN_ID).map((child) => child.id).sort()).toEqual(
      children.map((child) => child.id).sort(),
    );
  });

  test("tool output is cut to 4 KiB", async () => {
    const env = setup();
    appendFileSync(
      env.mainLog,
      claudeLine(env, {
        type: "user",
        timestamp: "2026-07-29T15:20:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: "x".repeat(50_000) }] },
      }),
    );
    await env.importer.run([env.logs]);
    const result = updates(env.h.store.replay(MAIN_ID), "tool_call_update").find((u) => u.toolCallId === "toolu_big");
    const text = (result?.content as Array<{ content: { text: string } }>)[0]?.content.text ?? "";
    expect(Buffer.byteLength(text)).toBeLessThan(4 * 1024 + 100);
    expect(text).toContain("cut by monad import: 50000 bytes in all");
  });
});

describe("Codex logs", () => {
  test("a rollout becomes a session: the asks, tool calls and results, the reply once", async () => {
    const env = setup();
    await env.importer.run([env.codexLog]);
    const record = env.h.store.get(CODEX_ID);
    expect(record).toMatchObject({
      backend: "import:codex",
      status: "imported",
      cwd: env.home,
      title: "Make the build green in repo B",
      createdAt: "2026-02-06T02:42:28.791Z",
    });
    const events = env.h.store.replay(CODEX_ID);
    // AGENTS.md, the permissions block and the user-role copy of the ask are
    // context Codex injected; the event_msg is what the human typed.
    expect(promptTexts(events)).toEqual(["Make the build green in repo B"]);
    expect(updates(events, "agent_message_chunk")).toHaveLength(1);
    const calls = updates(events, "tool_call");
    expect(calls[0]).toMatchObject({ toolCallId: "call_1", kind: "execute" });
    expect(calls[1]).toMatchObject({
      toolCallId: "call_2",
      kind: "edit",
      locations: [{ path: `${env.repoA}/main.c` }],
    });
    expect(updates(events, "tool_call_update").map((u) => [u.toolCallId, u.status])).toEqual([
      ["call_1", "failed"], // exit code 2
      ["call_2", "completed"],
    ]);
    expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(1);
    expect(env.h.store.reposFor(CODEX_ID).map((repo) => repo.repoRoot)).toEqual([env.repoB, env.repoA]);
  });
});

describe("incremental, idempotent re-import", () => {
  test("a second run appends nothing; new lines are appended once", async () => {
    const env = setup();
    const first = await env.importer.run([env.logs]);
    const before = env.h.store.replay(MAIN_ID).length;
    const rowsBefore = ftsRows(env, MAIN_ID).length;

    const second = await env.importer.run([env.logs]);
    expect(second).toMatchObject({ eventsAppended: 0, filesUnchanged: first.filesScanned, sessionsCreated: 0 });

    appendFileSync(
      env.mainLog,
      claudeLine(env, {
        type: "user",
        timestamp: "2026-07-29T16:00:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "what about the overscroll bounce" },
      }) +
        claudeLine(env, {
          type: "assistant",
          timestamp: "2026-07-29T16:00:01.000Z",
          message: { id: "msg_9", role: "assistant", content: [{ type: "text", text: "The bounce is fine." }] },
        }),
    );
    const third = await env.importer.run([env.logs]);
    expect(third).toMatchObject({ eventsAppended: 2, sessionsUpdated: 1, sessionsCreated: 0, sessionsReset: 0 });
    const after = env.h.store.replay(MAIN_ID);
    expect(after).toHaveLength(before + 2);
    expect(promptTexts(after).filter((text) => text.includes("overscroll"))).toHaveLength(1);
    expect(env.h.store.get(MAIN_ID)?.updatedAt).toBe("2026-07-29T16:00:01.000Z");
    // The title is the first ask's; a later one does not rename the session.
    expect(env.h.store.get(MAIN_ID)?.title).toStartWith("Why does scrolling");
    expect(ftsRows(env, MAIN_ID).length).toBe(rowsBefore + 2);
    expect(env.h.store.search("overscroll bounce").map((hit) => hit.sessionId)).toEqual([MAIN_ID]);

    const fourth = await env.importer.run([env.logs]);
    expect(fourth.eventsAppended).toBe(0);
    expect(env.h.store.replay(MAIN_ID)).toHaveLength(before + 2);
  });

  test("a partial trailing line waits for its newline; a malformed whole line is skipped", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    const before = env.h.store.replay(MAIN_ID).length;
    const line = claudeLine(env, {
      type: "user",
      timestamp: "2026-07-29T16:05:00.000Z",
      origin: { kind: "human" },
      message: { role: "user", content: "half written ask about the scrollback" },
    });
    // The vendor is mid-write: no newline yet.
    appendFileSync(env.mainLog, `{"truncated json\n${line.slice(0, 40)}`);
    const partial = await env.importer.run([env.logs]);
    expect(partial).toMatchObject({ eventsAppended: 0, linesMalformed: 1 });
    expect(env.h.store.importState(env.mainLog)?.offset).toBe(statSync(env.mainLog).size - 40);

    appendFileSync(env.mainLog, line.slice(40));
    const done = await env.importer.run([env.logs]);
    expect(done).toMatchObject({ eventsAppended: 1, linesMalformed: 0 });
    expect(env.h.store.replay(MAIN_ID)).toHaveLength(before + 1);
    expect(promptTexts(env.h.store.replay(MAIN_ID)).at(-1)).toBe("half written ask about the scrollback");
    expect(env.h.store.importState(env.mainLog)?.offset).toBe(statSync(env.mainLog).size);
  });

  test("a run that stops partway through a file resumes where it stopped, reading each line once", async () => {
    const env = setup();
    const big = bigLog(env, 2500);
    const store = env.h.store;
    const appendImported = store.appendImported.bind(store);
    // The run stops after its first committed batch (the daemon shutting
    // down mid-import closes the store under it the same way).
    let calls = 0;
    store.appendImported = (batch) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("simulated stop");
      }
      return appendImported(batch);
    };
    const stopped = await env.importer.run([big.path]);
    expect(stopped.skipped).toEqual([{ path: big.path, reason: "unreadable: simulated stop" }]);
    expect(promptTexts(store.replay(big.id))).toHaveLength(1000);
    store.appendImported = appendImported;

    // The file did not change, but it was not read to the end: the next run
    // is not fooled into skipping it as unchanged.
    const resumed = await env.importer.run([big.path]);
    expect(resumed).toMatchObject({ filesUnchanged: 0, sessionsReset: 0, eventsAppended: 1500 });
    const prompts = promptTexts(store.replay(big.id));
    expect(prompts).toHaveLength(2500);
    expect(new Set(prompts).size).toBe(2500);
    expect(prompts.at(-1)).toBe("ask number 2499");
    expect(await env.importer.run([big.path])).toMatchObject({ filesUnchanged: 1, eventsAppended: 0 });
  });

  test("runs never overlap: two started together read each line once", async () => {
    const env = setup();
    const big = bigLog(env, 2500);
    const [a, b] = await Promise.all([env.importer.run([big.path]), env.importer.run([big.path])]);
    // The second run waited for the first, then found nothing new.
    expect(a.eventsAppended).toBe(2501);
    expect(b).toMatchObject({ filesUnchanged: 1, eventsAppended: 0 });
    const prompts = promptTexts(env.h.store.replay(big.id));
    expect(prompts).toHaveLength(2500);
    expect(new Set(prompts).size).toBe(2500);
    expect(ftsRows(env, big.id).filter((row) => row.kind === "prompt")).toHaveLength(2500);
  });

  test("a truncated file is re-imported from the start: no duplicate index rows or repo tags, access kept", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    // Someone read the session: that access is on its log.
    env.h.link.read({ kind: "human" }, MAIN_ID);
    const original = readFileSync(env.mainLog, "utf8");
    // Keep the first 12 lines: up to the Read tool result, before the Bash cd.
    writeFileSync(env.mainLog, `${original.split("\n").slice(0, 12).join("\n")}\n`);

    const summary = await env.importer.run([env.logs]);
    expect(summary).toMatchObject({ sessionsReset: 1, sessionsCreated: 0 });

    // The same file imported into an empty store is the reference.
    const fresh = setup();
    writeFileSync(fresh.mainLog, readFileSync(env.mainLog, "utf8"));
    await fresh.importer.run([fresh.mainLog]);

    const kinds = (events: EventRecord[]) => events.filter((e) => e.kind !== "access").map((e) => e.kind);
    expect(kinds(env.h.store.replay(MAIN_ID))).toEqual(kinds(fresh.h.store.replay(MAIN_ID)));
    expect(ftsRows(env, MAIN_ID).map((row) => [row.kind, row.text])).toEqual(
      ftsRows(fresh, MAIN_ID).map((row) => [row.kind, row.text]),
    );
    // Repo B was only reached by the dropped Bash call.
    expect(env.h.store.reposFor(MAIN_ID).map((repo) => repo.repoRoot)).toEqual([env.repoA]);
    expect(env.h.store.search("status-row clamp", {})).toEqual([]);
    // The record of who read it survives the reset.
    expect(env.h.store.replayKinds(MAIN_ID, ["access"])).toHaveLength(1);
    expect(env.h.store.get(MAIN_ID)?.title).toStartWith("Why does scrolling");
  });

  test("a file replaced in place (same size or longer, different content) is re-imported too", async () => {
    const env = setup();
    await env.importer.run([env.codexLog]);
    const before = ftsRows(env, CODEX_ID).length;
    const text = readFileSync(env.codexLog, "utf8").replaceAll("Make the build green", "Make the tests green");
    writeFileSync(env.codexLog, text);
    const summary = await env.importer.run([env.codexLog]);
    expect(summary.sessionsReset).toBe(1);
    expect(promptTexts(env.h.store.replay(CODEX_ID))).toEqual(["Make the tests green in repo B"]);
    expect(env.h.store.get(CODEX_ID)?.title).toBe("Make the tests green in repo B");
    expect(ftsRows(env, CODEX_ID)).toHaveLength(before);
    expect(env.h.store.search("build green")).toEqual([]);
  });
});

describe("what is skipped", () => {
  test("a log of a session monad ran is skipped, subagents included", async () => {
    const env = setup();
    const ran = env.h.manager.createRecord({ cwd: env.home });
    env.h.store.setAgentSessionId(ran.id, MAIN_ID);
    const summary = await env.importer.run([join(env.logs, "claude")]);
    expect(summary.sessionsCreated).toBe(0);
    expect(summary.skippedCount).toBe(3);
    expect(summary.skipped.map((skip) => skip.reason)).toEqual(
      Array(3).fill("monad ran this session; its own log is the canonical one"),
    );
    expect(env.h.store.get(MAIN_ID)).toBeUndefined();
    // The same rule for a Codex session monad ran through codex-acp.
    const codex = env.h.manager.createRecord({ cwd: env.home, backend: "codex-acp" });
    env.h.store.setAgentSessionId(codex.id, CODEX_ID);
    expect((await env.importer.run([env.codexLog])).skippedCount).toBe(1);
    expect(env.h.store.get(CODEX_ID)).toBeUndefined();
  });

  test("the same log in two places is imported once; a copy takes over when the original is gone", async () => {
    const env = setup();
    const copyDir = join(env.root, "backup");
    mkdirSync(copyDir);
    const copy = join(copyDir, `${MAIN_ID}.jsonl`);
    copyFileSync(env.mainLog, copy);
    await env.importer.run([env.mainLog]);
    const events = env.h.store.replay(MAIN_ID).length;

    const twice = await env.importer.run([copy]);
    expect(twice.skipped).toEqual([{ path: copy, reason: `already imported from ${env.mainLog}` }]);
    expect(env.h.store.replay(MAIN_ID)).toHaveLength(events);

    // Claude Code purged the original; the copy holds the same lines.
    rmSync(env.mainLog);
    const adopted = await env.importer.run([copy]);
    expect(adopted).toMatchObject({ eventsAppended: 0, sessionsReset: 0, skippedCount: 0 });
    expect(env.h.store.importState(copy)?.sessionId).toBe(MAIN_ID);
    appendFileSync(
      copy,
      claudeLine(env, {
        type: "user",
        timestamp: "2026-07-29T17:00:00.000Z",
        message: { role: "user", content: "one more line in the copy" },
      }),
    );
    expect((await env.importer.run([copy])).eventsAppended).toBe(1);
    expect(env.h.store.replay(MAIN_ID)).toHaveLength(events + 1);
  });

  test("import.enabled: false turns the importer off", async () => {
    const env = setup({ importEnabled: false });
    await expect(env.importer.run([env.logs])).rejects.toBeInstanceOf(ImportDisabledError);
    expect(env.h.store.list()).toEqual([]);
  });

  test("the default roots are Claude Code's and Codex's own, plus link.json's", () => {
    const env = setup();
    const importer = new Importer({
      store: env.h.store,
      config: { enabled: true, watch: false, roots: ["~/elsewhere/logs"] },
      home: env.home,
    });
    expect(importer.roots()).toEqual([
      join(env.home, ".claude", "projects"),
      join(env.home, ".codex", "sessions"),
      join(env.home, "elsewhere", "logs"),
    ]);
  });
});

describe("redaction", () => {
  test("a token in a log is never in the index, a search hit, a title or a read", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    // The log keeps what the vendor wrote (it is the record), but nothing
    // derived from it or returned from it does.
    for (const row of ftsRows(env, MAIN_ID)) {
      expect(row.text).not.toContain(PLANTED_TOKEN);
    }
    expect(ftsRows(env, MAIN_ID).some((row) => row.text.includes("[REDACTED:"))).toBe(true);
    const hits = env.h.link.search({ kind: "human" }, "leaked build log");
    expect(hits.map((hit) => hit.sessionId)).toEqual([MAIN_ID]);
    expect(JSON.stringify(hits)).not.toContain(PLANTED_TOKEN);
    expect(env.h.store.search(PLANTED_TOKEN)).toEqual([]);
    const page = env.h.link.read({ kind: "human" }, MAIN_ID);
    expect(page.text).toContain("leaked into the build log");
    expect(page.text).not.toContain(PLANTED_TOKEN);
    expect(JSON.stringify(env.h.link.list({ kind: "human" }))).not.toContain(PLANTED_TOKEN);
  });
});

describe("an imported session is read-only", () => {
  test("it is listed, searched and read like any other session", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    const listed = env.h.link.list({ kind: "human" }, { status: "imported" });
    expect(listed.map((summary) => summary.id)).toContain(MAIN_ID);
    expect(listed.find((summary) => summary.id === MAIN_ID)?.repos).toEqual([env.repoA, env.repoB]);
    expect(env.h.link.list({ kind: "human" }, { includeImported: false })).toEqual([]);
    expect(env.h.link.search({ kind: "human" }, "no previous window")[0]?.sessionId).toBe(MAIN_ID);
    // A trusted interactive session can read it too, and the read is on both logs.
    const reader = await env.h.session(env.repoA);
    const page = env.h.link.read({ kind: "session", id: reader.id }, MAIN_ID);
    expect(page.text).toContain("[seq");
    const access = env.h.store.replayKinds(MAIN_ID, ["access"]).map((e) => e.payload as { by: string; op: string });
    expect(access.at(-1)).toMatchObject({ by: reader.id, op: "read" });
  });

  test("the manager refuses to attach, prompt, switch, cancel, close or start it", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    const before = env.h.store.replay(MAIN_ID).length;
    const record = env.h.store.get(MAIN_ID);
    if (!record) {
      throw new Error("not imported");
    }
    const refusal = importedSessionRefusal(record).message;
    const client = { onEvent() {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
    expect(() => env.h.manager.attach(MAIN_ID, client)).toThrow(refusal);
    await expect(
      env.h.manager.prompt(MAIN_ID, { sessionId: MAIN_ID, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(refusal);
    await expect(env.h.manager.setMode(MAIN_ID, "fix")).rejects.toThrow(refusal);
    await expect(env.h.manager.cancel(MAIN_ID)).rejects.toThrow(refusal);
    await expect(env.h.manager.close(MAIN_ID)).rejects.toThrow(refusal);
    await expect(env.h.manager.activate(MAIN_ID)).rejects.toThrow(refusal);
    // Nothing moved: still imported, interactive, the same log, no backend.
    expect(env.h.store.get(MAIN_ID)).toMatchObject({ status: "imported", mode: "interactive" });
    expect(env.h.store.replay(MAIN_ID)).toHaveLength(before);
    expect(env.h.backends.has(MAIN_ID)).toBe(false);
  });

  test("Link refuses it as a peer target and as a caller of anything", async () => {
    const env = setup();
    await env.importer.run([env.logs]);
    const sender = await env.h.session(env.repoA);
    const refused = (fn: () => unknown, code: string) => {
      let caught: unknown;
      try {
        fn();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LinkError);
      expect((caught as LinkError).code).toBe(code as LinkError["code"]);
    };
    refused(() => env.h.link.message({ kind: "session", id: sender.id }, MAIN_ID, "status?"), "refused");
    refused(() => env.h.link.message({ kind: "human" }, MAIN_ID, "status?"), "refused");
    expect(env.h.manager.queuedPeerMessages(MAIN_ID)).toEqual([]);
    expect(() =>
      env.h.manager.deliverPeerMessage({ messageId: "m", from: "human", to: MAIN_ID, text: "x", hop: 0 }),
    ).toThrow("imported");

    // As a caller: no mount, so no tool at all.
    const imported = { kind: "session" as const, id: MAIN_ID };
    expect(env.h.link.mountAllowed(env.h.store.get(MAIN_ID))).toBe(false);
    expect(env.h.link.toolsFor(MAIN_ID)).toEqual([]);
    refused(() => env.h.link.list(imported), "forbidden");
    refused(() => env.h.link.search(imported, "scroll"), "forbidden");
    refused(() => env.h.link.read(imported, sender.id), "forbidden");
    refused(() => env.h.link.message(imported, sender.id, "hi"), "forbidden");
    await expect(env.h.link.spawn(imported, { cwd: env.repoA, prompt: "go" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(env.h.link.summarize(imported, sender.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(env.h.link.wait(imported, sender.id, "idle", 10)).rejects.toMatchObject({ code: "forbidden" });
    // A wait on it ends at once: it never changes.
    expect(await env.h.link.wait({ kind: "human" }, MAIN_ID, "idle", 5_000)).toMatchObject({
      reached: false,
      status: "imported",
    });
  });
});

describe("the import watcher", () => {
  test("imports at start, then again after appended lines settle", async () => {
    const env = setup();
    const importer = new Importer({
      store: env.h.store,
      config: { enabled: true, watch: true, roots: [join(env.logs, "claude")] },
      home: env.home,
    });
    const runs: number[] = [];
    const watcher = new ImportWatcher({
      importer,
      debounceMs: 100,
      onRun: (summary) => runs.push(summary.eventsAppended),
    });
    watcher.start();
    try {
      await waitFor(() => runs.length >= 1, "the first run", 5_000);
      expect(env.h.store.get(MAIN_ID)?.status).toBe("imported");
      const before = env.h.store.replay(MAIN_ID).length;
      appendFileSync(
        env.mainLog,
        claudeLine(env, {
          type: "user",
          timestamp: "2026-07-29T18:00:00.000Z",
          message: { role: "user", content: "watched line" },
        }),
      );
      await waitFor(() => env.h.store.replay(MAIN_ID).length === before + 1, "the watched line", 5_000);
      // The run that read it reports exactly that line (its summary lands
      // just after the store does).
      await waitFor(() => runs.includes(1), "the watched run's summary", 5_000);
    } finally {
      watcher.stop();
    }
  });
});
