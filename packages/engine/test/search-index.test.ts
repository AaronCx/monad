import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventKind, SessionRecord } from "@aaroncx/protocol";
import { AGENT_ROW_HARD_LIMIT, AGENT_ROW_SOFT_LIMIT } from "../src/indexer.ts";
import { RepoResolver } from "../src/repos.ts";
import { INDEX_GENERATION, SessionStore } from "../src/store.ts";

/**
 * monad Link phase 1 end to end on a real SQLite file: the FTS5 index fed on
 * append, repo tagging, titles, and the backfill that brings a database
 * written before the index up to date. The brief's three required tests are
 * marked REQUIRED.
 */

let dirs: string[] = [];
let stores: SessionStore[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath: string, home?: string): SessionStore {
  const store = new SessionStore({ dbPath, repoResolver: new RepoResolver({ home }) });
  stores.push(store);
  return store;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: Bun.randomUUIDv7(),
    cwd: "/tmp/not-a-repo",
    backend: "claude-acp",
    mode: "interactive",
    status: "idle",
    trust: "trusted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  git(root, "init", "-q", "-b", "main");
  return root;
}

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});
const chunk = (sessionId: string, text: string, sessionUpdate = "agent_message_chunk") => ({
  sessionId,
  update: { sessionUpdate, content: { type: "text", text } },
});
const tool = (sessionId: string, fields: Record<string, unknown>, sessionUpdate = "tool_call") => ({
  sessionId,
  update: { sessionUpdate, toolCallId: `t${Math.random()}`, ...fields },
});

// Built at runtime from short pieces so the secrets check never flags this file.
const TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

