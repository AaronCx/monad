/**
 * Standalone fake ACP agent over stdio, modeled on the SDK's
 * dist/examples/agent.js but built with the stable agent() builder API.
 * Tests spawn it as a subprocess: `bun fake-agent.ts [flags]`. No Claude
 * auth, no network, deterministic output.
 *
 * Per prompt it emits one agent_message_chunk echoing the prompt text, one
 * tool_call, and one tool_call_update. If the prompt text contains "perm" it
 * also issues one session/request_permission and reports the outcome in a
 * final agent_message_chunk.
 *
 * Vendor-ish behaviors mimicked for the adapter tests:
 * - an available_commands_update fires on session/new (spike fact: the real
 *   vendor sends one right after session/new, and monad must store it
 *   verbatim);
 * - session/load replays two session/update notifications before its
 *   response, like a vendor restoring context.
 *
 * MCP observability for the daemon tests: session/new and session/load
 * append { method, mcpServers } as one JSON line to fake-agent-mcp.jsonl in
 * the session cwd, so tests can assert exactly which mcpServers entries the
 * vendor was handed (including the empty array when injection is skipped).
 *
 * Flags:
 *   --no-load      advertise loadSession: false
 *   --fail-load    advertise loadSession: true but fail every session/load
 *   --no-mcp-http  do not advertise mcpCapabilities.http (daemon must skip
 *                  monad-checks injection)
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  agent,
  type AgentContext,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

const noLoad = process.argv.includes("--no-load");
const failLoad = process.argv.includes("--fail-load");
const noMcpHttp = process.argv.includes("--no-mcp-http");

/**
 * One JSON line per session/new or session/load, written into cwd. Never
 * writes into a git checkout (tests sometimes run the fake agent with a
 * real repo as cwd, and the recording must not leave droppings there); the
 * daemon MCP tests use plain temp-dir cwds, which are recorded.
 */
function recordMcpServers(cwd: string, method: string, mcpServers: unknown): void {
  try {
    if (existsSync(join(cwd, ".git"))) {
      return;
    }
    appendFileSync(
      join(cwd, "fake-agent-mcp.jsonl"),
      `${JSON.stringify({ method, mcpServers: mcpServers ?? [] })}\n`,
    );
  } catch {
    // Recording must never break the protocol flow.
  }
}

function promptText(params: PromptRequest): string {
  return params.prompt
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("");
}

async function notifyUpdate(
  cx: AgentContext,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await cx.notify(methods.client.session.update, { sessionId, update });
}

async function runTurn(cx: AgentContext, params: PromptRequest): Promise<void> {
  const text = promptText(params);
  const sessionId = params.sessionId;
  await notifyUpdate(cx, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo: ${text}` },
  });
  await notifyUpdate(cx, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "Reading project files",
    kind: "read",
    status: "pending",
    rawInput: { path: "README.md" },
  });
  await notifyUpdate(cx, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    rawOutput: { content: "fake file content" },
  });
  if (!text.includes("perm")) {
    return;
  }
  const permission = await cx.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: {
      toolCallId: "call_2",
      title: "Modifying a configuration file",
      kind: "edit",
      status: "pending",
      rawInput: { path: "config.json" },
    },
    options: [
      { kind: "allow_once", name: "Allow this change", optionId: "allow" },
      { kind: "reject_once", name: "Skip this change", optionId: "reject" },
    ],
  });
  const outcome =
    permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled";
  await notifyUpdate(cx, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `permission outcome: ${outcome}` },
  });
}

const sessions = new Set<string>();

const app = agent({ name: "fake-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: !noLoad,
      // The real vendor advertises { http: true, sse: true } (spike 0a);
      // --no-mcp-http exercises the daemon's skip-injection path.
      ...(noMcpHttp ? {} : { mcpCapabilities: { http: true, sse: true } }),
    },
  }))
  .onRequest(methods.agent.session.new, async (ctx) => {
    const sessionId = `fake-vendor-${crypto.randomUUID()}`;
    sessions.add(sessionId);
    recordMcpServers(ctx.params.cwd, "session/new", ctx.params.mcpServers);
    // The real vendor fires this right after session/new.
    await notifyUpdate(ctx.client, sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "compact", description: "Compact the conversation" }],
    });
    return { sessionId };
  })
  .onRequest(methods.agent.session.load, async (ctx) => {
    if (failLoad || noLoad) {
      throw RequestError.internalError(undefined, "fake-agent: session/load failed");
    }
    const sessionId = ctx.params.sessionId;
    sessions.add(sessionId);
    recordMcpServers(ctx.params.cwd, "session/load", ctx.params.mcpServers);
    // Vendor-side context replay: these must NOT be double-appended to
    // monad's event log (the adapter drops updates while restoring).
    await notifyUpdate(ctx.client, sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "replayed user message from before" },
    });
    await notifyUpdate(ctx.client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "replayed agent reply from before" },
    });
    return {};
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (!sessions.has(ctx.params.sessionId)) {
      throw RequestError.invalidParams(undefined, `unknown session ${ctx.params.sessionId}`);
    }
    await runTurn(ctx.client, ctx.params);
    return { stopReason: "end_turn" as const };
  })
  .onNotification(methods.agent.session.cancel, () => {
    // Turns here are short and synchronous; nothing to abort.
  });

// Bun-native stdio wiring: stdin as a web ReadableStream, stdout through a
// FileSink wrapped into a WritableStream (same shape decision record 0005
// requires on the client side).
const sink = Bun.stdout.writer();
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    sink.write(chunk);
    sink.flush();
  },
  close() {
    sink.end();
  },
});
const connection = app.connect(ndJsonStream(output, Bun.stdin.stream()));
await connection.closed;
