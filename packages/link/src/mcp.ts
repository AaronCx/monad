import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BackendIdSchema,
  type LinkToolName,
  MAX_NOTE_LENGTH,
  SESSIONS_MCP_SERVER_NAME,
  type SessionId,
  SessionStatusSchema,
} from "@aaroncx/protocol";
import { redactSecrets } from "@aaroncx/checks";
import { quoteHistory } from "./quote.ts";
import { LinkError, type LinkService, MAX_WAIT_MS } from "./service.ts";

/**
 * The monad-sessions MCP server (monad Link, decision record 0012): one
 * session's view of the others, mounted by the daemon at
 * /mcp-sessions/<sessionId> behind that session's derived sessions-mount
 * token.
 *
 * Same server contract as the checks plane (packages/checks/src/mcp.ts,
 * decision record 0006): stateless per request (a fresh transport and Server
 * per POST), server/discover answered with method-not-found, GET answered
 * 405. Tools are registered through the low-level Server API with JSON Schema
 * literals; McpServer.registerTool's zod generic inference blows up tsc.
 *
 * The trust table is applied twice, both times from the session record as it
 * is NOW (LinkService.toolsFor re-reads it): tools/list offers only the tools
 * the session may call, and tools/call refuses anything else. Every result's
 * text is redacted and fenced as quoted history (quote.ts).
 *
 * Results carry text content ONLY, never structuredContent. Claude Code (the
 * MCP client inside claude-agent-acp) hands the model a tool's
 * structuredContent IN PLACE OF its text content when both are present,
 * measured live on 2026-10-11 (claude-agent-acp 0.70.0): with a
 * metadata-only structuredContent the model saw sessions_read as
 * {"entries":120} and sessions_search as ids without snippets, never the
 * transcript or the fenced text. Every id, seq and status a caller needs is
 * in the text instead.
 */

export interface SessionsMcpBinding {
  service: LinkService;
  /** The calling session: the one whose mount this is. */
  sessionId: SessionId;
}