/** Every derived row, in a stable order, for before/after comparisons. */
function derivedSnapshot(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      fts: db
        .query("SELECT session_id, kind, first_seq, last_seq, ts, text FROM search_fts ORDER BY session_id, first_seq, kind, text")
        .all(),
      repos: db.query("SELECT * FROM session_repos ORDER BY session_id, repo_root").all(),
      state: db.query("SELECT session_id, last_indexed_seq, open_bytes FROM index_state ORDER BY session_id").all(),
      titles: db.query("SELECT id, title, title_source FROM sessions ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

/** One scripted turn: prompt, streamed agent text around a tool call, turn end. */
function scriptTurn(store: SessionStore, id: string, repoFile: string) {
  const seqs: Record<string, number> = {};
  seqs.prompt = store.append(id, "prompt", prompt(id, "What broke with meshyy scrolling?")).seq;
  store.append(id, "update", chunk(id, "Let me look.", "agent_thought_chunk"));
  seqs.firstChunk = store.append(id, "update", chunk(id, "The status row ")).seq;
  store.append(id, "update", tool(id, { title: "Read file", kind: "read", locations: [{ path: repoFile }] }));
  store.append(id, "update", chunk(id, "was not clamped; build 72 ")).seq;
  seqs.lastChunk = store.append(id, "update", chunk(id, "clamps it.")).seq;
  seqs.turnEnded = store.append(id, "turn_ended", { stopReason: "end_turn" }).seq;
  return seqs;
}

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  stores = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("FTS5 under bun:sqlite", () => {
  test("this SQLite build has FTS5 with the porter tokenizer", () => {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize = 'porter unicode61')");
    db.query("INSERT INTO t (text) VALUES ('scrolled')").run();
    expect(db.query("SELECT count(*) AS n FROM t WHERE t MATCH '\"scrolling\"'").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("full-text index fed on append", () => {
  test("REQUIRED: an FTS hit resolves to the right seq range", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    const seqs = scriptTurn(store, record.id, "/tmp/nowhere/file.ts");

    const hits = store.search("status row clamped");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.sessionId).toBe(record.id);
    expect(hit.kind).toBe("agent");
    // Coalesced: the first chunk through the last chunk of the turn, across
    // the tool call in between, as one row.
    expect(hit.firstSeq).toBe(seqs.firstChunk!);
    expect(hit.lastSeq).toBe(seqs.lastChunk!);
    expect(hit.snippet).toContain("«status»");

    // The range replays to exactly the text that matched.
    const span = store
      .replay(record.id, hit.firstSeq)
      .filter((event) => event.seq <= hit.lastSeq && event.kind === "update")
      .map((event) => (event.payload as ReturnType<typeof chunk>).update)
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content.text)
      .join("");
    expect(span).toBe("The status row was not clamped; build 72 clamps it.");

    // The prompt is its own row at its own seq; thoughts are not indexed.
    expect(store.search("meshyy").map((h) => [h.kind, h.firstSeq, h.lastSeq])).toEqual([
      ["prompt", seqs.prompt!, seqs.prompt!],
    ]);
    expect(store.search("look")).toEqual([]);
  });

  test("a new turn starts a new agent row", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    scriptTurn(store, record.id, "/tmp/x");
    store.append(record.id, "prompt", prompt(record.id, "and the other one?"));
    const second = store.append(record.id, "update", chunk(record.id, "The status row is fine now.")).seq;
    const hits = store.search('"status row"', { kinds: ["agent"] });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.firstSeq)).toContain(second);
  });

  test("tool titles and paths are searchable, errors too", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    const toolSeq = store.append(
      record.id,
      "update",
      tool(record.id, { title: "Edit TerminalView.swift", locations: [{ path: "/src/TerminalView.swift" }] }),
    ).seq;
    const errorSeq = store.append(record.id, "error", { message: "vendor session/load failed" }).seq;
    expect(store.search("TerminalView").map((h) => [h.kind, h.firstSeq])).toEqual([["tool", toolSeq]]);
    expect(store.search("session/load").map((h) => [h.kind, h.firstSeq])).toEqual([["error", errorSeq]]);
  });

  test("a long agent turn splits into rows of about 8 KiB with contiguous seq ranges", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, "go"));
    const word = "lorem ipsum dolor sit amet ";
    for (let written = 0; written < AGENT_ROW_SOFT_LIMIT * 2.5; written += word.length) {
      store.append(record.id, "update", chunk(record.id, word));
    }
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });
    const rows = store.search("lorem", { kinds: ["agent"], limit: 50 }).sort((a, b) => a.firstSeq - b.firstSeq);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.firstSeq).toBe(rows[0]!.lastSeq + 1);
    expect(rows[2]!.firstSeq).toBe(rows[1]!.lastSeq + 1);
  });

  test("redaction keeps a planted ghp_ token out of the index, even split across chunks", () => {
    const dir = tempDir("monad-fts-");
    const dbPath = join(dir, "monad.db");
    const store = openStore(dbPath);
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, `push with ${TOKEN} please`));
    store.append(record.id, "update", chunk(record.id, `I will use ${TOKEN.slice(0, 18)}`));
    store.append(record.id, "update", chunk(record.id, `${TOKEN.slice(18)} to push.`));
    store.append(record.id, "update", tool(record.id, { title: `git push https://x:${TOKEN}@github.com/o/r` }));
    store.append(record.id, "error", { message: `auth failed for ${TOKEN}` });
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });

    const db = new Database(dbPath, { readonly: true });
    const texts = db.query<{ text: string }, []>("SELECT text FROM search_fts").all().map((r) => r.text);
    const title = db.query<{ title: string }, []>("SELECT title FROM sessions").get()?.title;
    db.close();
    expect(texts.length).toBe(4);
    for (const text of [...texts, title ?? ""]) {
      expect(text).not.toContain(TOKEN.slice(4, 16));
      expect(text).not.toContain(TOKEN.slice(18, 30));
    }
    expect(texts.join("\n")).toContain("[REDACTED:github-personal-access-token]");
    // Nor can it be found by searching for it.
    expect(store.search(TOKEN)).toEqual([]);
    expect(store.search(TOKEN.slice(0, 12))).toEqual([]);
  });

  /** Every search_fts text of the database, read straight from the file. */
  function ftsTexts(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query<{ text: string }, []>("SELECT text FROM search_fts").all().map((row) => row.text);
    } finally {
      db.close();
    }
  }

  /** Fails if any text holds 8 or more consecutive characters of `secret`. */
  function expectNoFragment(texts: string[], secret: string): void {
    for (const text of texts) {
      for (let start = 0; start + 8 <= secret.length; start += 1) {
        expect(text).not.toContain(secret.slice(start, start + 8));
      }
    }
  }

  /**
   * Realistic deltas: words with the space INSIDE the chunk, so no chunk
   * starts or ends in whitespace and the soft limit never splits the row.
   */
  function streamWithoutEdgeWhitespace(store: SessionStore, id: string, total: number): void {
    for (let written = 0; written < total; written += 12) {
      store.append(id, "update", chunk(id, "status, row,"));
    }
  }

  test("a token cut where a long turn splits at the hard cap is in no row", () => {
    const dir = tempDir("monad-fts-");
    const dbPath = join(dir, "monad.db");
    const store = openStore(dbPath);
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, "go"));
    // Just under the hard cap, so the token's head carries the row past it.
    streamWithoutEdgeWhitespace(store, record.id, AGENT_ROW_HARD_LIMIT - 24);
    store.append(record.id, "update", chunk(record.id, `then the token ${TOKEN.slice(0, 18)}`));
    store.append(record.id, "update", chunk(record.id, `${TOKEN.slice(18)} was used.`));
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });

    const texts = ftsTexts(dbPath);
    expect(texts).toHaveLength(3);
    expectNoFragment(texts, TOKEN.slice(4));
    expect(store.search(TOKEN.slice(0, 22))).toEqual([]);
    expect(store.search(TOKEN.slice(18))).toEqual([]);
    expect(texts.filter((text) => text.includes("[REDACTED:github-personal-access-token]"))).toHaveLength(2);
    // Rows still split only between chunks: contiguous seq ranges.
    const before = store.search("status", { kinds: ["agent"] });
    const after = store.search("used", { kinds: ["agent"] });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.firstSeq).toBe(before[0]!.lastSeq + 1);
  });

  test("an assignment cut where a long turn splits at the soft limit is in no row", () => {
    const dir = tempDir("monad-fts-");
    const dbPath = join(dir, "monad.db");
    const store = openStore(dbPath);
    const record = store.create(makeRecord());
    const value = ["wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join("");
    store.append(record.id, "prompt", prompt(record.id, "go"));
    streamWithoutEdgeWhitespace(store, record.id, AGENT_ROW_SOFT_LIMIT);
    // Ends in whitespace past 8 KiB: the next chunk starts a new row.
    store.append(record.id, "update", chunk(record.id, "export aws_secret_access_key = "));
    store.append(record.id, "update", chunk(record.id, `${value} and done.`));
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });

    const texts = ftsTexts(dbPath);
    expect(texts).toHaveLength(3);
    expectNoFragment(texts, value);
    expect(store.search("bPxRfiCYEXAMPLEKEY")).toEqual([]);
  });

  test("a row still settling after a split survives a restart", () => {
    const dir = tempDir("monad-fts-");
    const dbPath = join(dir, "monad.db");
    const first = openStore(dbPath);
    const record = first.create(makeRecord());
    first.append(record.id, "prompt", prompt(record.id, "go"));
    streamWithoutEdgeWhitespace(first, record.id, AGENT_ROW_HARD_LIMIT - 24);
    first.append(record.id, "update", chunk(record.id, `then the token ${TOKEN.slice(0, 18)}`));
    // This chunk splits the row off; the token is still incomplete (and too
    // short for even the entropy pass to catch).
    first.append(record.id, "update", chunk(record.id, TOKEN.slice(18, 22)));
    first.close();

    // The rest of the token arrives after a restart. The split-off row must
    // still be rewritten with it, or it keeps the token's head.
    const second = openStore(dbPath);
    second.append(record.id, "update", chunk(record.id, `${TOKEN.slice(22)} was used.`));
    second.append(record.id, "turn_ended", { stopReason: "end_turn" });
    const texts = ftsTexts(dbPath);
    expect(texts).toHaveLength(3);
    expectNoFragment(texts, TOKEN.slice(4));
    expect(second.search(TOKEN.slice(0, 22))).toEqual([]);
  });

  test("an open agent row survives a restart: the next chunk extends it, redaction intact", () => {
    const dir = tempDir("monad-fts-");
    const dbPath = join(dir, "monad.db");
    const first = openStore(dbPath);
    const record = first.create(makeRecord());
    first.append(record.id, "prompt", prompt(record.id, "go"));
    const opened = first.append(record.id, "update", chunk(record.id, `streaming ${TOKEN.slice(0, 18)}`)).seq;
    first.close();

    const second = openStore(dbPath);
    const last = second.append(record.id, "update", chunk(record.id, `${TOKEN.slice(18)} done`)).seq;
    const hits = second.search("streaming");
    expect(hits.map((h) => [h.firstSeq, h.lastSeq])).toEqual([[opened, last]]);
    expect(hits[0]!.snippet).toContain("[REDACTED:github-personal-access-token]");
    expect(hits[0]!.snippet).not.toContain(TOKEN.slice(18));
  });

  test("hostile query text is searched literally and never errors", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, 'say "hello" OR NEAR the café (日本) - done'));
    for (const query of ['"hello', 'he"llo', "*", "-", "NEAR(", "OR", "a OR", "(", ")", "^", "col:x", "\0", '""']) {
      expect(() => store.search(query)).not.toThrow();
    }
    expect(store.search("café")).toHaveLength(1);
    expect(store.search("日本")).toHaveLength(1);
    expect(store.search('"hello"')).toHaveLength(1);
    expect(store.search("OR NEAR")).toHaveLength(1);
    expect(store.search("(日本)")).toHaveLength(1);
    expect(store.search("-done")).toHaveLength(1);
    // Prefix on the last bare term: search as you type.
    expect(store.search("caf")).toHaveLength(1);
  });

  test("fuzzed queries, lone surrogates included, never throw", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, 'say "hello" OR NEAR the café (日本) - done x'));
    // A lone surrogate swallowed the closing quote: this was a SQLiteError.
    expect(store.search("x\ud800")).toHaveLength(1);
    expect(store.search("abc\udc00")).toEqual([]);
    const pieces = ['"', "*", "-", "(", ")", ":", "^", "+", "NEAR", "OR", "AND", "NOT", " ", "x", "é", "日",
      "\ud800", "\udbff", "\udc00", "\udfff", "\u{1F600}", "\0", "\n", "{", "}", ",", "'"];
    // A fixed linear congruential sequence: deterministic, so a failure
    // reproduces.
    let state = 12345;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state;
    };
    for (let i = 0; i < 3000; i += 1) {
      let query = "";
      const length = 1 + (next() % 8);
      for (let j = 0; j < length; j += 1) {
        query += pieces[next() % pieces.length];
      }
      expect(() => store.search(query)).not.toThrow();
    }
  });

  test("filters: repo, since, kinds, session ids, excluded session ids, limit", () => {
    const parent = tempDir("monad-filters-");
    const repo = makeRepo(parent, "alpha");
    const store = openStore(join(parent, "monad.db"));
    const inRepo = store.create(makeRecord({ cwd: repo }));
    const elsewhere = store.create(makeRecord());
    store.append(inRepo.id, "session_created", inRepo);
    store.append(inRepo.id, "prompt", prompt(inRepo.id, "scroll bug"));
    store.append(elsewhere.id, "prompt", prompt(elsewhere.id, "scroll bug too"));
    expect(store.search("scroll")).toHaveLength(2);
    expect(store.search("scroll", { repo }).map((h) => h.sessionId)).toEqual([inRepo.id]);
    expect(store.search("scroll", { sessionIds: [elsewhere.id] }).map((h) => h.sessionId)).toEqual([elsewhere.id]);
    expect(store.search("scroll", { sessionIds: [] })).toEqual([]);
    // An exclusion applies before the limit: the excluded hit never crowds out another.
    expect(store.search("scroll", { excludeSessionIds: [inRepo.id], limit: 1 }).map((h) => h.sessionId)).toEqual([
      elsewhere.id,
    ]);
    expect(store.search("scroll", { excludeSessionIds: [] })).toHaveLength(2);
    expect(store.search("scroll", { kinds: ["agent"] })).toEqual([]);
    expect(store.search("scroll", { since: "2999-01-01T00:00:00.000Z" })).toEqual([]);
    expect(store.search("scroll", { limit: 1 })).toHaveLength(1);
  });

  test("maxPerSession keeps one session's many short rows from crowding out the others", () => {
    // Measured live (acceptance run 1): short tool rows (the same file path
    // edited over and over) outrank a long discussion under bm25, so one busy
    // session filled every hit slot and the session that did the work was
    // not returned at all.
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const busy = store.create(makeRecord());
    const worker = store.create(makeRecord());
    for (let i = 0; i < 12; i += 1) {
      store.append(
        busy.id,
        "update",
        tool(busy.id, { title: "Edit ScrollBelief.swift", locations: [{ path: "/meshyy/ScrollBelief.swift" }] }),
      );
    }
    store.append(
      worker.id,
      "prompt",
      prompt(
        worker.id,
        "the meshyy scroll bar goes yellow and says no previous window; the wheel lands on the tmux status row " +
          "after a reconnect, and the alt screen belief is lost too, so look at how meshyy routes the swipe",
      ),
    );
    const uncapped = store.search("meshyy scroll", { limit: 10 });
    expect(new Set(uncapped.map((h) => h.sessionId))).toEqual(new Set([busy.id]));
    const capped = store.search("meshyy scroll", { limit: 10, maxPerSession: 3 });
    expect(capped.filter((h) => h.sessionId === busy.id)).toHaveLength(3);
    expect(capped.map((h) => h.sessionId)).toContain(worker.id);
    // Best ranked first within the cap, and the limit still applies after it.
    expect(store.search("meshyy scroll", { limit: 2, maxPerSession: 3 })).toHaveLength(2);
    expect(store.search("meshyy scroll", { maxPerSession: Number.NaN })).toHaveLength(13);
    expect(store.search("meshyy scroll", { limit: 20, maxPerSession: 0 })).toHaveLength(2);
  });

  test("a non-finite or out-of-range limit falls back or clamps instead of throwing", () => {
    const dir = tempDir("monad-fts-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    for (let i = 0; i < 25; i += 1) {
      store.append(record.id, "prompt", prompt(record.id, `pipeline run ${i}`));
    }
    expect(store.search("pipeline", { limit: Number.NaN })).toHaveLength(20);
    expect(store.search("pipeline", { limit: Number("abc") })).toHaveLength(20);
    expect(store.search("pipeline", { limit: Number.POSITIVE_INFINITY })).toHaveLength(20);
    expect(store.search("pipeline", { limit: 0 })).toHaveLength(1);
    expect(store.search("pipeline", { limit: -5 })).toHaveLength(1);
    expect(store.search("pipeline", { limit: 2.9 })).toHaveLength(2);
    expect(store.search("pipeline", { limit: 10_000 })).toHaveLength(25);
  });
});

