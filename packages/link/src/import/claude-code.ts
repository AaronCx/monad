import type { ImportedEventInput } from "@aaroncx/engine";
import {
  absolutePath,
  agentTextEvent,
  asRecord,
  errorEvent,
  type LineContext,
  normalizeTs,
  oneLine,
  type ParsedLine,
  promptEvent,
  str,
  type ToolCallShape,
  toolCallEvent,
  toolResultEvent,
  turnEndedEvent,
} from "./common.ts";

/**
 * Claude Code's session logs (`~/.claude/projects/<project>/<sessionId>.jsonl`
 * and `<sessionId>/subagents/**\/agent-*.jsonl`), one JSON object per line,
 * read line by line into monad events (Link phase 4). The format is Claude
 * Code's private one, so this reads only what it needs and ignores
 * everything else; measured on real logs on this Mac (2026-10-11, Claude Code
 * 2.1.x), the line types are:
 *
 * - `user`: the human's prompt (content a string), a tool result (content an
 *   array of tool_result blocks, NOT an ask), an `isMeta` line Claude Code
 *   injected (skill bodies, image captions, the local-command caveat), a
 *   slash command (`<command-name>` wrapper) or its output
 *   (`<local-command-stdout>`), a bash mode command (`<bash-input>`, from
 *   the installed binary, not yet seen in a log here) or its output
 *   (`<bash-stdout>`, `<bash-stderr>`), a background task notification
 *   (`<task-notification>`, origin task-notification), or the summary that
 *   continues a compacted conversation (`isCompactSummary`).
 * - `assistant`: ONE content block per line (text, thinking, tool_use), with
 *   lines of the same API message sharing `message.id`. Each block becomes
 *   its own event, so nothing is lost or doubled however a message is split.
 *   Thinking is omitted, as it is for live sessions. `isApiErrorMessage`
 *   lines are synthetic (a rate limit, an API error) and become errors.
 * - `attachment` of type `queued_command`: a prompt the human typed while a
 *   turn was running, delivered into it. It is an ask like any other.
 * - `system` with subtype `turn_duration`: the end of a turn. Errors
 *   (`level: "error"`, subtype `api_error`) become error events. The rest
 *   (hook summaries, compaction markers, away summaries) are skipped.
 * - Everything else (mode, permission-mode, ai-title, last-prompt, pr-link,
 *   queue-operation, file-history-*) is client bookkeeping and is skipped.
 *
 * `isSidechain` lines in a MAIN file are an older Claude Code's inline
 * subagent traffic: they belong to another conversation and are skipped (a
 * current Claude Code writes them to the subagents directory, imported as
 * child sessions). In a subagent file every line is sidechain and is kept.
 */

/** Tool name to ACP tool kind. */
function toolKind(name: string): string {
  switch (name) {
    case "Read":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "Grep":
    case "Glob":
    case "LS":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

/** A short title for a tool call: the tool name and what it was pointed at. */
function toolTitle(name: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) ?? str(input.notebook_path);
  switch (name) {
    case "Bash":
      return `Bash: ${oneLine(str(input.description) ?? str(input.command) ?? "")}`;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path ? `${name} ${path}` : name;
    case "Grep": {
      const where = str(input.path) ? ` in ${input.path}` : "";
      return `Grep ${JSON.stringify(oneLine(str(input.pattern) ?? "", 80))}${where}`;
    }
    case "Glob":
      return `Glob ${oneLine(str(input.pattern) ?? "", 80)}${str(input.path) ? ` in ${input.path}` : ""}`;
    case "WebFetch":
      return `WebFetch ${oneLine(str(input.url) ?? "", 100)}`;
    case "WebSearch":
      return `WebSearch ${JSON.stringify(oneLine(str(input.query) ?? "", 80))}`;
    case "Task":
    case "Agent":
      return `${name}: ${oneLine(str(input.description) ?? str(input.subagent_type) ?? "", 100)}`;
    default:
      return name;
  }
}

/** Absolute paths a tool's input names directly. */
function toolPaths(input: Record<string, unknown>, cwd: string | undefined): string[] {
  const out: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = str(input[key]);
    if (value) {
      out.push(absolutePath(value, cwd));
    }
  }
  return out;
}

function toolCall(
  block: Record<string, unknown>,
  fallbackId: string,
  lineCwd: string | undefined,
  sessionCwd: string | undefined,
) {
  const name = str(block.name) ?? "tool";
  const input = asRecord(block.input) ?? {};
  let rawInput: Record<string, unknown> = input;
  if (name === "Bash" && lineCwd !== undefined && lineCwd !== sessionCwd) {
    // Claude Code keeps a working directory across Bash calls, and each log
    // line records it. A command ran THERE, so the directory is part of
    // what the call touched (Codex logs it the same way, as workdir). Only
    // added when it differs from the session's own cwd, which is recorded
    // on its own merit.
    rawInput = { ...input, cwd: lineCwd };
  }
  const shape: ToolCallShape = {
    // A tool_use always has an id; the fallback only keeps a malformed line
    // deterministic, so a re-import produces the same events.
    toolCallId: str(block.id) ?? fallbackId,
    title: toolTitle(name, input),
    kind: toolKind(name),
    rawInput,
    paths: toolPaths(input, lineCwd ?? sessionCwd),
  };
  return shape;
}

/** The text of a tool_result's content (a string, or text blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record?.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

/** `<command-name>/x</command-name> ... <command-args>y</command-args>` as `/x y`. */
function slashCommand(text: string): string | undefined {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  if (name === undefined) {
    return undefined;
  }
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim() ?? "";
  const command = name.startsWith("/") ? name : `/${name}`;
  return args.length > 0 ? `${command} ${args}` : command;
}

