import { describe, expect, test } from "bun:test";
import type { EventKind, EventRecord } from "@aaroncx/protocol";
import {
  AGENT_ROW_HARD_LIMIT,
  AGENT_ROW_SOFT_LIMIT,
  deriveTitle,
  type IndexOp,
  type OpenAgentRow,
  planIndex,
  toFtsQuery,
} from "../src/indexer.ts";

/**
 * The index planner on plain values: what one event turns into, with no
 * SQLite involved. The store-level tests (search-index.test.ts) prove the
 * same rules end to end.
 */

const SESSION = Bun.randomUUIDv7();
let nextSeq = 1;

function event(kind: EventKind, payload: unknown, seq = nextSeq++): EventRecord {
  return { seq, sessionId: SESSION, ts: new Date().toISOString(), kind, payload };
}

function prompt(...texts: string[]): unknown {
  return { sessionId: SESSION, prompt: texts.map((text) => ({ type: "text", text })) };
}

function chunk(text: string, sessionUpdate = "agent_message_chunk"): unknown {
  return { sessionId: SESSION, update: { sessionUpdate, content: { type: "text", text } } };
}

function toolCall(fields: Record<string, unknown>, sessionUpdate = "tool_call"): unknown {
  return { sessionId: SESSION, update: { sessionUpdate, toolCallId: "t1", ...fields } };
}

function opTypes(ops: IndexOp[]): string[] {
  return ops.map((op) => op.type);
}

// Built at runtime from short pieces so the secrets check never flags this file.
const TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

describe("planIndex: agent text", () => {
  test("the first chunk opens a row, later chunks extend it with the whole text", () => {
    const first = planIndex(event("update", chunk("The scroll ")), { titled: true });
    expect(first.ops).toEqual([
      expect.objectContaining({ type: "open", text: "The scroll ", raw: "The scroll " }),
    ]);
    const open: OpenAgentRow = { rowid: 1, firstSeq: 1, raw: "The scroll " };
    const second = planIndex(event("update", chunk("clamp is fixed.")), { open, titled: true });
    expect(second.ops).toEqual([
      expect.objectContaining({ type: "extend", text: "The scroll clamp is fixed." }),
    ]);
  });

  test("thought chunks and empty chunks are not indexed", () => {
    expect(planIndex(event("update", chunk("thinking", "agent_thought_chunk")), { titled: true }).ops).toEqual([]);
    expect(planIndex(event("update", chunk("")), { titled: true }).ops).toEqual([]);
  });

  test("prompt, turn_ended, error and closed close the open row; a tool call does not", () => {
    const open: OpenAgentRow = { rowid: 7, firstSeq: 1, raw: "text" };
    expect(opTypes(planIndex(event("turn_ended", { stopReason: "end_turn" }), { open, titled: true }).ops)).toEqual(["close"]);
    expect(opTypes(planIndex(event("closed", null), { open, titled: true }).ops)).toEqual(["close"]);
    expect(opTypes(planIndex(event("error", { message: "boom" }), { open, titled: true }).ops)).toEqual(["close", "insert"]);
    expect(opTypes(planIndex(event("prompt", prompt("next")), { open, titled: true }).ops)).toEqual(["close", "insert"]);
    expect(opTypes(planIndex(event("update", toolCall({ title: "Read file" })), { open, titled: true }).ops)).toEqual(["insert"]);
  });

  test("a row past 8 KiB closes on a chunk ending in whitespace, not mid-word", () => {
    const open: OpenAgentRow = { rowid: 1, firstSeq: 1, raw: "a".repeat(AGENT_ROW_SOFT_LIMIT) };
    expect(opTypes(planIndex(event("update", chunk("word")), { open, titled: true }).ops)).toEqual(["extend"]);
    expect(opTypes(planIndex(event("update", chunk("word ")), { open, titled: true }).ops)).toEqual(["extend", "close"]);
  });

  test("a row closes at the hard cap even mid-word", () => {
    const open: OpenAgentRow = { rowid: 1, firstSeq: 1, raw: "a".repeat(AGENT_ROW_HARD_LIMIT - 1) };
    expect(opTypes(planIndex(event("update", chunk("bc")), { open, titled: true }).ops)).toEqual(["extend", "close"]);
  });

  test("a token streamed across two chunks is redacted in the accumulated row", () => {
    const head = TOKEN.slice(0, 20);
    const tail = TOKEN.slice(20);
    const first = planIndex(event("update", chunk(`token is ${head}`)), { titled: true });
    const opened = first.ops[0] as Extract<IndexOp, { type: "open" }>;
    const open: OpenAgentRow = { rowid: 1, firstSeq: 1, raw: opened.raw };
    const second = planIndex(event("update", chunk(`${tail} done`)), { open, titled: true });
    const extended = second.ops[0] as Extract<IndexOp, { type: "extend" }>;
    expect(extended.text).toBe("token is [REDACTED:github-personal-access-token] done");
    expect(extended.text).not.toContain(tail);
  });
});

