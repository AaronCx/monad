import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { Renderer } from "../src/render.ts";

/**
 * Renderer contract for attach (decision record 0004): updates buffer until
 * the replay count is known, the first N render with a [replay] prefix, one
 * divider prints, and everything after streams live.
 */

let captured = "";
const originalWrite = process.stdout.write;

beforeEach(() => {
  captured = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

function update(sessionUpdate: object): SessionNotification {
  return { sessionId: "s", update: sessionUpdate as SessionNotification["update"] };
}

const chunk = (text: string) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const userChunk = (text: string) =>
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const thought = (text: string) =>
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

describe("Renderer replay divider", () => {
  test("buffers until beginLive, prefixes replay, prints one divider", () => {
    const renderer = new Renderer({ divider: true });
    renderer.onUpdate(userChunk("hi"));
    renderer.onUpdate(chunk("echo: hi"));
    renderer.onUpdate(chunk(" and more"));
    expect(captured).toBe("");

    // Two of the three buffered updates are replay; the third is live.
    renderer.beginLive(2);
    renderer.onUpdate(chunk(" live tail"));
    renderer.ensureLine();

    const lines = captured.split("\n");
    expect(lines[0]).toBe("[replay] you: hi");
    expect(lines[1]).toBe("[replay] claude: echo: hi");
    expect(lines[2]).toBe("--- live ---");
    expect(lines[3]).toBe(" and more live tail");
    expect(captured.match(/--- live ---/g)).toHaveLength(1);
  });

  test("prints the divider immediately for an empty replay", () => {
    const renderer = new Renderer({ divider: true });
    renderer.beginLive(0);
    renderer.onUpdate(chunk("fresh"));
    renderer.ensureLine();
    expect(captured).toBe("--- live ---\nfresh\n");
  });

  test("run mode never prints a divider", () => {
    const renderer = new Renderer({ divider: false });
    renderer.beginLive(0);
    renderer.onUpdate(chunk("hello"));
    renderer.ensureLine();
    expect(captured).toBe("hello\n");
  });
});

describe("Renderer update kinds", () => {
  test("tool calls render one dim status line each", () => {
    const renderer = new Renderer({ divider: false });
    renderer.beginLive(0);
    renderer.onUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading files",
        status: "pending",
      }),
    );
    renderer.onUpdate(
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" }),
    );
    expect(captured).toBe("tool: Reading files (pending)\ntool: call_1 (completed)\n");
  });

  test("thoughts are hidden by default and shown with the flag", () => {
    const hidden = new Renderer({ divider: false });
    hidden.beginLive(0);
    hidden.onUpdate(thought("pondering"));
    hidden.ensureLine();
    expect(captured).toBe("");

    const shown = new Renderer({ divider: false, thoughts: true });
    shown.beginLive(0);
    shown.onUpdate(thought("pondering"));
    shown.ensureLine();
    expect(captured).toBe("[thought] pondering\n");
  });

  test("non-message update kinds are ignored", () => {
    const renderer = new Renderer({ divider: false });
    renderer.beginLive(0);
    renderer.onUpdate(update({ sessionUpdate: "available_commands_update", availableCommands: [] }));
    expect(captured).toBe("");
  });

  test("error notifications render in order with the replay prefix", () => {
    const renderer = new Renderer({ divider: true });
    renderer.onUpdate(userChunk("hi"));
    renderer.onError({ sessionId: "s", message: "context was not restored" });
    renderer.onUpdate(chunk("echo: hi"));
    renderer.beginLive(2);
    renderer.ensureLine();
    const lines = captured.split("\n");
    expect(lines[0]).toBe("[replay] you: hi");
    expect(lines[1]).toBe("[replay] error: context was not restored");
    expect(lines[2]).toBe("[replay] claude: echo: hi");
    expect(lines[3]).toBe("--- live ---");
  });
});
