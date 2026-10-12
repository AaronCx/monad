import { describe, expect, test } from "bun:test";
import type { EventKind, EventRecord } from "@aaroncx/protocol";
import {
  AGENT_ROW_HARD_LIMIT,
  AGENT_ROW_SOFT_LIMIT,
  deriveTitle,
  type IndexOp,
  type OpenAgentRow,
  planIndex,
  REDACTION_OVERLAP,
  replayAgentRows,
  type SettlingAgentRow,
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

function openRow(raw: string, rowid = 1, context = ""): OpenAgentRow {
  return { rowid, firstSeq: 1, context, raw };
}

/**
 * Applies agent chunk plans the way SessionStore does, in memory: each row's
 * final text by row index, plus the rows still open or settling.
 */
function streamChunks(chunks: string[]) {
  const rows: Array<{ text: string; firstSeq: number; lastSeq: number }> = [];
  let open: OpenAgentRow | undefined;
  let settling: SettlingAgentRow | undefined;
  chunks.forEach((text, index) => {
    const seq = index + 1;
    for (const op of planIndex(event("update", chunk(text), seq), { open, settling, titled: true }).ops) {
      switch (op.type) {
        case "split":
          settling = { rowid: open!.rowid, context: open!.context, raw: open!.raw };
          open = undefined;
          break;
        case "open":
          rows.push({ text: op.text, firstSeq: op.firstSeq, lastSeq: op.lastSeq });
          open = { rowid: rows.length - 1, firstSeq: op.firstSeq, context: op.context, raw: op.raw };
          break;
        case "extend":
          rows[open!.rowid] = { ...rows[open!.rowid]!, text: op.text, lastSeq: op.lastSeq };
          open = { ...open!, raw: op.raw };
          break;
        case "settle":
          rows[settling!.rowid] = { ...rows[settling!.rowid]!, text: op.text };
          if (op.done) {
            settling = undefined;
          }
          break;
        default:
          throw new Error(`unexpected op ${op.type}`);
      }
    }
  });
  return { rows, open, settling };
}

/** Fails if any row holds 8 or more consecutive characters of `secret`. */
function expectNoFragment(rows: Array<{ text: string }>, secret: string): void {
  for (const row of rows) {
    for (let start = 0; start + 8 <= secret.length; start += 1) {
      expect(row.text).not.toContain(secret.slice(start, start + 8));
    }
  }
}

describe("planIndex: agent text", () => {
  test("the first chunk opens a row, later chunks extend it with the whole text", () => {
    const first = planIndex(event("update", chunk("The scroll ")), { titled: true });
    expect(first.ops).toEqual([
      expect.objectContaining({ type: "open", text: "The scroll ", raw: "The scroll ", context: "" }),
    ]);
    const second = planIndex(event("update", chunk("clamp is fixed.")), { open: openRow("The scroll "), titled: true });
    expect(second.ops).toEqual([
      expect.objectContaining({ type: "extend", text: "The scroll clamp is fixed." }),
    ]);
  });

  test("thought chunks and empty chunks are not indexed", () => {
    expect(planIndex(event("update", chunk("thinking", "agent_thought_chunk")), { titled: true }).ops).toEqual([]);
    expect(planIndex(event("update", chunk("")), { titled: true }).ops).toEqual([]);
  });

  test("prompt, turn_ended, error and closed close the open row; a tool call does not", () => {
    const open = openRow("text", 7);
    expect(opTypes(planIndex(event("turn_ended", { stopReason: "end_turn" }), { open, titled: true }).ops)).toEqual(["close"]);
    expect(opTypes(planIndex(event("closed", null), { open, titled: true }).ops)).toEqual(["close"]);
    expect(opTypes(planIndex(event("error", { message: "boom" }), { open, titled: true }).ops)).toEqual(["close", "insert"]);
    expect(opTypes(planIndex(event("prompt", prompt("next")), { open, titled: true }).ops)).toEqual(["close", "insert"]);
    expect(opTypes(planIndex(event("update", toolCall({ title: "Read file" })), { open, titled: true }).ops)).toEqual(["insert"]);
  });

  test("past 8 KiB a row splits at a chunk boundary with whitespace on either side, not mid-word", () => {
    const long = "a".repeat(AGENT_ROW_SOFT_LIMIT);
    expect(opTypes(planIndex(event("update", chunk("word")), { open: openRow(long), titled: true }).ops)).toEqual(["extend"]);
    // Vendor deltas usually carry a LEADING space, so that counts too.
    expect(opTypes(planIndex(event("update", chunk(" word")), { open: openRow(long), titled: true }).ops)).toEqual([
      "split",
      "open",
      "settle",
    ]);
    expect(opTypes(planIndex(event("update", chunk("word")), { open: openRow(`${long} `), titled: true }).ops)).toEqual([
      "split",
      "open",
      "settle",
    ]);
  });

  test("at the hard cap a row splits at the next chunk boundary even mid-word", () => {
    const open = openRow("a".repeat(AGENT_ROW_HARD_LIMIT));
    const plan = planIndex(event("update", chunk("bc")), { open, titled: true });
    expect(opTypes(plan.ops)).toEqual(["split", "open", "settle"]);
    // The new row is redacted with the end of the old one as context, and
    // holds only its own text.
    expect(plan.ops[1]).toEqual(
      expect.objectContaining({ type: "open", text: "bc", raw: "bc", context: "a".repeat(REDACTION_OVERLAP) }),
    );
  });

  test("a token streamed across two chunks is redacted in the accumulated row", () => {
    const head = TOKEN.slice(0, 20);
    const tail = TOKEN.slice(20);
    const { rows } = streamChunks([`token is ${head}`, `${tail} done`]);
    expect(rows.map((row) => row.text)).toEqual(["token is [REDACTED:github-personal-access-token] done"]);
  });

  test("a token cut by a hard-cap split is redacted whole in both rows", () => {
    // No chunk ends or starts with whitespace, so the soft limit never fires
    // and the row splits at the hard cap, right inside the token. The token's
    // tail arrives over two chunks after the split.
    const filler = Array.from({ length: Math.ceil(AGENT_ROW_HARD_LIMIT / 100) }, () => "x".repeat(100));
    const { rows, settling } = streamChunks([
      ...filler.slice(0, -1),
      `${filler.at(-1)} token ${TOKEN.slice(0, 18)}`,
      TOKEN.slice(18, 28),
      `${TOKEN.slice(28)}.end`,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text.endsWith("[REDACTED:github-personal-access-token]")).toBe(true);
    expect(rows[1]!.text).toBe("[REDACTED:github-personal-access-token].end");
    expectNoFragment(rows, TOKEN.slice(4));
    // Seq ranges stay exact and contiguous: rows split only between chunks.
    expect(rows[1]!.firstSeq).toBe(rows[0]!.lastSeq + 1);
    // Still settling: the new row holds less than REDACTION_OVERLAP so far.
    expect(settling).toBeDefined();
  });

  test("a private key block cut by a soft split leaves no key material in either row", () => {
    const body = [
      ["MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIB", "AQC7VJTUt9Us8cKj"].join(""),
      ["MzEfYyjiWA4R4/M2", "bS1GB4t7NXp98C3S", "C6dVMvDuictGeurT", "8jNbvJZHtCSuYEvu"].join(""),
    ];
    const begin = ["-----BEGIN RSA", " PRIVATE KEY-----"].join("");
    const end = ["-----END RSA", " PRIVATE KEY-----"].join("");
    // The row passes 8 KiB with the header line, which ends in a newline: the
    // next chunk splits it off right after the header.
    const { rows } = streamChunks([
      "z".repeat(AGENT_ROW_SOFT_LIMIT),
      `Here is the key:\n${begin}\n`,
      `${body[0]}\n`,
      `${body[1]}\n`,
      `${end}\n`,
      "done.",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.text).toBe("[REDACTED:private-key]\ndone.");
    for (const line of body) {
      expectNoFragment(rows, line);
    }
    expect(rows.map((row) => row.text).join("")).not.toContain("PRIVATE KEY");
  });

  test("an assignment cut by a soft split is redacted whole", () => {
    const value = ["wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join("");
    const { rows } = streamChunks([
      "q".repeat(AGENT_ROW_SOFT_LIMIT),
      "q set aws_secret_access_key = ",
      `${value} end`,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.text).toBe("[REDACTED:aws-secret-access-key] end");
    expectNoFragment(rows, value);
  });

  test("a settling row stops being rewritten once the new row holds REDACTION_OVERLAP characters", () => {
    const open = openRow("a".repeat(AGENT_ROW_HARD_LIMIT));
    const split = planIndex(event("update", chunk("b".repeat(10))), { open, titled: true });
    expect(split.ops.at(-1)).toEqual(expect.objectContaining({ type: "settle", done: false }));
    const settling: SettlingAgentRow = { rowid: 1, context: "", raw: open.raw };
    const next = openRow("b".repeat(10), 2, "a".repeat(REDACTION_OVERLAP));
    const almost = planIndex(event("update", chunk("c".repeat(REDACTION_OVERLAP - 11))), {
      open: next,
      settling,
      titled: true,
    });
    expect(almost.ops.at(-1)).toEqual(expect.objectContaining({ type: "settle", done: false }));
    const enough = planIndex(event("update", chunk("c".repeat(REDACTION_OVERLAP - 10))), {
      open: next,
      settling,
      titled: true,
    });
    expect(enough.ops.at(-1)).toEqual(expect.objectContaining({ type: "settle", done: true }));
  });

  test("replayAgentRows rebuilds exactly the rows live planning left", () => {
    const words = Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? ` w${i}` : `w${i}`));
    const chunks = [...words, "", `tail ${TOKEN.slice(0, 10)}`];
    const live = streamChunks(chunks);
    const replayed = replayAgentRows(chunks.map((text, index) => ({ seq: index + 1, text })));
    expect(replayed.open).toEqual({
      firstSeq: live.open!.firstSeq,
      context: live.open!.context,
      raw: live.open!.raw,
    });
    expect(replayed.settling).toEqual(
      live.settling ? { context: live.settling.context, raw: live.settling.raw } : undefined,
    );
    expect(live.rows.length).toBeGreaterThan(1);
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

  test("a token straddling the 80-character cut is redacted before the cut, not after", () => {
    // Every cut point through the token: whatever prefix the cut would have
    // kept, no character of the token's body may reach the title.
    for (let lead = 40; lead <= 80; lead += 1) {
      const line = `${"x".repeat(lead - 1)} ${TOKEN} thanks`;
      const title = planIndex(event("prompt", prompt(line)), { titled: false }).title ?? "";
      expect(Array.from(title).length).toBeLessThanOrEqual(80);
      for (let start = 4; start + 6 <= TOKEN.length; start += 1) {
        expect(title).not.toContain(TOKEN.slice(start, start + 6));
      }
      expect(title).not.toContain("ghp_");
    }
  });

  test("a cut inside a redaction placeholder drops the partial placeholder", () => {
    const title = deriveTitle(prompt(`${"y".repeat(70)} ${TOKEN}`));
    expect(title).toBe("y".repeat(70));
  });

  test("a secret spanning lines is redacted before the first line is taken", () => {
    const key = ["-----BEGIN PRIVATE", " KEY-----"].join("");
    const title = deriveTitle(prompt(`${key}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nmore`));
    expect(title).toBe("[REDACTED:private-key]");
  });
});

describe("toFtsQuery", () => {
  test("terms are quoted, joined with AND, and the last bare term is a prefix", () => {
    expect(toFtsQuery("meshyy scroll")).toBe('"meshyy" "scroll"*');
    expect(toFtsQuery("meshyy scroll", "any")).toBe('"meshyy" OR "scroll"*');
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

  test("lone surrogates become separators; paired ones (emoji) are kept", () => {
    expect(toFtsQuery("x\ud800")).toBe('"x"*');
    expect(toFtsQuery("x\ud800\"y")).toBe('"x" "\"\"y"*');
    expect(toFtsQuery("abc\udc00 OR y\ud800 secret")).toBe('"abc" "OR" "y" "secret"*');
    expect(toFtsQuery("hi \u{1F600}x")).toBe('"hi" "\u{1F600}x"*');
    expect(toFtsQuery(JSON.parse('"\\ud800"'))).toBeUndefined();
  });
});
