import { describe, expect, test } from "bun:test";
import type { EventKind, EventRecord } from "@aaroncx/protocol";
import { normalizeTranscript } from "../src/transcript.ts";

/**
 * The normalized transcript: what a reading session sees of another one.
 * Tool output never appears; tool calls collapse to name, kind, paths and
 * outcome; agent text coalesces; paging is by seq and stops at whole entries.
 */

const SESSION = Bun.randomUUIDv7();
const TS = "2026-10-11T12:00:00.000Z";

function log(events: Array<[EventKind, unknown]>, firstSeq = 1, gap = 1): EventRecord[] {
  return events.map(([kind, payload], index) => ({
    seq: firstSeq + index * gap,
    sessionId: SESSION,
    ts: TS,
    kind,
    payload,
  }));
}

const update = (u: Record<string, unknown>) => ({ sessionId: SESSION, update: u });
const chunk = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const all = { fromSeq: 0, limit: 200, maxBytes: 48 * 1024, hasMore: false };

describe("normalizeTranscript", () => {
  test("a token crossing a preview's cut is redacted, not cut into a prefix that survives", () => {
    const token = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");
    const text = `${"word ".repeat(37)}token ${token} end`;
    const events = log([
      ["peer_message", { messageId: "m", from: Bun.randomUUIDv7(), to: SESSION, text, hop: 1, delivery: "queued" }],
      ["summary", { text, summarizerSessionId: Bun.randomUUIDv7(), fromSeq: 1, toSeq: 1 }],
    ]);
    const page = normalizeTranscript(events, all);
    expect(page.text).toContain("[REDAC");
    expect(page.text).not.toContain("ghp_");
  });

  test("a turn reads as prompt, coalesced agent text, collapsed tool calls and the turn end", () => {
    const events = log([
      ["prompt", { sessionId: SESSION, prompt: [{ type: "text", text: "fix the clamp" }] }],
      ["update", chunk("Looking ")],
      ["update", update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })],
      ["update", chunk("at it.")],
      [
        "update",
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Edit",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/r/a.ts" }],
          rawInput: { file_path: "/r/a.ts" },
        }),
      ],
      [
        "permission_requested",
        {
          sessionId: SESSION,
          toolCall: { toolCallId: "t1", title: "Edit" },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "no", kind: "reject_once", name: "No" },
          ],
        },
      ],
      ["permission_resolved", { outcome: { outcome: "selected", optionId: "allow" }, by: "human", optionId: "allow", toolCallId: "t1" }],
      [
        "update",
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          rawOutput: { secret: "TOOL OUTPUT MUST NOT APPEAR" },
          content: [{ type: "content", content: { type: "text", text: "TOOL OUTPUT MUST NOT APPEAR" } }],
        }),
      ],
      ["update", update({ sessionUpdate: "usage_update", used: 1 })],
      ["update", chunk("Done.")],
      ["turn_ended", { stopReason: "end_turn" }],
    ]);
    const page = normalizeTranscript(events, all);
    expect(page.text).toBe(
      [
        "[seq 1] user: fix the clamp",
        "[seq 2-4] agent: Looking at it.",
        "[seq 5] tool Edit (edit) paths: /r/a.ts -> completed; permission: allow_once by human",
        "[seq 10] agent: Done.",
        "[seq 11] turn ended (end_turn)",
      ].join("\n"),
    );
    expect(page.text).not.toContain("TOOL OUTPUT");
    expect(page.text).not.toContain("hmm");
    expect(page).toMatchObject({ fromSeq: 0, toSeq: 11, nextFromSeq: null });
  });

  test("monad's own events are one compact line each", () => {
    const peer = Bun.randomUUIDv7();
    const events = log([
      ["session_created", { cwd: "/r", mode: "interactive", backend: "claude-acp" }],
      ["peer_message", { messageId: "m", from: peer, to: SESSION, text: "hi\nthere", hop: 1, delivery: "queued" }],
      ["access", { op: "read", by: peer, role: "target", target: SESSION, fromSeq: 1, toSeq: 9 }],
      ["access", { op: "message", by: SESSION, role: "caller", target: peer, refused: "rate limited" }],
      ["error", { message: "vendor exploded" }],
      ["permission_requested", { sessionId: SESSION, toolCall: { toolCallId: "p", title: "Ready to code?" }, options: [{ optionId: "plan", kind: "reject_once", name: "No" }] }],
      ["permission_resolved", { outcome: { outcome: "selected", optionId: "plan" }, by: "policy:review", optionId: "plan", toolCallId: "p" }],
      ["closed", null],
    ]);
    expect(normalizeTranscript(events, all).text.split("\n")).toEqual([
      "[seq 1] session created in /r (interactive, claude-acp)",
      `[seq 2] peer message from ${peer} (hop 1, queued): hi there`,
      `[seq 3] access: ${peer} read (target) target ${SESSION}`,
      `[seq 4] access: ${SESSION} message (caller) target ${peer} refused: rate limited`,
      "[seq 5] error: vendor exploded",
      "[seq 6] permission Ready to code?: reject_once by policy:review",
      "[seq 8] session closed",
    ]);
  });

  test("a handoff shows its first line and a summary its opening, one line each", () => {
    const summarizer = Bun.randomUUIDv7();
    const page = normalizeTranscript(
      log([
        ["handoff", { reason: "idle", text: "idle: last asked \"fix the clamp\"\n\n## Last asks\n1. fix the clamp" }],
        ["summary", { text: "Fixed the clamp.\nNothing left.", summarizerSessionId: summarizer, fromSeq: 1, toSeq: 1 }],
      ]),
      all,
    );
    expect(page.text).toBe(
      [
        '[seq 1] handoff (idle): idle: last asked "fix the clamp"',
        `[seq 2] summary by summarizer session ${summarizer}: Fixed the clamp. Nothing left.`,
      ].join("\n"),
    );
  });

  test("pages stop at the entry limit, and the next page starts where this one stopped", () => {
    // Log-wide seqs: this session's events are every third seq.
    const events = log(
      [
        ["prompt", { sessionId: SESSION, prompt: [{ type: "text", text: "one" }] }],
        ["update", chunk("a")],
        ["update", chunk("b")],
        ["turn_ended", { stopReason: "end_turn" }],
        ["prompt", { sessionId: SESSION, prompt: [{ type: "text", text: "two" }] }],
      ],
      10,
      3,
    );
    const first = normalizeTranscript(events, { ...all, limit: 2 });
    expect(first.entries.map((e) => e.text)).toEqual(["[seq 10] user: one", "[seq 13-16] agent: ab"]);
    expect(first).toMatchObject({ toSeq: 16, nextFromSeq: 19 });
    const rest = events.filter((event) => event.seq >= 19);
    const second = normalizeTranscript(rest, { ...all, fromSeq: 19 });
    expect(second.entries.map((e) => e.text)).toEqual(["[seq 19] turn ended (end_turn)", "[seq 22] user: two"]);
    expect(second.nextFromSeq).toBeNull();
  });

  test("pages stop at the byte cap on a whole entry, and one huge entry is cut", () => {
    const events = log([
      ["prompt", { sessionId: SESSION, prompt: [{ type: "text", text: "x".repeat(300) }] }],
      ["prompt", { sessionId: SESSION, prompt: [{ type: "text", text: "y".repeat(300) }] }],
    ]);
    const capped = normalizeTranscript(events, { ...all, maxBytes: 400 });
    expect(capped.entries).toHaveLength(1);
    expect(capped).toMatchObject({ toSeq: 1, nextFromSeq: 2 });
    const huge = normalizeTranscript(events.slice(0, 1), { ...all, maxBytes: 200 });
    expect(huge.entries).toHaveLength(1);
    expect(huge.text).toContain("continues past the page limit");
    expect(Buffer.byteLength(huge.text)).toBeLessThan(260);
  });

  test("hasMore with every event consumed points the next page past the window", () => {
    const events = log([["turn_ended", { stopReason: "end_turn" }]], 5);
    expect(normalizeTranscript(events, { ...all, hasMore: true }).nextFromSeq).toBe(6);
    expect(normalizeTranscript([], { ...all, fromSeq: 9 })).toMatchObject({ text: "", toSeq: null, nextFromSeq: null });
  });
});
