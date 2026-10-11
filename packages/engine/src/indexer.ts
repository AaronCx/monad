import { redactSecrets } from "@aaroncx/checks";
import type { EventRecord, SearchKind } from "@aaroncx/protocol";
import { toolCallPaths, toolCallUpdate } from "./repos.ts";

/**
 * The session index planner (monad Link, decision record 0012): turns ONE
 * appended event into the full-text index writes and the title it implies.
 * It touches neither SQLite nor the filesystem, so every coalescing and
 * redaction rule is unit-testable on plain values; SessionStore applies the
 * plan inside the same transaction as the append.
 *
 * This is the only code path that decides what is searchable. Live appends,
 * the backfill of databases that predate the index, and imported vendor logs
 * all feed events through it, so they index identically.
 */

/**
 * Agent text accumulates into one index row per turn so a hit points at the
 * span of the log that said it, not at one of hundreds of streamed chunks.
 * Past this many characters the row closes at the next chunk that ends in
 * whitespace and a new row starts; ending on whitespace keeps a token from
 * being split across two rows, where neither half would match a redaction
 * pattern.
 */
export const AGENT_ROW_SOFT_LIMIT = 8 * 1024;

/** Hard cap: a row closes here even mid-word (a 16 KiB unbroken run). */
export const AGENT_ROW_HARD_LIMIT = 16 * 1024;

/** Derived titles stop here (characters, never splitting a code point). */
export const MAX_DERIVED_TITLE_LENGTH = 80;

/** The agent row currently accumulating text for a session's turn. */
export interface OpenAgentRow {
  rowid: number;
  firstSeq: number;
  /**
   * The row's UNREDACTED text. Redaction runs over the whole accumulated row
   * on every chunk, because a token streamed across two chunks matches no
   * pattern in either chunk alone. It lives in memory only (the store
   * rebuilds it from the event log on a cold start); the index holds the
   * redacted form.
   */
  raw: string;
}

export type IndexOp =
  /** Close the open agent row; the next agent chunk starts a new one. */
  | { type: "close" }
  /** A self-contained row (prompt, tool, error). */
  | { type: "insert"; kind: SearchKind; text: string; firstSeq: number; lastSeq: number; ts: string }
  /** A new agent row that stays open for the following chunks. */
  | { type: "open"; text: string; raw: string; firstSeq: number; lastSeq: number; ts: string }
  /** Replace the open agent row's text and widen it to lastSeq. */
  | { type: "extend"; text: string; raw: string; lastSeq: number };

export interface IndexPlan {
  ops: IndexOp[];
  /** Set when this event names a session that has no title yet. */
  title?: string;
}

export interface IndexContext {
  open?: OpenAgentRow;
  /** True when the session already has a title (derived, manual or imported). */
  titled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Text of every `text` content block of an ACP prompt request, in order. */
export function promptTexts(payload: unknown): string[] {
  const prompt = asRecord(payload)?.prompt;
  if (!Array.isArray(prompt)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of prompt) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
    }
  }
  return texts;
}

/**
 * The first line of a peer-delivered prompt (Link phase 2) names its sender.
 * It says who sent the message, not what the session is about, so a title
 * skips it.
 */
const PROVENANCE_HEADER = /^\[message from (?:monad session |the human\b)/;

/**
 * A session title from its first prompt: the first text block's first
 * non-empty line (after any provenance header), whitespace collapsed, cut to
 * 80 characters on a code point boundary with nothing appended. Undefined
 * when the prompt has no usable text, so the next prompt gets a turn.
 */
export function deriveTitle(payload: unknown): string | undefined {
  const first = promptTexts(payload)[0];
  if (first === undefined) {
    return undefined;
  }
  for (const line of first.split(/\r?\n/)) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0 || PROVENANCE_HEADER.test(collapsed)) {
      continue;
    }
    return Array.from(collapsed).slice(0, MAX_DERIVED_TITLE_LENGTH).join("");
  }
  return undefined;
}

function redacted(text: string): string {
  return redactSecrets(text).text;
}

