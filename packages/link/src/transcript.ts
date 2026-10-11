import { peerMetaOf, toolCallPaths } from "@aaroncx/engine";
import type { EventRecord } from "@aaroncx/protocol";

/**
 * The normalized transcript monad Link shows one session of another (and the
 * CLI shows a human): one line per thing that happened, paged by seq. Shared
 * by sessions_read, GET /v1/sessions/<id>/transcript and `monad show`.
 *
 * What it keeps and drops, and why:
 * - user prompts and agent text in full: that is the conversation;
 * - agent chunks coalesced into one entry per run of text, so a turn reads
 *   as prose rather than as hundreds of fragments;
 * - thoughts omitted (the model's scratch work, and noisy);
 * - tool calls collapsed to name, kind, paths and outcome, merged with their
 *   updates by toolCallId, plus the permission answer if one was asked.
 *   Tool OUTPUT is never shown: it is the bulk of any log, and the place
 *   secrets and injected text are likeliest to sit;
 * - every other monad event as one compact line.
 *
 * The text here is NOT redacted; callers redact the whole page at once (so a
 * secret split across two entries is still caught) and fence it.
 */

export interface TranscriptEntry {
  firstSeq: number;
  lastSeq: number;
  text: string;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** The entries joined, one per line group. */
  text: string;
  /** The seq of the first event this page covers. */
  fromSeq: number;
  /** The seq of the last event this page consumed, or null for an empty page. */
  toSeq: number | null;
  /** Where the next page starts, or null at the end of the log. */
  nextFromSeq: number | null;
}

export interface NormalizeOptions {
  /** The first seq asked for (echoed back as fromSeq). */
  fromSeq: number;
  /** Most entries per page. */
  limit: number;
  /** Most text per page, in bytes. */
  maxBytes: number;
  /** True when the log has events after the last one passed in. */
  hasMore: boolean;
}

/** Default and ceiling for entries per page. */
export const DEFAULT_TRANSCRIPT_LIMIT = 200;
export const MAX_TRANSCRIPT_LIMIT = 1000;
/** Text per page, per the design: 48 KiB. */
export const TRANSCRIPT_PAGE_BYTES = 48 * 1024;
/** Longest peer message body shown on its compact line. */
const PEER_TEXT_PREVIEW = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function seqLabel(first: number, last: number): string {
  return first === last ? `[seq ${first}]` : `[seq ${first}-${last}]`;
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  return points.length <= max ? collapsed : `${points.slice(0, max).join("")}...`;
}

