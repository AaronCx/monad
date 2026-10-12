import { redactSecrets, redactSecretsInWindow } from "@aaroncx/checks";
import type { EventRecord, SearchKind } from "@aaroncx/protocol";
import { PROVENANCE_HEADER_PATTERN } from "./peer.ts";
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
 * A long turn splits into several rows, always at a chunk boundary so every
 * row's seq range is exact: past the soft limit at the first boundary with
 * whitespace on either side (so a word stays whole for search), and at the
 * hard limit at the next boundary whatever it is.
 *
 * A split never weakens redaction. Each row is redacted with the text around
 * it as context (REDACTION_OVERLAP), so a token, a private key block or a
 * `name = value` assignment cut by a split is redacted whole in both rows.
 */
export const AGENT_ROW_SOFT_LIMIT = 8 * 1024;

/** A row splits at the next chunk boundary once it holds this much. */
export const AGENT_ROW_HARD_LIMIT = 16 * 1024;

/**
 * How much text on each side of a split redaction sees: a new row is redacted
 * with the previous row's last REDACTION_OVERLAP characters before it, and
 * the previous row is re-redacted ("settles") with the new row's text after
 * it until the new row holds REDACTION_OVERLAP characters. A secret shorter
 * than this (every token pattern, and an RSA 4096 private key block) is never
 * cut in two by a split.
 */
export const REDACTION_OVERLAP = 4 * 1024;

/** Derived titles stop here (characters, never splitting a code point). */
export const MAX_DERIVED_TITLE_LENGTH = 80;

/**
 * An agent row's UNREDACTED text. Redaction runs over the whole accumulated
 * row on every chunk, because a token streamed across two chunks matches no
 * pattern in either chunk alone. It lives in memory only (the store rebuilds
 * it from the event log on a cold start); the index holds the redacted form.
 */
export interface AgentRowText {
  /**
   * Text of the same turn just before the row (the end of the row it split
   * from), or empty for a turn's first row. Redaction context only: it is
   * never written to this row.
   */
  context: string;
  /** The row's own text: its chunks, concatenated. */
  raw: string;
}

/** An agent row by its chunk span, before it has a place in the index. */
export interface AgentRowShape extends AgentRowText {
  firstSeq: number;
}

/** The agent row currently accumulating text for a session's turn. */
export interface OpenAgentRow extends AgentRowShape {
  rowid: number;
}

/**
 * The row a split just closed. It takes no more chunks, but its text is
 * re-redacted with the new row's opening text after it, until that reaches
 * REDACTION_OVERLAP characters, so a secret cut by the split is redacted
 * whole in this row too.
 */
export interface SettlingAgentRow extends AgentRowText {
  rowid: number;
}

export type IndexOp =
  /** End of a turn: the open and settling agent rows are final. */
  | { type: "close" }
  /** The open agent row stops taking chunks and becomes the settling row. */
  | { type: "split" }
  /** A self-contained row (prompt, tool, error). */
  | { type: "insert"; kind: SearchKind; text: string; firstSeq: number; lastSeq: number; ts: string }
  /** A new agent row that stays open for the following chunks. */
  | {
      type: "open";
      text: string;
      raw: string;
      context: string;
      firstSeq: number;
      lastSeq: number;
      ts: string;
    }
  /** Replace the open agent row's text and widen it to lastSeq. */
  | { type: "extend"; text: string; raw: string; lastSeq: number }
  /** Replace the settling row's text; when done, it is final. */
  | { type: "settle"; text: string; done: boolean };

export interface IndexPlan {
  ops: IndexOp[];
  /** Set when this event names a session that has no title yet. */
  title?: string;
}

