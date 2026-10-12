import {
  absolutePath,
  agentTextEvent,
  asRecord,
  errorEvent,
  type LineContext,
  normalizeTs,
  oneLine,
  type ParsedLine,
  patchPaths,
  promptEvent,
  str,
  toolCallEvent,
  toolResultEvent,
  turnEndedEvent,
} from "./common.ts";

/**
 * Codex CLI's session logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`),
 * read line by line into monad events (Link phase 4). Every line is
 * `{ timestamp, type, payload }`. Measured on this Mac's logs (Codex CLI
 * 0.94, 2026-02), plus the tool item shapes Codex's rollout format defines:
 *
 * - `session_meta`: the session id (a UUID), its cwd and start time.
 * - `event_msg` / `user_message`: what the human typed. This, not the
 *   `response_item` user message, is the ask: Codex also logs AGENTS.md,
 *   the environment context and turn-abort notices as user-role
 *   response items, which the human never wrote.
 * - `response_item` / `message` role assistant: the agent's text. (The
 *   matching `event_msg` agent_message is the same text again and is
 *   skipped, so nothing is doubled.)
 * - `response_item` / `function_call`, `custom_tool_call`,
 *   `local_shell_call`, `web_search_call`: tool calls; `function_call_output`
 *   and `custom_tool_call_output`: their results, joined by `call_id`.
 * - `event_msg` / `task_complete` and `turn_aborted`: turn ends; `error`:
 *   errors. Reasoning, token counts and turn contexts are skipped.
 */

/** The shell commands Codex runs: a string, or an argv array (`["bash", "-lc", "..."]`). */
function commandText(command: unknown): string | undefined {
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join(" ");
  }
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return asRecord(value) ?? {};
  }
  try {
    return asRecord(JSON.parse(value)) ?? { arguments: value };
  } catch {
    return { arguments: value };
  }
}

/**
 * A tool output as Codex logs it: often a JSON string `{ output, metadata:
 * { exit_code } }`, sometimes plain text. A non-zero exit code is a failure.
 */
function toolOutput(value: unknown): { text: string; failed: boolean } {
  if (typeof value !== "string") {
    const record = asRecord(value);
    const content = str(record?.content) ?? str(record?.output);
    return { text: content ?? "", failed: record?.success === false };
  }
  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed && typeof parsed.output === "string") {
      const exit = asRecord(parsed.metadata)?.exit_code;
      return { text: parsed.output, failed: typeof exit === "number" && exit !== 0 };
    }
  } catch {
    // Plain text output.
  }
  return { text: value, failed: false };
}

function shellCall(ctx: LineContext, callId: string, args: Record<string, unknown>, at: string) {
  const command = commandText(args.command) ?? commandText(args.cmd) ?? "";
  const workdir = str(args.workdir) ?? str(args.working_directory) ?? str(args.cwd);
  return toolCallEvent(
    ctx,
    {
      toolCallId: callId,
      title: `shell: ${oneLine(command)}`,
      kind: "execute",
      // command as one string so repo tagging reads its `cd` and absolute
      // paths the same way it reads a Claude Code Bash command; the working
      // directory is where the command ran.
      rawInput: { command, ...(workdir ? { cwd: workdir } : {}) },
      paths: [],
    },
    at,
  );
}

function patchCall(ctx: LineContext, callId: string, patch: string, at: string) {
  const paths = patchPaths(patch).map((path) => absolutePath(path, ctx.sessionCwd));
  return toolCallEvent(
    ctx,
    {
      toolCallId: callId,
      title: paths.length > 0 ? `apply_patch ${paths.join(", ")}` : "apply_patch",
      kind: "edit",
      rawInput: { patch, ...(paths.length > 0 ? { paths } : {}) },
      paths,
    },
    at,
  );
}

const SHELL_TOOLS = new Set(["shell", "container.exec", "exec_command", "shell_command", "local_shell"]);