function contentText(block: unknown): string {
  const record = asRecord(block);
  if (record?.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  return `[${typeof record?.type === "string" ? record.type : "content"}]`;
}

/** One entry under construction. render() is called once, at the end. */
interface Draft {
  firstSeq: number;
  lastSeq: number;
  render(): string;
}

interface ToolDraft extends Draft {
  title?: string;
  kind?: string;
  status?: string;
  paths: string[];
  permission?: string;
}

interface AgentDraft extends Draft {
  text: string;
}

interface PermissionAsk {
  title?: string;
  /** optionId to option kind, so an answer reads as allow_once, not "allow". */
  optionKinds: Map<string, string>;
  draft?: Draft;
}

function describeOutcome(payload: Record<string, unknown>, ask: PermissionAsk | undefined): string {
  const by = str(payload.by) ?? "unknown";
  const outcome = asRecord(payload.outcome);
  if (outcome?.outcome === "cancelled") {
    return `cancelled by ${by}`;
  }
  const optionId = str(payload.optionId) ?? str(outcome?.optionId);
  const kind = optionId === undefined ? undefined : ask?.optionKinds.get(optionId);
  return `${kind ?? optionId ?? "answered"} by ${by}`;
}

/**
 * Builds one page from consecutive events starting at options.fromSeq. The
 * page ends at `limit` entries or `maxBytes` of text, whichever comes first,
 * and nextFromSeq is the seq of the first event the page did not cover.
 */
export function normalizeTranscript(events: EventRecord[], options: NormalizeOptions): TranscriptPage {
  const drafts: Draft[] = [];
  const tools = new Map<string, ToolDraft>();
  const asks = new Map<string, PermissionAsk>();
  let agent: AgentDraft | undefined;
  let stoppedAt: number | undefined;

  const push = (draft: Draft): boolean => {
    if (drafts.length >= options.limit) {
      return false;
    }
    drafts.push(draft);
    return true;
  };

  const simple = (event: EventRecord, text: string): boolean => {
    agent = undefined;
    return push({ firstSeq: event.seq, lastSeq: event.seq, render: () => `${seqLabel(event.seq, event.seq)} ${text}` });
  };

  for (const event of events) {
    const payload = asRecord(event.payload) ?? {};
    let accepted = true;
    switch (event.kind) {
      case "prompt": {
        const prompt = Array.isArray(payload.prompt) ? payload.prompt : [];
        const text = prompt.map(contentText).join("\n");
        const peer = peerMetaOf(event.payload);
        accepted = simple(event, peer ? `user (peer message, hop ${peer.hop}): ${text}` : `user: ${text}`);
        break;
      }
      case "update": {
        const update = asRecord(payload.update) ?? {};
        const kind = update.sessionUpdate;
        if (kind === "agent_message_chunk") {
          const text = contentText(update.content);
          if (agent) {
            agent.text += text;
            agent.lastSeq = event.seq;
            break;
          }
          const draft: AgentDraft = {
            firstSeq: event.seq,
            lastSeq: event.seq,
            text,
            render: () => `${seqLabel(draft.firstSeq, draft.lastSeq)} agent: ${draft.text}`,
          };
          accepted = push(draft);
          if (accepted) {
            agent = draft;
          }
          break;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
          const id = str(update.toolCallId) ?? `seq-${event.seq}`;
          const existing = tools.get(id);
          const draft: ToolDraft = existing ?? {
            firstSeq: event.seq,
            lastSeq: event.seq,
            paths: [],
            render: () => {
              const parts = [`${seqLabel(draft.firstSeq, draft.firstSeq)} tool ${draft.title ?? id}`];
              if (draft.kind) {
                parts.push(`(${draft.kind})`);
              }
              if (draft.paths.length > 0) {
                parts.push(`paths: ${draft.paths.join(", ")}`);
              }
              parts.push(`-> ${draft.status ?? "pending"}`);
              const line = parts.join(" ");
              return draft.permission ? `${line}; permission: ${draft.permission}` : line;
            },
          };
          if (!existing) {
            agent = undefined;
            accepted = push(draft);
            if (!accepted) {
              break;
            }
            tools.set(id, draft);
          }
          draft.lastSeq = event.seq;
          draft.title = str(update.title) ?? draft.title;
          draft.kind = str(update.kind) ?? draft.kind;
          draft.status = str(update.status) ?? draft.status;
          for (const path of toolCallPaths(update)) {
            if (!draft.paths.includes(path)) {
              draft.paths.push(path);
            }
          }
        }
        // Thoughts, plans, usage and command lists are not shown, and do not
        // break a run of agent text either.
        break;
      }
      case "permission_requested": {
        const toolCall = asRecord(payload.toolCall);
        const id = str(toolCall?.toolCallId) ?? `seq-${event.seq}`;
        const optionKinds = new Map<string, string>();
        for (const option of Array.isArray(payload.options) ? payload.options : []) {
          const record = asRecord(option);
          const optionId = str(record?.optionId);
          const optionKind = str(record?.kind);
          if (optionId && optionKind) {
            optionKinds.set(optionId, optionKind);
          }
        }
        const ask: PermissionAsk = { title: str(toolCall?.title), optionKinds };
        asks.set(id, ask);
        if (!tools.has(id)) {
          // A permission with no tool call in this page (an ExitPlanMode
          // switch, or the call began on an earlier page) gets its own line.
          agent = undefined;
          const draft: Draft = {
            firstSeq: event.seq,
            lastSeq: event.seq,
            render: () =>
              `${seqLabel(event.seq, event.seq)} permission ${ask.title ?? id}: ${
                (draft as Draft & { outcome?: string }).outcome ?? "pending"
              }`,
          };
          accepted = push(draft);
          if (accepted) {
            ask.draft = draft;
          }
        }
        break;
      }
      case "permission_resolved": {
        const id = str(payload.toolCallId);
        const ask = id === undefined ? undefined : asks.get(id);
        const outcome = describeOutcome(payload, ask);
        const tool = id === undefined ? undefined : tools.get(id);
        if (tool) {
          tool.permission = outcome;
        } else if (ask?.draft) {
          (ask.draft as Draft & { outcome?: string }).outcome = outcome;
        } else {
          accepted = simple(event, `permission ${id ?? "request"}: ${outcome}`);
        }
        break;
      }
      case "turn_ended":
        accepted = simple(event, `turn ended (${str(payload.stopReason) ?? "unknown"})`);
        break;
      case "error":
        accepted = simple(event, `error: ${str(payload.message) ?? "unknown error"}`);
        break;
      case "session_created":
        accepted = simple(
          event,
          `session created in ${str(payload.cwd) ?? "?"} (${str(payload.mode) ?? "?"}, ${str(payload.backend) ?? "?"})`,
        );
        break;
      case "closed":
        accepted = simple(event, "session closed");
        break;
      case "worktree_ready":
        accepted = simple(event, `worktree ready at ${str(payload.path) ?? "?"}`);
        break;
      case "checks": {
        const failures = typeof payload.failureCount === "number" ? payload.failureCount : undefined;
        const warnings = typeof payload.warningCount === "number" ? payload.warningCount : undefined;
        accepted = simple(
          event,
          `checks: ${payload.hasFailures === true ? "failing" : "passing"}${
            failures === undefined ? "" : `, ${failures} failures`
          }${warnings === undefined ? "" : `, ${warnings} warnings`}`,
        );
        break;
      }
      case "review_report": {
        const findings = Array.isArray(payload.findings) ? payload.findings.length : undefined;
        accepted = simple(
          event,
          payload.structured === false
            ? "review report (unstructured)"
            : `review report: ${str(payload.verdict) ?? "?"}${findings === undefined ? "" : `, ${findings} findings`}`,
        );
        break;
      }
      case "peer_message": {
        const delivery = payload.delivery === "turn" ? "delivered as a turn" : "queued";
        accepted = simple(
          event,
          `peer message from ${str(payload.from) ?? "?"} (hop ${String(payload.hop ?? "?")}, ${delivery}): ${oneLine(
            str(payload.text) ?? "",
            PEER_TEXT_PREVIEW,
          )}`,
        );
        break;
      }
      case "access": {
        const parts = [`access: ${str(payload.by) ?? "?"} ${str(payload.op) ?? "?"} (${str(payload.role) ?? "?"})`];
        if (str(payload.target)) {
          parts.push(`target ${payload.target}`);
        }
        if (str(payload.query)) {
          parts.push(`query ${JSON.stringify(payload.query)}`);
        }
        if (str(payload.refused)) {
          parts.push(`refused: ${payload.refused}`);
        }
        accepted = simple(event, parts.join(" "));
        break;
      }
      default:
        break;
    }
    if (!accepted) {
      stoppedAt = event.seq;
      break;
    }
  }

  // Apply the byte cap: keep whole entries while they fit, at least one.
  const rendered: TranscriptEntry[] = [];
  let bytes = 0;
  for (const draft of drafts) {
    let text = draft.render();
    const size = Buffer.byteLength(text) + 1;
    if (rendered.length > 0 && bytes + size > options.maxBytes) {
      stoppedAt = draft.firstSeq;
      break;
    }
    if (size > options.maxBytes) {
      const keep = Buffer.from(text).subarray(0, Math.max(0, options.maxBytes - 120)).toString("utf8");
      text = `${keep.replace(/�$/, "")}\n[... this entry continues past the page limit and was cut]`;
    }
    rendered.push({ firstSeq: draft.firstSeq, lastSeq: draft.lastSeq, text });
    bytes += Buffer.byteLength(text) + 1;
  }

  const last = events[events.length - 1];
  let toSeq: number | null;
  let nextFromSeq: number | null;
  if (stoppedAt !== undefined) {
    // seq is log-wide (every session shares one sequence), so the page ends
    // at the last of THIS session's events before the stop, not at stop - 1.
    const stop = stoppedAt;
    toSeq = events.filter((event) => event.seq < stop).at(-1)?.seq ?? null;
    nextFromSeq = stoppedAt;
  } else {
    toSeq = last ? last.seq : null;
    nextFromSeq = options.hasMore && last ? last.seq + 1 : null;
  }
  return {
    entries: rendered,
    text: rendered.map((entry) => entry.text).join("\n"),
    fromSeq: options.fromSeq,
    toSeq,
    nextFromSeq,
  };
}