describe("repos touched", () => {
  test("REQUIRED: a session started in ~ that edits files in two repos is tagged with both, not with ~", () => {
    const home = tempDir("monad-home-");
    const meshyy = makeRepo(join(home, "Developer"), "meshyy");
    const monad = makeRepo(join(home, "Developer"), "monad");
    const store = openStore(join(home, "monad.db"), home);
    const record = store.create(makeRecord({ cwd: home }));
    const created = store.append(record.id, "session_created", record).seq;
    store.append(record.id, "prompt", prompt(record.id, "fix both"));
    // An ACP edit with a diff in meshyy (absolute path).
    const firstEdit = store.append(
      record.id,
      "update",
      tool(record.id, {
        title: "Edit TerminalView.swift",
        kind: "edit",
        content: [{ type: "diff", path: join(meshyy, "src", "TerminalView.swift"), oldText: "a", newText: "b" }],
        locations: [{ path: join(meshyy, "src", "TerminalView.swift") }],
      }),
    ).seq;
    // A shell command that cds into monad via ~.
    const shell = store.append(
      record.id,
      "update",
      tool(record.id, { title: "bun test", kind: "execute", rawInput: { command: "cd ~/Developer/monad && bun test" } }),
    ).seq;
    // A relative read resolved against the cwd (home): ~/Developer/monad/src/main.ts.
    const lastEdit = store.append(
      record.id,
      "update",
      tool(record.id, { title: "Read", kind: "read", rawInput: { file_path: "Developer/meshyy/src/main.ts" } }, "tool_call_update"),
    ).seq;

    const repos = store.reposFor(record.id);
    expect(repos.map((r) => r.repoRoot).sort()).toEqual([meshyy, monad].sort());
    expect(repos.find((r) => r.repoRoot === meshyy)).toEqual({ repoRoot: meshyy, firstSeq: firstEdit, lastSeq: lastEdit });
    expect(repos.find((r) => r.repoRoot === monad)).toEqual({ repoRoot: monad, firstSeq: shell, lastSeq: shell });
    // The cwd was ~, which is not a repo: session_created recorded nothing.
    expect(repos.some((r) => r.repoRoot === home)).toBe(false);
    expect(repos.every((r) => r.firstSeq > created)).toBe(true);
    expect(store.sessionsForRepo(meshyy)).toEqual([record.id]);
    expect(store.sessionsForRepo(home)).toEqual([]);
  });

  test("a cwd that is a repo is recorded at session_created", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const store = openStore(join(parent, "monad.db"));
    const record = store.create(makeRecord({ cwd: join(repo, "src") }));
    const created = store.append(record.id, "session_created", record).seq;
    expect(store.reposFor(record.id)).toEqual([{ repoRoot: repo, firstSeq: created, lastSeq: created }]);
  });

  test("prompts and agent prose that mention a repo do not tag it", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const store = openStore(join(parent, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, `look at ${repo}/src/main.ts`));
    store.append(record.id, "update", chunk(record.id, `${repo} is a repo`));
    expect(store.reposFor(record.id)).toEqual([]);
  });

  test("a project scaffolded before its git init is tagged from the init on", () => {
    const parent = tempDir("monad-repos-");
    const proj = join(parent, "proj");
    mkdirSync(proj, { recursive: true });
    const store = openStore(join(parent, "monad.db"));
    const record = store.create(makeRecord({ cwd: parent }));
    const edit = (path: string) =>
      store.append(record.id, "update", tool(record.id, { title: "Write", kind: "edit", locations: [{ path }] })).seq;
    edit(join(proj, "package.json"));
    expect(store.reposFor(record.id)).toEqual([]);
    git(proj, "init", "-q", "-b", "main");
    const tagged = edit(join(proj, "src", "index.ts"));
    expect(store.reposFor(record.id)).toEqual([{ repoRoot: proj, firstSeq: tagged, lastSeq: tagged }]);
    // Another session in the same daemon resolves it too.
    const other = store.create(makeRecord());
    store.append(other.id, "update", tool(other.id, { title: "Read", locations: [{ path: join(proj, "package.json") }] }));
    expect(store.sessionsForRepo(proj).sort()).toEqual([record.id, other.id].sort());
  });

  test("two sessions that spell one repo two ways are tagged with the same root", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const links = tempDir("monad-links-");
    const link = join(links, "parent-link");
    symlinkSync(parent, link);
    const store = openStore(join(parent, "monad.db"));
    const direct = store.create(makeRecord());
    const viaLink = store.create(makeRecord());
    store.append(direct.id, "update", tool(direct.id, { title: "Edit", locations: [{ path: join(repo, "src", "main.ts") }] }));
    store.append(
      viaLink.id,
      "update",
      tool(viaLink.id, { title: "Edit", locations: [{ path: join(link, "alpha", "src", "main.ts") }] }),
    );
    expect(store.reposFor(viaLink.id).map((r) => r.repoRoot)).toEqual([repo]);
    expect(store.sessionsForRepo(repo).sort()).toEqual([direct.id, viaLink.id].sort());
    store.append(viaLink.id, "prompt", prompt(viaLink.id, "symlinked scroll"));
    expect(store.search("symlinked", { repo }).map((h) => h.sessionId)).toEqual([viaLink.id]);
  });

  test("sessionsForRepo lists the most recently touching session first", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const store = openStore(join(parent, "monad.db"));
    const older = store.create(makeRecord());
    const newer = store.create(makeRecord());
    const touch = (id: string) =>
      store.append(id, "update", tool(id, { title: "Read", locations: [{ path: join(repo, "src", "main.ts") }] }));
    touch(older.id);
    touch(newer.id);
    expect(store.sessionsForRepo(repo)).toEqual([newer.id, older.id]);
    touch(older.id);
    expect(store.sessionsForRepo(repo)).toEqual([older.id, newer.id]);
  });
});