export interface SessionsMcpServer {
  binding: SessionsMcpBinding;
  /** Serves one HTTP request. Mount behind the sessions-mount bearer check. */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

const OBJECT = "object" as const;

const STATUS_VALUES = SessionStatusSchema.options;
const SPAWN_BACKENDS = BackendIdSchema.options.filter((backend) => !backend.startsWith("import:"));

/** JSON Schema literals for every served tool, in LINK_TOOL_NAMES order. */
const TOOL_DEFINITIONS: Record<
  LinkToolName,
  { name: LinkToolName; description: string; inputSchema: { type: "object"; [key: string]: unknown } }
> = {
  sessions_list: {
    name: "sessions_list",
    description:
      "List monad sessions on this machine, most recently active first: id, title, backend, status, " +
      "the repos each one touched, when it was last active, and its parent if it was spawned. " +
      "Use it to find the session that worked on something before reading it.",
    inputSchema: {
      type: OBJECT,
      properties: {
        repo: { type: "string", description: "Only sessions that touched this repository (any path inside it)." },
        status: { type: "string", enum: [...STATUS_VALUES] },
        since: { type: "string", description: "ISO timestamp; only sessions active at or after it." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        include_imported: { type: "boolean", description: "Include imported vendor logs (default true)." },
      },
      additionalProperties: false,
    },
  },
  sessions_search: {
    name: "sessions_search",
    description:
      "Full-text search over every session's history (prompts, agent replies, tool call titles and " +
      "paths, errors). Returns hits with the session id and the seq range to read with sessions_read, " +
      "at most three per session (best ranked first), so the hits name as many sessions as they can.",
    inputSchema: {
      type: OBJECT,
      properties: {
        query: { type: "string", description: "Words to find; quote a phrase to match it exactly." },
        repo: { type: "string" },
        since: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  sessions_read: {
    name: "sessions_read",
    description:
      "Read one session's history as a normalized transcript, paged by seq: user prompts, agent text, " +
      "tool calls collapsed to name, paths and outcome. Pass next_from_seq back as from_seq for the next page.",
    inputSchema: {
      type: OBJECT,
      properties: {
        session_id: { type: "string" },
        from_seq: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  sessions_message: {
    name: "sessions_message",
    description:
      "Send a message to another interactive monad session. It becomes that session's next turn, " +
      "under a header naming you as the sender; if it is busy, the message waits for its current turn " +
      "to end. A message can only ever be read as a prompt: it cannot answer permissions or change modes.",
    inputSchema: {
      type: OBJECT,
      properties: {
        to: { type: "string", description: "The target session id." },
        text: { type: "string" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  sessions_spawn: {
    name: "sessions_spawn",
    description:
      "Start a child monad session in a directory with a first prompt, and return its id at once. " +
      "Use sessions_wait to wait for it and sessions_read to read what it did. worktree: true runs it " +
      "in a fresh detached worktree of the directory's repo at HEAD.",
    inputSchema: {
      type: OBJECT,
      properties: {
        cwd: { type: "string", description: "Absolute directory the child runs in." },
        prompt: { type: "string" },
        backend: { type: "string", enum: SPAWN_BACKENDS, description: "Default claude-acp." },
        mode: { type: "string", enum: ["interactive", "review"], description: "Default interactive." },
        worktree: { type: "boolean" },
      },
      required: ["cwd", "prompt"],
      additionalProperties: false,
    },
  },
  sessions_wait: {
    name: "sessions_wait",
    description:
      "Wait until a session is idle (its turn ended and nothing is queued), closed, or waiting on a " +
      "permission, or until the timeout. Returns whether it got there, its status, and its last stop reason.",
    inputSchema: {
      type: OBJECT,
      properties: {
        session_id: { type: "string" },
        until: { type: "string", enum: ["idle", "closed", "waiting_for_permission"] },
        timeout_ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
      },
      required: ["session_id", "until", "timeout_ms"],
      additionalProperties: false,
    },
  },
  sessions_summarize: {
    name: "sessions_summarize",
    description:
      "Ask for a model-written summary of a session: what it was for, what was done, what is unfinished. " +
      "It runs a separate read-only session over that session's quoted transcript (this spends tokens and can " +
      "take minutes), stores the summary on the session, and returns it. Every session already has a free, " +
      "deterministic handoff (see sessions_list's last handoff and sessions_read); ask for a summary only when " +
      "that is not enough.",
    inputSchema: {
      type: OBJECT,
      properties: {
        session_id: { type: "string" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  notes_read: {
    name: "notes_read",
    description:
      "Read a repository's notes: lines that sessions and the human chose to record about it (conventions, " +
      "traps, decisions), oldest first, each with who wrote it and when.",
    inputSchema: {
      type: OBJECT,
      properties: {
        repo: { type: "string", description: "Any absolute path inside the repository." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  notes_append: {
    name: "notes_append",
    description:
      "Record one note about a repository for later sessions to read with notes_read: a convention, a trap, " +
      "a decision. It is stamped with this session's id and the time, and kept by monad outside the repository.",
    inputSchema: {
      type: OBJECT,
      properties: {
        repo: { type: "string", description: "Any absolute path inside the repository." },
        text: { type: "string", maxLength: MAX_NOTE_LENGTH },
      },
      required: ["repo", "text"],
      additionalProperties: false,
    },
  },
};

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type Args = Record<string, unknown>;

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a string`);
  }
  return value;
}

function requiredString(args: Args, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `${key} is required`);
  }
  return value;
}

function optionalNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a number`);
  }
  return value;
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a boolean`);
  }
  return value;
}

/**
 * A text-only result. No structuredContent: see the header comment. A plain
 * (non-history) result is monad's own words, redacted all the same.
 */
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function plain(text: string): ToolResult {
  return textResult(redactSecrets(text).text);
}

async function callTool(binding: SessionsMcpBinding, name: string, args: Args): Promise<ToolResult> {
  const { service, sessionId } = binding;
  const caller = { kind: "session" as const, id: sessionId };
  switch (name) {
    case "sessions_list": {
      const status = optionalString(args, "status");
      if (status !== undefined && !(STATUS_VALUES as readonly string[]).includes(status)) {
        throw new McpError(ErrorCode.InvalidParams, `status must be one of ${STATUS_VALUES.join(", ")}`);
      }
      const sessions = service.list(caller, {
        repo: optionalString(args, "repo"),
        status: status as (typeof STATUS_VALUES)[number] | undefined,
        since: optionalString(args, "since"),
        limit: optionalNumber(args, "limit"),
        includeImported: optionalBoolean(args, "include_imported") ?? true,
      });
      const lines = sessions.map((s) =>
        [
          `${s.id} ${JSON.stringify(s.title ?? "untitled")}`,
          `  backend ${s.backend}, ${s.status}, ${s.mode}, active ${s.updatedAt}`,
          `  repos: ${s.repos.length > 0 ? s.repos.join(", ") : "none"}`,
          ...(s.parentId ? [`  spawned by ${s.parentId}`] : []),
          ...(s.lastHandoff ? [`  last handoff: ${s.lastHandoff}`] : []),
        ].join("\n"),
      );
      const text = quoteHistory(
        { label: `the session list (${sessions.length} sessions)` },
        lines.length > 0 ? lines.join("\n") : "no sessions",
      );
      return textResult(text);
    }
    case "sessions_search": {
      const query = requiredString(args, "query");
      const hits = service.search(caller, query, {
        repo: optionalString(args, "repo"),
        since: optionalString(args, "since"),
        limit: optionalNumber(args, "limit"),
      });
      const lines = hits.map(
        (hit) =>
          `${hit.sessionId} ${JSON.stringify(hit.title ?? "untitled")} ${hit.kind} seq ${hit.firstSeq}-${hit.lastSeq} (${hit.ts})\n  ${hit.snippet}`,
      );
      const text = quoteHistory(
        { label: `a search of session history for ${JSON.stringify(query)} (${hits.length} hits)` },
        lines.length > 0 ? lines.join("\n") : "no hits",
      );
      return textResult(text);
    }
    case "sessions_read": {
      const page = service.read(caller, requiredString(args, "session_id"), {
        fromSeq: optionalNumber(args, "from_seq"),
        limit: optionalNumber(args, "limit"),
      });
      const first = page.entries[0]?.firstSeq ?? page.fromSeq;
      const body = page.text.length > 0 ? page.text : "(no entries at or after this seq)";
      const footer =
        page.nextFromSeq === null
          ? "End of the session's log."
          : `More follows: call sessions_read with from_seq ${page.nextFromSeq}.`;
      const text = `${quoteHistory(
        { sessionId: page.sessionId, title: page.title, fromSeq: first, toSeq: page.toSeq ?? first },
        body,
      )}\n${footer}`;
      return textResult(text);
    }
    case "sessions_message": {
      const result = service.message(caller, requiredString(args, "to"), requiredString(args, "text"));
      const how =
        result.delivery === "turn"
          ? "it started that session's next turn"
          : "that session is busy, so it is queued for its next turn boundary";
      return plain(`Message ${result.messageId} delivered: ${how}.`);
    }
    case "sessions_spawn": {
      const backend = optionalString(args, "backend");
      if (backend !== undefined && !(SPAWN_BACKENDS as readonly string[]).includes(backend)) {
        throw new McpError(ErrorCode.InvalidParams, `backend must be one of ${SPAWN_BACKENDS.join(", ")}`);
      }
      const mode = optionalString(args, "mode");
      if (mode !== undefined && mode !== "interactive" && mode !== "review") {
        throw new McpError(ErrorCode.InvalidParams, "mode must be interactive or review");
      }
      const result = await service.spawn(caller, {
        cwd: requiredString(args, "cwd"),
        prompt: requiredString(args, "prompt"),
        backend: backend as "claude-acp" | "codex-acp" | undefined,
        mode: mode as "interactive" | "review" | undefined,
        worktree: optionalBoolean(args, "worktree"),
      });
      return plain(
        `Spawned session ${result.sessionId} (${result.backend}, ${result.mode}) in ${result.cwd}` +
          `${result.worktree ? " (a new worktree)" : ""}, spawn depth ${result.spawnDepth}; its first turn is running.`,
      );
    }
    case "sessions_wait": {
      const until = requiredString(args, "until");
      if (until !== "idle" && until !== "closed" && until !== "waiting_for_permission") {
        throw new McpError(ErrorCode.InvalidParams, "until must be idle, closed or waiting_for_permission");
      }
      const timeoutMs = optionalNumber(args, "timeout_ms");
      if (timeoutMs === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "timeout_ms is required");
      }
      const result = await service.wait(caller, requiredString(args, "session_id"), until, timeoutMs);
      const stop = result.lastTurnStopReason ? ` Its last turn ended with ${result.lastTurnStopReason}.` : "";
      return plain(
        result.reached
          ? `Reached ${until}: the session is ${result.status}.${stop}`
          : `Did not reach ${until}: the session is ${result.status}.${stop}`,
      );
    }
    case "sessions_summarize": {
      const summary = await service.summarize(caller, requiredString(args, "session_id"));
      const text = quoteHistory(
        { sessionId: summary.sessionId, title: summary.title, fromSeq: summary.fromSeq, toSeq: summary.toSeq },
        summary.text,
      );
      return textResult(`${text}\nStored on ${summary.sessionId} as summary event seq ${summary.seq}.`);
    }
    case "notes_read": {
      const result = service.notesRead(caller, requiredString(args, "repo"));
      const lines = result.notes.map((note) => {
        const [first = "", ...rest] = note.text.split("\n");
        return [`[${note.ts}] ${note.by}: ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
      });
      const text = quoteHistory(
        { label: `the repo notes for ${result.repo} (${result.notes.length} notes)` },
        lines.length > 0 ? lines.join("\n") : "no notes yet",
      );
      return textResult(text);
    }
    case "notes_append": {
      const result = service.notesAppend(caller, requiredString(args, "repo"), requiredString(args, "text"));
      return plain(`Noted for ${result.repo} at ${result.note.ts}.`);
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

function buildServer(binding: SessionsMcpBinding): Server {
  const server = new Server(
    { name: SESSIONS_MCP_SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: binding.service.toolsFor(binding.sessionId).map((name) => TOOL_DEFINITIONS[name]),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const allowed = binding.service.toolsFor(binding.sessionId) as string[];
    if (!allowed.includes(name)) {
      // Not offered to this session (or not a tool at all). Refused before
      // its arguments are even parsed, and the refusal is on the record.
      binding.service.recordRefusedTool(binding.sessionId, name);
      return {
        content: [
          {
            type: "text",
            text: `${name} is not available to this session (monad Link trust table, decision record 0012).`,
          },
        ],
        isError: true,
      };
    }
    try {
      return await callTool(binding, name, (request.params.arguments ?? {}) as Args);
    } catch (error) {
      if (error instanceof LinkError) {
        return { content: [{ type: "text", text: `refused (${error.code}): ${error.message}` }], isError: true };
      }
      throw error;
    }
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isDiscoverRequest(body: unknown): body is { id: number | string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "server/discover" &&
    "id" in body
  );
}

/** Builds the session-bound monad-sessions MCP server. */
export function createSessionsMcpServer(binding: SessionsMcpBinding): SessionsMcpServer {
  return {
    binding,
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed; POST JSON-RPC only" }));
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (isDiscoverRequest(parsedBody)) {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: parsedBody.id,
          error: { code: -32601, message: "Method not found: server/discover" },
        });
        return;
      }
      const server = buildServer(binding);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    },
  };
}