export interface IndexContext {
  open?: OpenAgentRow;
  settling?: SettlingAgentRow;
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

/** The start of a redaction placeholder, as redactSecrets writes it. */
const PLACEHOLDER_START = "[REDACTED:";

/**
 * Cuts a title to MAX_DERIVED_TITLE_LENGTH code points, nothing appended. A
 * cut that lands inside a redaction placeholder drops the partial
 * placeholder, so a title never ends in half of one.
 */
function cutTitle(line: string): string {
  const points = Array.from(line);
  if (points.length <= MAX_DERIVED_TITLE_LENGTH) {
    return line;
  }
  const cut = points.slice(0, MAX_DERIVED_TITLE_LENGTH).join("");
  // `cut` is a prefix of `line`, so an index into one is an index into both.
  const open = cut.lastIndexOf("[");
  if (open !== -1 && !cut.includes("]", open) && line.startsWith(PLACEHOLDER_START, open)) {
    return cut.slice(0, open).trimEnd();
  }
  return cut;
}

/**
 * A session title from its first prompt: the first text block's first
 * non-empty line (after any provenance header), whitespace collapsed, cut to
 * 80 characters on a code point boundary with nothing appended. Undefined
 * when the prompt has no usable text, so the next prompt gets a turn.
 *
 * The whole first text block is redacted BEFORE the line is picked and cut.
 * Cutting first would leave a token's prefix, which no longer matches its
 * pattern (a ghp_ token needs all 36 characters) and so survives redaction;
 * redacting the whole block also catches a secret that spans lines, such as
 * a private key block or a quoted multi-line password. A title is shown to
 * other sessions and on the phone, so it gets the same redaction as the
 * index.
 */
export function deriveTitle(payload: unknown): string | undefined {
  const first = promptTexts(payload)[0];
  if (first === undefined) {
    return undefined;
  }
  for (const line of redactSecrets(first).text.split(/\r?\n/)) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0 || PROVENANCE_HEADER_PATTERN.test(collapsed)) {
      continue;
    }
    const title = cutTitle(collapsed);
    if (title.length > 0) {
      return title;
    }
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

/** True when the next chunk starts a new row instead of extending this one. */
function splitsBefore(raw: string, chunk: string): boolean {
  if (raw.length >= AGENT_ROW_HARD_LIMIT) {
    return true;
  }
  return raw.length >= AGENT_ROW_SOFT_LIMIT && (/\s$/.test(raw) || /^\s/.test(chunk));
}

export interface AgentRowsShape {
  open?: AgentRowShape;
  settling?: AgentRowText;
}

interface AgentStep {
  /** The open row after the chunk. */
  open: AgentRowShape;
  /** True when the chunk opened that row (first of the turn, or a split). */
  opened: boolean;
  /** True when the chunk split the previous open row off. */
  split: boolean;
  /** The settling row this chunk re-redacts, if any. */
  settling?: AgentRowText;
  /** True when that settling row has seen enough of what follows it. */
  settled: boolean;
}

/**
 * What one non-empty agent chunk does to a turn's rows, with no redaction:
 * the structural half of planIndex, shared with replayAgentRows so a cold
 * start rebuilds exactly the rows live indexing built.
 */
function stepAgentRows(rows: AgentRowsShape, chunk: string, seq: number): AgentStep {
  const { open, settling } = rows;
  if (!open) {
    return { open: { firstSeq: seq, context: "", raw: chunk }, opened: true, split: false, settled: false };
  }
  if (splitsBefore(open.raw, chunk)) {
    // Code units, not code points: the context only feeds redaction, where
    // half a surrogate pair at its far end changes nothing.
    const context = (open.context + open.raw).slice(-REDACTION_OVERLAP);
    return {
      open: { firstSeq: seq, context, raw: chunk },
      opened: true,
      split: true,
      settling: { context: open.context, raw: open.raw },
      settled: chunk.length >= REDACTION_OVERLAP,
    };
  }
  const raw = open.raw + chunk;
  return {
    open: { ...open, raw },
    opened: false,
    split: false,
    settling,
    settled: settling !== undefined && raw.length >= REDACTION_OVERLAP,
  };
}

/**
 * The agent rows of a turn after the given chunks (in seq order, everything
 * since the turn's opening event), as planIndex would have left them. Empty
 * chunks are skipped exactly as planIndex skips them.
 */
export function replayAgentRows(chunks: Array<{ seq: number; text: string }>): AgentRowsShape {
  let rows: AgentRowsShape = {};
  for (const { seq, text } of chunks) {
    if (text.length === 0) {
      continue;
    }
    const step = stepAgentRows(rows, text, seq);
    rows = { open: step.open, settling: step.settled ? undefined : step.settling };
  }
  return rows;
}

/** A row's own text, redacted with its context before it and `after` after it. */
function redactedRow(row: AgentRowText, after = ""): string {
  const start = row.context.length;
  return redactSecretsInWindow(row.context + row.raw + after, start, start + row.raw.length).text;
}

/**
 * Plans the index writes for one event.
 *
 * - prompt: closes the open agent row (a new turn), then one `prompt` row of
 *   all its text blocks. The first prompt of an untitled session names it.
 * - agent_message_chunk: extends the open agent row, or opens one (on a
 *   long turn, splitting the open row off first; see AGENT_ROW_SOFT_LIMIT).
 *   Thought chunks are not indexed (they are the model's scratch work, and
 *   noisy).
 * - tool_call / tool_call_update: one `tool` row of the title and the paths,
 *   only when either is present. Tool output is never indexed.
 * - error: closes the open agent row, then one `error` row of its message.
 * - turn_ended, closed: close the open agent row.
 * - handoff, summary (Link phase 3): one row of the handoff's or summary's
 *   text. Neither touches the open agent row: a handoff is written between
 *   turns (or just before closed), and a summary is appended to the target
 *   by another session, possibly mid-turn.
 *
 * Every text written goes through the redactor first, so the index never
 * holds a token the secrets patterns know, a split agent row included.
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
        // deriveTitle redacts before it cuts (see there).
        const title = deriveTitle(event.payload);
        if (title !== undefined) {
          plan.title = title;
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
        const step = stepAgentRows({ open: context.open, settling: context.settling }, chunk, seq);
        if (step.split) {
          ops.push({ type: "split" });
        }
        const { open } = step;
        const text = redactedRow(open);
        ops.push(
          step.opened
            ? { type: "open", text, raw: open.raw, context: open.context, firstSeq: seq, lastSeq: seq, ts }
            : { type: "extend", text, raw: open.raw, lastSeq: seq },
        );
        if (step.settling) {
          ops.push({ type: "settle", text: redactedRow(step.settling, open.raw), done: step.settled });
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
    case "handoff":
    case "summary": {
      const text = asRecord(event.payload)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        ops.push({
          type: "insert",
          kind: event.kind,
          text: redacted(text.trim()),
          firstSeq: seq,
          lastSeq: seq,
          ts,
        });
      }
      return plan;
    }
    default:
      return plan;
  }
}

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
  // inside a quoted string. A lone UTF-16 surrogate (JSON `"\ud800"` decodes
  // to one) is not: bun:sqlite encodes it together with the code unit after
  // it, so a lone high surrogate before the closing `"` swallows the quote
  // and the query escapes its quoting. Both become separators.
  const text = input.replace(LONE_SURROGATE, " ").replace(/\0/g, " ");
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