describe("planIndex: prompts, tools, errors", () => {
  test("a prompt indexes all its text blocks, redacted", () => {
    const plan = planIndex(event("prompt", prompt("fix scrolling", `use ${TOKEN}`)), { titled: true });
    expect(plan.ops).toEqual([
      expect.objectContaining({
        type: "insert",
        kind: "prompt",
        text: "fix scrolling\nuse [REDACTED:github-personal-access-token]",
      }),
    ]);
  });

  test("a tool call indexes its title and every path, never its output", () => {
    const plan = planIndex(
      event(
        "update",
        toolCall({
          title: "Edit store.ts",
          locations: [{ path: "/repo/a/store.ts" }],
          content: [
            { type: "diff", path: "/repo/a/store.ts", oldText: "SECRET OUTPUT", newText: "x" },
            { type: "content", content: { type: "text", text: "tool output text" } },
          ],
          rawInput: { file_path: "/repo/a/store.ts", command: "cd ~/Developer/x && ls /etc" },
        }),
      ),
      { titled: true },
    );
    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0] as Extract<IndexOp, { type: "insert" }>;
    expect(op.kind).toBe("tool");
    expect(op.text).toBe("Edit store.ts\n/repo/a/store.ts\n~/Developer/x\n/etc");
    expect(op.text).not.toContain("SECRET OUTPUT");
    expect(op.text).not.toContain("tool output text");
  });

  test("a status-only tool_call_update is not indexed", () => {
    expect(
      planIndex(event("update", toolCall({ status: "completed" }, "tool_call_update")), { titled: true }).ops,
    ).toEqual([]);
  });

  test("an error indexes its message", () => {
    const plan = planIndex(event("error", { message: "vendor session/load failed" }), { titled: true });
    expect(plan.ops).toEqual([
      expect.objectContaining({ type: "insert", kind: "error", text: "vendor session/load failed" }),
    ]);
  });

  test("session_created, permission events and other updates index nothing", () => {
    expect(planIndex(event("session_created", { cwd: "/x" }), { titled: true }).ops).toEqual([]);
    expect(planIndex(event("permission_requested", { toolCall: { title: "x" } }), { titled: true }).ops).toEqual([]);
    expect(
      planIndex(event("update", { update: { sessionUpdate: "usage_update", used: 1 } }), { titled: true }).ops,
    ).toEqual([]);
  });
});

describe("titles", () => {
  test("an untitled session takes its title from the first prompt, a titled one does not", () => {
    expect(planIndex(event("prompt", prompt("Fix the scroll clamp\nmore detail")), { titled: false }).title).toBe(
      "Fix the scroll clamp",
    );
    expect(planIndex(event("prompt", prompt("Fix it")), { titled: true }).title).toBeUndefined();
  });

  test("first non-empty line, whitespace collapsed, at most 80 characters, nothing appended", () => {
    expect(deriveTitle(prompt("\n\n   what   broke\twith  meshyy?  \nrest"))).toBe("what broke with meshyy?");
    const long = "x".repeat(200);
    expect(deriveTitle(prompt(long))).toBe("x".repeat(80));
  });

  test("the cut never splits a code point", () => {
    const title = deriveTitle(prompt(`${"a".repeat(79)}\u{1F600}tail`));
    expect(title).toBe(`${"a".repeat(79)}\u{1F600}`);
    expect(Array.from(title ?? "")).toHaveLength(80);
  });

  test("a peer provenance header line is skipped", () => {
    expect(
      deriveTitle(prompt('[message from monad session 0199 "other", repo /r]\n\nplease rebase')),
    ).toBe("please rebase");
    expect(deriveTitle(prompt("[message from the human at the monad CLI]\nhello"))).toBe("hello");
  });

  test("a prompt with no text names nothing, so the next prompt gets a turn", () => {
    expect(deriveTitle(prompt("   \n  "))).toBeUndefined();
    expect(deriveTitle({ prompt: [{ type: "image", data: "", mimeType: "image/png" }] })).toBeUndefined();
    expect(deriveTitle(null)).toBeUndefined();
  });

  test("a title carrying a token is redacted", () => {
    expect(planIndex(event("prompt", prompt(`use ${TOKEN} please`)), { titled: false }).title).toBe(
      "use [REDACTED:github-personal-access-token] please",
    );
  });
});

describe("toFtsQuery", () => {
  test("terms are quoted, joined with AND, and the last bare term is a prefix", () => {
    expect(toFtsQuery("meshyy scroll")).toBe('"meshyy" "scroll"*');
  });

  test("quoted phrases stay phrases and are not prefixed", () => {
    expect(toFtsQuery('"status row" clamp')).toBe('"status row" "clamp"*');
    expect(toFtsQuery('clamp "status row"')).toBe('"clamp" "status row"');
  });

  test("embedded quotes are doubled, an unbalanced quote is a plain character", () => {
    expect(toFtsQuery('say"what')).toBe('"say""what"*');
    expect(toFtsQuery('"unbalanced phrase')).toBe('"""unbalanced" "phrase"*');
  });

  test("FTS5 operators are searched as words, never interpreted", () => {
    expect(toFtsQuery("a OR b")).toBe('"a" "OR" "b"*');
    expect(toFtsQuery("NEAR(a b)")).toBe('"NEAR(a" "b)"*');
    expect(toFtsQuery("-excluded")).toBe('"-excluded"*');
    expect(toFtsQuery("prefix* col:value ^start")).toBe('"prefix*" "col:value" "^start"*');
  });

  test("terms with no letter or digit are dropped; nothing left means no query", () => {
    expect(toFtsQuery("* - ( ) \"\" ^")).toBeUndefined();
    expect(toFtsQuery("   ")).toBeUndefined();
    expect(toFtsQuery("")).toBeUndefined();
    expect(toFtsQuery("*** scroll")).toBe('"scroll"*');
  });

  test("unicode letters count as terms", () => {
    expect(toFtsQuery("café 日本")).toBe('"café" "日本"*');
  });

  test("NUL bytes are dropped and the term count is capped", () => {
    expect(toFtsQuery("a\0b")).toBe('"a" "b"*');
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(" ");
    expect(toFtsQuery(many)?.split(" ")).toHaveLength(32);
  });
});