/** Parses one Codex rollout line. */
export function parseCodexLine(raw: unknown, ctx: LineContext): ParsedLine {
  const line = asRecord(raw);
  const result: ParsedLine = { events: [] };
  if (!line) {
    return result;
  }
  const ts = normalizeTs(line.timestamp);
  if (ts !== undefined) {
    result.ts = ts;
  }
  const at = ts ?? ctx.lastTs;
  const payload = asRecord(line.payload) ?? {};
  const events = result.events;
  switch (line.type) {
    case "session_meta": {
      const id = str(payload.id);
      if (id) {
        result.meta = { id, ...(normalizeTs(payload.timestamp) ? { startedAt: normalizeTs(payload.timestamp) } : {}) };
      }
      const cwd = str(payload.cwd);
      if (cwd) {
        result.cwd = cwd;
      }
      return result;
    }
    case "turn_context": {
      const cwd = str(payload.cwd);
      if (cwd) {
        result.cwd = cwd;
      }
      return result;
    }
    case "event_msg": {
      switch (payload.type) {
        case "user_message": {
          const text = str(payload.message);
          if (text) {
            events.push(promptEvent(ctx, text, at));
            result.ask = text;
          }
          return result;
        }
        case "task_complete":
          events.push(turnEndedEvent(ctx, "end_turn", at));
          return result;
        case "turn_aborted":
          events.push(turnEndedEvent(ctx, "cancelled", at));
          return result;
        case "error": {
          const message = str(payload.message);
          if (message) {
            events.push(errorEvent(ctx, message, at));
          }
          return result;
        }
        default:
          return result;
      }
    }
    case "response_item": {
      const callId = str(payload.call_id) ?? str(payload.id) ?? `line-${ctx.line}`;
      switch (payload.type) {
        case "message": {
          if (payload.role !== "assistant") {
            return result;
          }
          const content = Array.isArray(payload.content) ? payload.content : [];
          for (const block of content) {
            const record = asRecord(block);
            if ((record?.type === "output_text" || record?.type === "text") && typeof record.text === "string") {
              if (record.text.length > 0) {
                events.push(agentTextEvent(ctx, record.text, at));
              }
            }
          }
          return result;
        }
        case "function_call": {
          const name = str(payload.name) ?? "tool";
          const args = parseArguments(payload.arguments);
          if (SHELL_TOOLS.has(name)) {
            events.push(shellCall(ctx, callId, args, at));
          } else if (name === "apply_patch") {
            events.push(patchCall(ctx, callId, str(args.input) ?? str(args.patch) ?? "", at));
          } else {
            events.push(
              toolCallEvent(ctx, { toolCallId: callId, title: name, kind: "other", rawInput: args, paths: [] }, at),
            );
          }
          return result;
        }
        case "custom_tool_call": {
          const name = str(payload.name) ?? "tool";
          const input = typeof payload.input === "string" ? payload.input : "";
          if (name === "apply_patch") {
            events.push(patchCall(ctx, callId, input, at));
          } else {
            events.push(
              toolCallEvent(
                ctx,
                { toolCallId: callId, title: name, kind: "other", rawInput: { input }, paths: [] },
                at,
              ),
            );
          }
          return result;
        }
        case "local_shell_call": {
          const action = asRecord(payload.action) ?? {};
          events.push(shellCall(ctx, callId, action, at));
          return result;
        }
        case "web_search_call": {
          const query = str(asRecord(payload.action)?.query) ?? "";
          events.push(
            toolCallEvent(
              ctx,
              {
                toolCallId: callId,
                title: `web search ${JSON.stringify(oneLine(query, 80))}`,
                kind: "fetch",
                paths: [],
              },
              at,
            ),
          );
          return result;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const output = toolOutput(payload.output);
          events.push(toolResultEvent(ctx, callId, output.failed, output.text, at));
          return result;
        }
        default:
          return result;
      }
    }
    default:
      return result;
  }
}
