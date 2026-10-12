import type { ContentBlock, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import type { MonadErrorNotification, MonadLinkNotification } from "@aaroncx/protocol";

/**
 * Plain stdout rendering for run and attach. No TUI framework in M1.
 *
 * Replay handling follows decision record 0004: the transport gives no
 * ordering between the session/load response and the replayed
 * session/update notifications, so updates buffer until the caller learns
 * the replay count from the load response _meta. The first N update
 * notifications render with a dim [replay] prefix, then exactly one
 * "--- live ---" divider prints, and everything after streams live.
 */

export interface RendererOptions {
  /** Show agent_thought_chunk updates (hidden by default). */
  thoughts?: boolean;
  /** Print the "--- live ---" divider when replay completes (attach). */
  divider?: boolean;
}

type BufferedItem =
  | { type: "update"; params: SessionNotification }
  | { type: "error"; params: MonadErrorNotification }
  | { type: "peer"; params: MonadLinkNotification }
  | { type: "access"; params: MonadLinkNotification };

/** Longest peer message body printed on its line; `monad show` has the rest. */
const PEER_PREVIEW = 300;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shortId(value: unknown): string {
  const id = str(value);
  if (id === undefined) {
    return "?";
  }
  return id === "human" ? "the human" : id.slice(0, 8);
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  return points.length <= max ? collapsed : `${points.slice(0, max).join("")}...`;
}

/**
 * One line for a peer message a watched session received (monad Link). The
 * body is shown as data, after a label the daemon's payload decides.
 */
export function formatPeerMessage(params: MonadLinkNotification): string {
  const from = params.from === "human" ? "the human" : `session ${shortId(params.from)}`;
  const title = str(params.fromTitle) ? ` ${JSON.stringify(params.fromTitle)}` : "";
  const how = params.delivery === "queued" ? "queued for the next turn" : "delivered as a turn";
  return `peer message from ${from}${title} (hop ${String(params.hop ?? "?")}, ${how}): ${oneLine(
    str(params.text) ?? "",
    PEER_PREVIEW,
  )}`;
}

/** One line for an access event: who did what to this session, or it to whom. */
export function formatAccess(params: MonadLinkNotification): string {
  const op = str(params.op) ?? "?";
  const parts =
    params.role === "caller"
      ? [`access: this session ran ${op}`, ...(str(params.target) ? [`on ${shortId(params.target)}`] : [])]
      : [`access: ${params.by === "human" ? "the human" : `session ${shortId(params.by)}`} ran ${op} on this session`];
  if (str(params.query)) {
    parts.push(`for ${JSON.stringify(params.query)}`);
  }
  if (str(params.refused)) {
    parts.push(`(refused: ${params.refused})`);
  }
  return parts.join(" ");
}

function contentText(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }
  return `[${block.type}]`;
}

export class Renderer {
  private readonly thoughts: boolean;
  private readonly divider: boolean;
  private readonly useColor: boolean;
  private buffer: BufferedItem[] | undefined = [];
  private expectedReplay = 0;
  private replayed = 0;
  private dividerPrinted = false;
  /** Which chunk stream currently has an unterminated stdout line. */
  private openStream: "agent" | "thought" | null = null;

  constructor(options: RendererOptions = {}) {
    this.thoughts = options.thoughts ?? false;
    this.divider = options.divider ?? false;
    this.useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  }

  /** Handles one incoming session/update notification. */
  onUpdate(params: SessionNotification): void {
    if (this.buffer) {
      this.buffer.push({ type: "update", params });
      return;
    }
    this.renderUpdate(params);
  }

  /** Handles one incoming _monad.sh/error extension notification. */
  onError(params: MonadErrorNotification): void {
    if (this.buffer) {
      this.buffer.push({ type: "error", params });
      return;
    }
    this.renderError(params);
  }

  /** Handles one _monad.sh/peer_message notification (monad Link). */
  onPeerMessage(params: MonadLinkNotification): void {
    if (this.buffer) {
      this.buffer.push({ type: "peer", params });
      return;
    }
    this.renderLink("peer", params);
  }

  /** Handles one _monad.sh/access notification (monad Link). */
  onAccess(params: MonadLinkNotification): void {
    if (this.buffer) {
      this.buffer.push({ type: "access", params });
      return;
    }
    this.renderLink("access", params);
  }