describe("titles", () => {
  test("the first prompt names the session, later prompts do not rename it", () => {
    const dir = tempDir("monad-titles-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, "\n  Fix the scroll clamp  \nwith details"));
    store.append(record.id, "prompt", prompt(record.id, "something else"));
    expect(store.get(record.id)).toMatchObject({ title: "Fix the scroll clamp", titleSource: "prompt" });
  });

  test("a manual title is never overwritten, and reset re-derives from the first prompt", () => {
    const dir = tempDir("monad-titles-");
    const dbPath = join(dir, "monad.db");
    const store = openStore(dbPath);
    const record = store.create(makeRecord());
    store.setTitle(record.id, "my name", "manual");
    store.append(record.id, "prompt", prompt(record.id, "first ask"));
    expect(store.get(record.id)).toMatchObject({ title: "my name", titleSource: "manual" });

    // Not even by a backfill from scratch.
    const db = new Database(dbPath);
    db.exec("DELETE FROM index_state; DELETE FROM search_fts; DELETE FROM session_repos;");
    db.close();
    store.backfillIndex();
    expect(store.get(record.id)?.title).toBe("my name");

    store.resetTitle(record.id);
    expect(store.get(record.id)).toMatchObject({ title: "first ask", titleSource: "prompt" });
  });

  test("setting a title does not count as activity", () => {
    const dir = tempDir("monad-titles-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    store.setTitle(record.id, "renamed", "manual");
    expect(store.get(record.id)?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(() => store.setTitle(Bun.randomUUIDv7(), "x", "manual")).toThrow(/unknown session/);
  });
});

/**
 * The M2 schema exactly as a pre-Link monadd left it: no title columns, no
 * index tables, user_version 0.
 */
function writePreLinkDatabase(dbPath: string, sessions: Array<{ id: string; cwd: string; events: Array<[EventKind, unknown]> }>) {
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, backend TEXT NOT NULL, agent_session_id TEXT,
      mode TEXT NOT NULL, status TEXT NOT NULL, trust TEXT, base TEXT, head TEXT, pr TEXT,
      exec_allowlist TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  for (const session of sessions) {
    db.query(
      `INSERT INTO sessions (id, cwd, backend, mode, status, trust, created_at, updated_at)
       VALUES ($id, $cwd, 'claude-acp', 'interactive', 'idle', 'trusted', $now, $now)`,
    ).run({ id: session.id, cwd: session.cwd, now });
    for (const [kind, payload] of session.events) {
      db.query("INSERT INTO events (session_id, ts, kind, payload) VALUES ($id, $now, $kind, $payload)").run({
        id: session.id,
        now,
        kind,
        payload: JSON.stringify(payload),
      });
    }
  }
  db.close();
}

describe("backfill", () => {
  function preLinkFixture(home: string) {
    const meshyy = makeRepo(join(home, "Developer"), "meshyy");
    const a = Bun.randomUUIDv7();
    const b = Bun.randomUUIDv7();
    const events = (id: string): Array<[EventKind, unknown]> => [
      ["session_created", { id, cwd: home }],
      ["prompt", prompt(id, "what broke with meshyy scrolling?")],
      ["update", chunk(id, "Four reports; ")],
      ["update", tool(id, { title: "Edit", locations: [{ path: join(meshyy, "src", "main.ts") }] })],
      ["update", chunk(id, "the status-row clamp landed in build 72.")],
      ["turn_ended", { stopReason: "end_turn" }],
      ["prompt", prompt(id, "and what is left?")],
      ["update", chunk(id, "Two deferred divergences.")],
    ];
    writePreLinkDatabase(join(home, "monad.db"), [
      { id: a, cwd: home, events: events(a) },
      { id: b, cwd: home, events: events(b) },
    ]);
    return { meshyy, a, b };
  }

  test("REQUIRED: backfill indexes a pre-Link database and is idempotent", () => {
    const home = tempDir("monad-backfill-");
    const dbPath = join(home, "monad.db");
    const { meshyy, a, b } = preLinkFixture(home);

    const store = openStore(dbPath, home);
    expect(store.search("clamp").map((h) => h.sessionId).sort()).toEqual([a, b].sort());
    expect(store.reposFor(a).map((r) => r.repoRoot)).toEqual([meshyy]);
    expect(store.get(a)?.title).toBe("what broke with meshyy scrolling?");
    const once = derivedSnapshot(dbPath);

    // Running it again (explicitly, and by reopening) changes nothing.
    expect(store.backfillIndex()).toBe(0);
    store.close();
    const reopened = openStore(dbPath, home);
    expect(reopened.backfillIndex()).toBe(0);
    expect(derivedSnapshot(dbPath)).toEqual(once);

    // The open agent row left by the unfinished second turn keeps extending.
    const next = reopened.append(a, "update", chunk(a, " Both are tracked."));
    const hit = reopened.search("tracked", { sessionIds: [a] })[0];
    expect(hit?.lastSeq).toBe(next.seq);
    expect(reopened.search("deferred", { sessionIds: [a] })[0]?.firstSeq).toBe(hit?.firstSeq);
  });

  test("backfill produces exactly what live indexing produced", () => {
    const home = tempDir("monad-backfill-");
    const dbPath = join(home, "monad.db");
    const repo = makeRepo(home, "alpha");
    const store = openStore(dbPath, home);
    const record = store.create(makeRecord({ cwd: repo }));
    store.append(record.id, "session_created", record);
    scriptTurn(store, record.id, join(repo, "src", "main.ts"));
    store.append(record.id, "prompt", prompt(record.id, "again"));
    store.append(record.id, "update", chunk(record.id, `open row with ${TOKEN.slice(0, 18)}`));
    store.append(record.id, "update", chunk(record.id, `${TOKEN.slice(18)} split`));
    const live = derivedSnapshot(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.exec("DELETE FROM search_fts; DELETE FROM session_repos; DELETE FROM index_state;");
    db.close();
    openStore(dbPath, home);
    expect(derivedSnapshot(dbPath)).toEqual(live);
  });

  test("a database from an older index generation is rebuilt from the log", () => {
    const home = tempDir("monad-backfill-");
    const dbPath = join(home, "monad.db");
    const store = openStore(dbPath, home);
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, "rebuild me"));
    store.close();

    // Simulate stale derived rows from a previous generation.
    const db = new Database(dbPath);
    db.query(
      "INSERT INTO search_fts (text, session_id, kind, first_seq, last_seq, ts) VALUES ('stale row', $id, 'agent', 1, 1, 'x')",
    ).run({ id: record.id });
    db.exec(`PRAGMA user_version = ${INDEX_GENERATION - 1};`);
    db.close();

    const reopened = openStore(dbPath, home);
    expect(reopened.search("stale")).toEqual([]);
    expect(reopened.search("rebuild")).toHaveLength(1);
    const check = new Database(dbPath, { readonly: true });
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: INDEX_GENERATION });
    check.close();
  });

  test("a generation 1 database gets the new index_state columns and loses its old rows", () => {
    const home = tempDir("monad-backfill-");
    const dbPath = join(home, "monad.db");
    const store = openStore(dbPath, home);
    const record = store.create(makeRecord());
    store.append(record.id, "prompt", prompt(record.id, "rebuild me"));
    store.close();

    // Generation 1's index_state had no settling_rowid, and its rows may hold
    // part of a token.
    const db = new Database(dbPath);
    db.exec(`
      DROP TABLE index_state;
      CREATE TABLE index_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id),
        last_indexed_seq INTEGER NOT NULL DEFAULT 0,
        open_rowid INTEGER,
        open_bytes INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 1;
    `);
    db.query(
      "INSERT INTO search_fts (text, session_id, kind, first_seq, last_seq, ts) VALUES ('leaked fragment', $id, 'agent', 1, 1, 'x')",
    ).run({ id: record.id });
    db.close();

    const reopened = openStore(dbPath, home);
    expect(reopened.search("leaked")).toEqual([]);
    reopened.append(record.id, "update", chunk(record.id, "still indexing"));
    expect(reopened.search("indexing")).toHaveLength(1);
  });
});