/**
 * Prefixes of user text Claude Code wrote, never the human: not prompts at
 * all. Bash mode's (`! cmd`) stdout and stderr are command output, which
 * monad never returns to a reader (decision record 0012), so they are
 * dropped like a slash command's output.
 */
const CLIENT_OUTPUT = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-stdout>",
  "<bash-stderr>",
];

/** Bash mode's command line, `<bash-input>cmd</bash-input>`, read as Claude Code shows it: `! cmd`. */
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/;

/**
 * The prompt a user text line stands for, and whether it is an ask (the
 * human typing), or undefined for text that is not a prompt at all.
 */
function userText(text: string, line: Record<string, unknown>): { text: string; ask: boolean } | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length === 0 || CLIENT_OUTPUT.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  const bash = trimmed.match(BASH_INPUT);
  if (bash) {
    // The human typed it, but as a command to run, not an ask of the model.
    return { text: `! ${bash[1]?.trim() ?? ""}`, ask: false };
  }
  if (trimmed.startsWith("<command-name>") || trimmed.startsWith("<command-message>")) {
    const command = slashCommand(trimmed);
    return command === undefined ? undefined : { text: command, ask: false };
  }
  if (line.isCompactSummary === true) {
    return { text, ask: false };
  }
  const origin = str(asRecord(line.origin)?.kind);
  if (trimmed.startsWith("<task-notification>") || (origin !== undefined && origin !== "human")) {
    return { text, ask: false };
  }
  return { text, ask: true };
}

/**
 * Parses one Claude Code log line. `ctx.lastTs` stands in for a line with no
 * timestamp of its own (bookkeeping lines have none, and are skipped anyway).
 */
export function parseClaudeCodeLine(raw: unknown, ctx: LineContext): ParsedLine {
  const line = asRecord(raw);
  const result: ParsedLine = { events: [] };
  if (!line) {
    return result;
  }
  const cwd = str(line.cwd);
  if (cwd !== undefined) {
    result.cwd = cwd;
  }
  const ts = normalizeTs(line.timestamp);
  if (ts !== undefined) {
    result.ts = ts;
  }
  const at = ts ?? ctx.lastTs;
  if (line.isSidechain === true && !ctx.subagent) {
    return result;
  }
  const events: ImportedEventInput[] = result.events;
  switch (line.type) {
    case "user": {
      if (line.isMeta === true) {
        return result;
      }
      const content = asRecord(line.message)?.content;
      if (typeof content === "string") {
        const prompt = userText(content, line);
        if (prompt) {
          events.push(promptEvent(ctx, prompt.text, at));
          if (prompt.ask) {
            result.ask = prompt.text;
          }
        }
        return result;
      }
      if (!Array.isArray(content)) {
        return result;
      }
      const texts: string[] = [];
      let toolResults = 0;
      for (const block of content) {
        const record = asRecord(block);
        if (record?.type === "tool_result") {
          toolResults += 1;
          const id = str(record.tool_use_id);
          if (id) {
            events.push(toolResultEvent(ctx, id, record.is_error === true, toolResultText(record.content), at));
          }
        } else if (record?.type === "text" && typeof record.text === "string") {
          texts.push(record.text);
        }
      }
      if (texts.length > 0) {
        const prompt = userText(texts.join("\n"), line);
        if (prompt) {
          events.push(promptEvent(ctx, prompt.text, at));
          // Text riding along with tool results is something Claude Code
          // attached to them, not the human typing.
          if (prompt.ask && toolResults === 0) {
            result.ask = prompt.text;
          }
        }
      }
      return result;
    }
    case "assistant": {
      const message = asRecord(line.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      if (line.isApiErrorMessage === true) {
        const text = content
          .map((block) => asRecord(block))
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block?.text as string)
          .join("\n");
        events.push(errorEvent(ctx, text.length > 0 ? text : `API error (${str(line.error) ?? "unknown"})`, at));
        return result;
      }
      content.forEach((block, index) => {
        const record = asRecord(block);
        if (record?.type === "text" && typeof record.text === "string" && record.text.length > 0) {
          events.push(agentTextEvent(ctx, record.text, at));
        } else if (record?.type === "tool_use") {
          const fallbackId = `line-${ctx.line}-${index}`;
          events.push(toolCallEvent(ctx, toolCall(record, fallbackId, cwd, ctx.sessionCwd), at));
        }
        // thinking, redacted_thinking and anything newer: omitted.
      });
      return result;
    }
    case "attachment": {
      const attachment = asRecord(line.attachment);
      if (attachment?.type !== "queued_command") {
        return result;
      }
      const prompt = attachment.prompt;
      const text =
        typeof prompt === "string"
          ? prompt
          : Array.isArray(prompt)
            ? prompt
                .map((block) => asRecord(block))
                .filter((block) => block?.type === "text" && typeof block.text === "string")
                .map((block) => block?.text as string)
                .join("\n")
            : "";
      const asked = userText(text, { origin: attachment.origin });
      if (asked) {
        events.push(promptEvent(ctx, asked.text, normalizeTs(attachment.timestamp) ?? at));
        if (asked.ask && attachment.commandMode !== "task-notification") {
          result.ask = asked.text;
        }
      }
      return result;
    }
    case "system": {
      if (line.subtype === "turn_duration") {
        events.push(turnEndedEvent(ctx, "end_turn", at));
      } else if (line.level === "error" || line.subtype === "api_error") {
        const message = str(line.content) ?? str(asRecord(line.error)?.message) ?? "API error";
        events.push(errorEvent(ctx, message, at));
      }
      return result;
    }
    default:
      return result;
  }
}
