import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ImportedEventInput } from "@aaroncx/engine";
import { IMPORTED_META_KEY, type ImportedMeta, type SessionId } from "@aaroncx/protocol";

/**
 * Shared pieces of the vendor log importers (monad Link phase 4, decision
 * record 0012). Each importer turns one JSONL line of a vendor's own log into
 * monad-shaped events: an ACP prompt request, ACP session/update
 * notifications (agent text, tool calls and their results), error and
 * turn_ended. The shapes are exactly what a live session logs, so the Phase 1
 * indexer, repo tagging, titles and the normalized transcript treat an
 * imported session like any other; nothing downstream has importer code.
 */

export type ImportVendor = ImportedMeta["vendor"];

/**
 * Tool inputs and outputs keep at most this many bytes per string. A log's
 * tool output is most of its size (whole files read, whole test runs), and
 * monad never returns tool output to a reader anyway (decision record 0012);
 * what is kept is enough to see what a call did.
 */
export const MAX_IMPORTED_STRING_BYTES = 4 * 1024;

/** Where one parsed line came from, and what the parser knows so far. */
export interface LineContext {
  sessionId: SessionId;
  vendor: ImportVendor;
  /** The log file, as the importer found it. */
  source: string;
  /** 1-based line number in the file. */
  line: number;
  /** The session's recorded cwd (its first line's), when known. */
  sessionCwd?: string;
  /** True for a Claude Code subagent file, whose lines are all sidechain. */
  subagent: boolean;
  /** The last timestamp seen in the file, for a line that carries none. */
  lastTs: string;
}

/** What one line contributed. */
export interface ParsedLine {
  events: ImportedEventInput[];
  /**
   * The text of a real ask from the human, when this line is one: what an
   * imported session is titled after. Tool results, slash command wrappers,
   * meta lines, task notifications and compaction summaries are prompts the
   * model saw but not asks.
   */
  ask?: string;
  /** The working directory the line reports, if any. */
  cwd?: string;
  /** The line's own timestamp, normalized, if it had one. */
  ts?: string;
  /** Codex session_meta: the session id and when it started. */
  meta?: { id: string; startedAt?: string };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A timestamp as the event log stores it (ISO 8601 UTC), or undefined when unreadable. */
export function normalizeTs(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Cuts a string to MAX_IMPORTED_STRING_BYTES of UTF-8, on a character
 * boundary, saying how much was dropped.
 */
export function truncate(text: string, maxBytes = MAX_IMPORTED_STRING_BYTES): string {
  if (text.length * 3 <= maxBytes) {
    return text; // Fast path: cannot be over, whatever the characters.
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  const kept = bytes.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return `${kept}\n[... cut by monad import: ${bytes.length} bytes in all]`;
}

/** Every string in a JSON value cut by truncate(), the shape kept. */
export function truncateDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(value);
  }
  if (depth > 8 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => truncateDeep(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = truncateDeep(item, depth + 1);
  }
  return out;
}

/** One line, collapsed whitespace, at most `max` characters (code points). */
export function oneLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  return points.length <= max ? collapsed : `${points.slice(0, max).join("")}...`;
}

/** An absolute path for a tool's path argument: relative ones resolve against the line's cwd. */
export function absolutePath(path: string, cwd: string | undefined): string {
  if (isAbsolute(path) || path.startsWith("~")) {
    return path;
  }
  return cwd === undefined ? path : resolvePath(cwd, path);
}

function importedMeta(ctx: LineContext): Record<string, ImportedMeta> {
  return { [IMPORTED_META_KEY]: { source: ctx.source, line: ctx.line, vendor: ctx.vendor } };
}

export function promptEvent(ctx: LineContext, text: string, ts: string): ImportedEventInput {
  return {
    kind: "prompt",
    ts,
    payload: { sessionId: ctx.sessionId, prompt: [{ type: "text", text }], _meta: importedMeta(ctx) },
  };
}

export function updateEvent(ctx: LineContext, update: Record<string, unknown>, ts: string): ImportedEventInput {
  return { kind: "update", ts, payload: { sessionId: ctx.sessionId, update, _meta: importedMeta(ctx) } };
}

export function agentTextEvent(ctx: LineContext, text: string, ts: string): ImportedEventInput {
  return updateEvent(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, ts);
}

export function errorEvent(ctx: LineContext, message: string, ts: string): ImportedEventInput {
  return { kind: "error", ts, payload: { message, _meta: importedMeta(ctx) } };
}

export function turnEndedEvent(ctx: LineContext, stopReason: string, ts: string): ImportedEventInput {
  return { kind: "turn_ended", ts, payload: { stopReason, _meta: importedMeta(ctx) } };
}

export interface ToolCallShape {
  toolCallId: string;
  title: string;
  kind: string;
  rawInput?: unknown;
  /** Absolute paths the call names, for ACP locations. */
  paths: string[];
}

export function toolCallEvent(ctx: LineContext, call: ToolCallShape, ts: string): ImportedEventInput {
  const paths = [...new Set(call.paths)];
  return updateEvent(
    ctx,
    {
      sessionUpdate: "tool_call",
      toolCallId: call.toolCallId,
      title: call.title,
      kind: call.kind,
      status: "pending",
      ...(call.rawInput === undefined ? {} : { rawInput: truncateDeep(call.rawInput) }),
      ...(paths.length === 0 ? {} : { locations: paths.map((path) => ({ path })) }),
    },
    ts,
  );
}

export function toolResultEvent(
  ctx: LineContext,
  toolCallId: string,
  failed: boolean,
  output: string,
  ts: string,
): ImportedEventInput {
  return updateEvent(
    ctx,
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: failed ? "failed" : "completed",
      ...(output.length === 0
        ? {}
        : { content: [{ type: "content", content: { type: "text", text: truncate(output) } }] }),
    },
    ts,
  );
}

/**
 * A subagent's session id: an RFC 9562 version 8 UUID (the version for
 * custom, here name-based, ids) from the parent's id and the subagent file's
 * path under the parent's subagents directory. Deterministic, so importing
 * the same file twice, or after a restart, lands on the same session.
 */
export function subagentSessionId(parentId: string, relativePath: string): SessionId {
  const bytes = createHash("sha256").update(`claude-code-subagent\0${parentId}\0${relativePath}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The paths an apply_patch body names (`*** Add File: p`, `*** Update File:
 * p`, `*** Delete File: p`, `*** Move to: p`), as Codex writes them.
 */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}