/** An agent_message_chunk's text, or undefined for any other event. */
export function agentChunkText(event: EventRecord): string | undefined {
  if (event.kind !== "update") {
    return undefined;
  }
  const update = asRecord(asRecord(event.payload)?.update);
  if (update?.sessionUpdate !== "agent_message_chunk") {
    return undefined;
  }
  const content = asRecord(update.content);
  return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

function shouldCloseAgentRow(raw: string): boolean {
  if (raw.length >= AGENT_ROW_HARD_LIMIT) {
    return true;
  }
  return raw.length >= AGENT_ROW_SOFT_LIMIT && /\s$/.test(raw);
}

/**
 * Plans the index writes for one event.
 *
 * - prompt: closes the open agent row (a new turn), then one `prompt` row of
 *   all its text blocks. The first prompt of an untitled session names it.
 * - agent_message_chunk: extends the open agent row, or opens one. Thought
 *   chunks are not indexed (they are the model's scratch work, and noisy).
 * - tool_call / tool_call_update: one `tool` row of the title and the paths,
 *   only when either is present. Tool output is never indexed.
 * - error: closes the open agent row, then one `error` row of its message.
 * - turn_ended, closed: close the open agent row.
 *
 * Every text written goes through redactSecrets first, so the index never
 * holds a token the secrets patterns know.
 */
export function planIndex(event: EventRecord, context: IndexContext): IndexPlan {
  const ops: IndexOp[] = [];
  const plan: IndexPlan = { ops };
  const { seq, ts } = event;
  switch (event.kind) {
    case "prompt": {
      if (context.open) {
        ops.push({ type: "close" });
      }
      const text = promptTexts(event.payload).join("\n").trim();
      if (text.length > 0) {
        ops.push({ type: "insert", kind: "prompt", text: redacted(text), firstSeq: seq, lastSeq: seq, ts });
      }
      if (!context.titled) {
        const title = deriveTitle(event.payload);
        if (title !== undefined) {
          // A title is shown to other sessions and on the phone; it gets the
          // same redaction as the index.
          plan.title = redacted(title);
        }
      }
      return plan;
    }
    case "update": {
      const chunk = agentChunkText(event);
      if (chunk !== undefined) {
        if (chunk.length === 0) {
          return plan;
        }
        const raw = context.open ? context.open.raw + chunk : chunk;
        const text = redacted(raw);
        ops.push(
          context.open
            ? { type: "extend", text, raw, lastSeq: seq }
            : { type: "open", text, raw, firstSeq: seq, lastSeq: seq, ts },
        );
        if (shouldCloseAgentRow(raw)) {
          ops.push({ type: "close" });
        }
        return plan;
      }
      const update = toolCallUpdate(event);
      if (update) {
        const title = typeof update.title === "string" ? update.title.trim() : "";
        const paths = [...new Set(toolCallPaths(update))];
        if (title.length > 0 || paths.length > 0) {
          const text = [title, ...paths].filter((part) => part.length > 0).join("\n");
          ops.push({ type: "insert", kind: "tool", text: redacted(text), firstSeq: seq, lastSeq: seq, ts });
        }
      }
      return plan;
    }
    case "error": {
      if (context.open) {
        ops.push({ type: "close" });
      }
      const message = asRecord(event.payload)?.message;
      if (typeof message === "string" && message.trim().length > 0) {
        ops.push({
          type: "insert",
          kind: "error",
          text: redacted(message.trim()),
          firstSeq: seq,
          lastSeq: seq,
          ts,
        });
      }
      return plan;
    }
    case "turn_ended":
    case "closed": {
      if (context.open) {
        ops.push({ type: "close" });
      }
      return plan;
    }
    default:
      return plan;
  }
}

/** Most terms a search query keeps; the rest are dropped. */
const MAX_QUERY_TERMS = 32;

function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** True when the tokenizer would find at least one token in the text. */
function hasToken(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Turns free text into a safe FTS5 MATCH expression. User text is NEVER
 * passed to MATCH as written: FTS5 query syntax (AND, OR, NOT, NEAR, `*`,
 * `^`, `:`, `-`, parentheses, column filters) would let a query error out or
 * mean something its author did not type.
 *
 * Rules: `"quoted phrases"` are kept as phrases; everything else splits on
 * whitespace into terms. Every phrase and term is wrapped in double quotes
 * (an embedded `"` doubled), which makes FTS5 read it as a plain string to
 * tokenize, operators included. A term with no letter or digit is dropped.
 * The last element gets a trailing `*` (prefix match, so search-as-you-type
 * works) when it is a bare term, not when it is a phrase the user quoted.
 * Elements join with spaces, which FTS5 reads as AND. Returns undefined when
 * nothing searchable is left, and the caller returns no hits.
 */
export function toFtsQuery(input: string): string | undefined {
  // NUL never belongs in a query; the rest of the control range is harmless
  // inside a quoted string.
  const text = input.replace(/\0/g, " ");
  const parts: Array<{ value: string; phrase: boolean }> = [];
  let i = 0;
  while (i < text.length && parts.length < MAX_QUERY_TERMS) {
    const ch = text[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      if (close !== -1) {
        const phrase = text.slice(i + 1, close);
        if (hasToken(phrase)) {
          parts.push({ value: phrase, phrase: true });
        }
        i = close + 1;
        continue;
      }
      // An unbalanced quote is just a character of the next term.
    }
    let end = i;
    while (end < text.length && !/\s/.test(text[end] ?? "")) {
      end += 1;
    }
    const term = text.slice(i, end);
    if (hasToken(term)) {
      parts.push({ value: term, phrase: false });
    }
    i = end;
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts
    .map((part, index) => {
      const quoted = quoteTerm(part.value);
      return index === parts.length - 1 && !part.phrase ? `${quoted}*` : quoted;
    })
    .join(" ");
}