describe("handoffs and summaries (Link phase 3)", () => {
  test("both are indexed under their own kinds, redacted, and leave an open agent row open", () => {
    const dir = tempDir("monad-handoff-index-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    const first = store.append(record.id, "update", chunk(record.id, "streaming the walrus "));
    // A summary can land mid-turn (another session asked for it); it must
    // not split the turn's agent text into two rows.
    const summary = store.append(record.id, "summary", {
      text: `Summary: the walrus migration is half done; token ${TOKEN}`,
      summarizerSessionId: Bun.randomUUIDv7(),
      fromSeq: first.seq,
      toSeq: first.seq,
    });
    const last = store.append(record.id, "update", chunk(record.id, "answer continues"));
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });
    const handoff = store.append(record.id, "handoff", {
      reason: "idle",
      text: "idle: asked about the walrus migration\n\n## Last asks\n- walrus",
    });

    const agent = store.search("walrus", { kinds: ["agent"] });
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({ firstSeq: first.seq, lastSeq: last.seq });
    const handoffs = store.search("walrus", { kinds: ["handoff"] });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ kind: "handoff", firstSeq: handoff.seq, lastSeq: handoff.seq });
    const summaries = store.search("walrus migration", { kinds: ["summary"] });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ kind: "summary", firstSeq: summary.seq });
    expect(summaries[0]!.snippet).not.toContain(TOKEN);
    expect(store.search(TOKEN)).toEqual([]);
  });
});

describe("session ordering", () => {
  test("list orders by created_at then id, so imported v4 ids sort by time", () => {
    const dir = tempDir("monad-order-");
    const store = openStore(join(dir, "monad.db"));
    const later = store.create(
      makeRecord({ id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-02-01T00:00:00.000Z" }),
    );
    const earlier = store.create(
      makeRecord({ id: "ffffffff-ffff-4fff-bfff-ffffffffffff", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(store.list().map((r) => r.id)).toEqual([earlier.id, later.id]);
  });

  test("lastEventOfKind returns the newest event of that kind", () => {
    const dir = tempDir("monad-order-");
    const store = openStore(join(dir, "monad.db"));
    const record = store.create(makeRecord());
    store.append(record.id, "turn_ended", { stopReason: "end_turn" });
    const newest = store.append(record.id, "turn_ended", { stopReason: "cancelled" });
    expect(store.lastEventOfKind(record.id, "turn_ended")).toEqual(newest);
    expect(store.lastEventOfKind(record.id, "error")).toBeUndefined();
  });
});