  /**
   * Called once the replay count is known (0 for run). Flushes the buffer;
   * anything beyond the count is live.
   */
  beginLive(expectedReplay: number): void {
    this.expectedReplay = expectedReplay;
    const buffered = this.buffer ?? [];
    this.buffer = undefined;
    this.maybePrintDivider();
    for (const item of buffered) {
      if (item.type === "update") {
        this.renderUpdate(item.params);
      } else if (item.type === "error") {
        this.renderError(item.params);
      } else {
        this.renderLink(item.type, item.params);
      }
    }
  }

  /** Terminates any open streamed line so the next write starts clean. */
  ensureLine(): void {
    if (this.openStream !== null) {
      process.stdout.write("\n");
      this.openStream = null;
    }
  }

  turnEnded(stopReason: string): void {
    this.ensureLine();
    if (stopReason !== "end_turn") {
      this.line(this.dim(`(${stopReason})`));
    }
  }

  line(text: string): void {
    this.ensureLine();
    process.stdout.write(`${text}\n`);
  }

  dim(text: string): string {
    return this.useColor ? `\x1b[2m${text}\x1b[22m` : text;
  }

  private inReplay(): boolean {
    return this.replayed < this.expectedReplay;
  }

  private maybePrintDivider(): void {
    if (this.dividerPrinted || this.inReplay()) {
      return;
    }
    this.dividerPrinted = true;
    if (this.divider) {
      this.ensureLine();
      process.stdout.write("--- live ---\n");
    }
  }

  private renderUpdate(params: SessionNotification): void {
    const replay = this.inReplay();
    if (replay) {
      this.replayed += 1;
    }
    this.renderUpdateBody(params.update, replay);
    if (replay) {
      this.maybePrintDivider();
    }
  }

  private renderUpdateBody(update: SessionUpdate, replay: boolean): void {
    const prefix = replay ? this.dim("[replay] ") : "";
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (replay) {
          if (this.openStream !== "agent") {
            this.ensureLine();
            process.stdout.write(`${prefix}claude: `);
            this.openStream = "agent";
          }
          process.stdout.write(text);
          return;
        }
        if (this.openStream !== "agent") {
          this.ensureLine();
          this.openStream = "agent";
        }
        process.stdout.write(text);
        return;
      }
      case "agent_thought_chunk": {
        if (!this.thoughts) {
          return;
        }
        const text = contentText(update.content);
        if (this.openStream !== "thought") {
          this.ensureLine();
          process.stdout.write(this.dim(`${replay ? "[replay] " : ""}[thought] `));
          this.openStream = "thought";
        }
        process.stdout.write(this.dim(text));
        return;
      }
      case "user_message_chunk": {
        this.ensureLine();
        const text = contentText(update.content);
        if (replay) {
          process.stdout.write(`${prefix}${this.dim(`you: ${text}`)}\n`);
        } else {
          // Another attached client prompted this session.
          process.stdout.write(`${this.dim(`user: ${text}`)}\n`);
        }
        return;
      }
      case "tool_call": {
        this.ensureLine();
        const title = update.title ?? update.toolCallId;
        const status = update.status ?? "pending";
        process.stdout.write(`${prefix}${this.dim(`tool: ${title} (${status})`)}\n`);
        return;
      }
      case "tool_call_update": {
        this.ensureLine();
        const label = update.title ?? update.toolCallId;
        const status = update.status ?? "in_progress";
        process.stdout.write(`${prefix}${this.dim(`tool: ${label} (${status})`)}\n`);
        return;
      }
      default:
        // plan, available_commands_update, usage_update, mode and config
        // changes: stored in the daemon's log, not rendered in M1.
        return;
    }
  }

  private renderLink(type: "peer" | "access", params: MonadLinkNotification): void {
    this.ensureLine();
    const prefix = this.inReplay() ? this.dim("[replay] ") : "";
    if (type === "peer") {
      process.stdout.write(`${prefix}${formatPeerMessage(params)}\n`);
    } else {
      process.stdout.write(`${prefix}${this.dim(formatAccess(params))}\n`);
    }
  }

  private renderError(params: MonadErrorNotification): void {
    this.ensureLine();
    const prefix = this.inReplay() ? this.dim("[replay] ") : "";
    process.stdout.write(`${prefix}error: ${params.message}\n`);
  }
}
