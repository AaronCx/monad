import * as readline from "node:readline";
import {
  type ClientConnection,
  client,
  type InitializeResponse,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";
import { PROMPT_IN_FLIGHT_ERROR_CODE } from "@aaroncx/engine";
import { ERROR_NOTIFICATION_METHOD, MonadErrorNotificationSchema } from "@aaroncx/protocol";
import type { DaemonHandle } from "./daemon.ts";
import type { Renderer } from "./render.ts";

/** The SDK's RequestError.authRequired() code (vendor login missing). */
const AUTH_REQUIRED_CODE = -32000;

export interface AcpSession {
  connection: ClientConnection;
  init: InitializeResponse;
}

export interface PermissionPrompter {
  ask(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/**
 * Opens the CLI's own ACP connection to the daemon (one connection per
 * client is the transport's model: each SSE mailbox has a single receiver).
 */
export async function connectAcp(
  handle: DaemonHandle,
  renderer: Renderer,
  permissions: PermissionPrompter,
): Promise<AcpSession> {
  const stream = createHttpStream(`${handle.url}/acp`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  const connection = client({ name: "monad-cli" })
    .onNotification(methods.client.session.update, (ctx) => {
      renderer.onUpdate(ctx.params);
    })
    .onNotification(ERROR_NOTIFICATION_METHOD, MonadErrorNotificationSchema, (ctx) => {
      renderer.onError(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => permissions.ask(ctx.params))
    .connect(stream);
  const init = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return { connection, init };
}

function isRequestError(error: unknown): error is RequestError {
  return error instanceof RequestError;
}

/**
 * Best-effort path of the claude-agent-acp binary for the auth hint. The
 * vendor package ships with monad's daemon install; from an arbitrary cwd
 * resolution can fail, in which case the bare command name is shown.
 */
function claudeAgentBinHint(): string {
  const entry = "@agentclientprotocol/claude-agent-acp/dist/index.js";
  try {
    return Bun.resolveSync(entry, import.meta.dir);
  } catch {
    try {
      return Bun.resolveSync(entry, process.cwd());
    } catch {
      return "claude-agent-acp";
    }
  }
}

/**
 * Maps a failed session/prompt to a user-facing message. auth_required
 * surfaces at prompt time (never at initialize or session/new), and monad
 * never proxies the login flow: the user runs the vendor command directly.
 */
export function describePromptError(error: unknown): string {
  if (isRequestError(error)) {
    if (error.code === AUTH_REQUIRED_CODE) {
      return [
        "Claude login is required. Run this in your terminal, then retry:",
        `  ${claudeAgentBinHint()} --cli auth login --claudeai`,
        "(monad never stores or forwards vendor tokens; the login lives inside the vendor binary)",
      ].join("\n");
    }
    if (error.code === PROMPT_IN_FLIGHT_ERROR_CODE) {
      return "a prompt is already in flight for this session; wait for the turn to end";
    }
    return `error: ${error.message}`;
  }
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Maps a failed session/new to a user-facing message instead of a stack
 * trace. The daemon wraps backend-start failures as internal errors whose
 * data.details carries the real cause (for example the vendor adapter not
 * being installed anywhere the daemon can see).
 */
export function describeSessionStartError(error: unknown): string {
  if (isRequestError(error)) {
    const details = (error.data as { details?: unknown } | undefined)?.details;
    const cause = typeof details === "string" && details.length > 0 ? details : error.message;
    return `could not start the session: ${cause}`;
  }
  return `could not start the session: ${error instanceof Error ? error.message : String(error)}`;
}

type InputState = "idle" | "turn" | "permission";

/**
 * Owns stdin for run and attach: lines are prompts, and while a permission
 * request is pending one keypress (TTY) or one line (piped stdin) picks an
 * option.
 */
export class InteractiveSession implements PermissionPrompter {
  private readonly renderer: Renderer;
  private rl?: readline.Interface;
  private state: InputState = "idle";
  private permissionResolve?: (choice: string) => void;
  private session?: AcpSession;
  private sessionId?: string;
  private closing = false;
  /**
   * Serializes permission questions. The daemon can ask several at once (an
   * agent issues tool calls in parallel, and attaching to a session with
   * requests held re-delivers all of them), but one terminal can only ask a
   * human one thing at a time: without this the second question would print
   * over the first and steal the keypress meant for it. Questions are asked
   * in arrival order, which for a re-delivery is oldest first.
   */
  private permissionQueue: Promise<unknown> = Promise.resolve();
  private permissionsWaiting = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  bind(session: AcpSession, sessionId: string): void {
    this.session = session;
    this.sessionId = sessionId;
  }

  /** Sends one prompt turn and renders its outcome. Returns the stopReason. */
  async sendPrompt(text: string): Promise<string | undefined> {
    if (!this.session || !this.sessionId) {
      throw new Error("sendPrompt before bind");
    }
    try {
      const response = await this.session.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.renderer.turnEnded(response.stopReason);
      return response.stopReason;
    } catch (error) {
      this.renderer.line(describePromptError(error));
      return undefined;
    }
  }

  /** Runs the interactive line loop until EOF (ctrl+D). */
  async runLoop(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });
    this.rl = rl;
    rl.on("SIGINT", () => {
      if (this.state === "turn" && this.session && this.sessionId) {
        void this.session.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: this.sessionId,
        });
        return;
      }
      rl.close();
    });
    rl.prompt();
    let currentTurn: Promise<unknown> | undefined;
    await new Promise<void>((resolve) => {
      rl.on("line", (raw) => {
        const line = raw.trim();
        if (this.state === "permission") {
          this.permissionResolve?.(line);
          return;
        }
        if (this.state === "turn") {
          this.renderer.line(this.renderer.dim("(a turn is in flight; wait for it to end)"));
          rl.prompt();
          return;
        }
        if (!line) {
          rl.prompt();
          return;
        }
        this.state = "turn";
        currentTurn = this.sendPrompt(line).finally(() => {
          this.state = "idle";
          currentTurn = undefined;
          if (!this.closing) {
            rl.prompt();
          }
        });
      });
      rl.on("close", () => {
        this.closing = true;
        // stdin ended while a permission question was open: cancel it so the
        // turn can finish instead of hanging. closing also short-circuits any
        // question still queued behind it.
        this.permissionResolve?.("q");
        // Drain the in-flight turn (piped stdin hits EOF right after the
        // last line) before tearing the connection down.
        void Promise.resolve(currentTurn).finally(() => resolve());
      });
    });
  }

  /**
   * ACP session/request_permission handler. Queues behind any question
   * already on screen and answers them one at a time, in the order they
   * arrived, so a parallel pair of tool calls (or a whole backlog delivered
   * on attach) is all shown to the human rather than clobbering each other.
   */
  ask(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionsWaiting += 1;
    const answer = this.permissionQueue.then(
      () => this.askOne(params),
      () => this.askOne(params),
    );
    // Keep the chain alive whatever one question does, and never leave a
    // rejected promise unhandled on it.
    this.permissionQueue = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer.finally(() => {
      this.permissionsWaiting -= 1;
    });
  }

  /** Asks one permission question: options plus one choice. */
  private async askOne(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.closing) {
      // stdin is gone; nobody can answer, so do not hang the vendor's turn.
      return { outcome: { outcome: "cancelled" } };
    }
    this.renderer.ensureLine();
    const title = params.toolCall?.title ?? "the agent requests permission";
    const queued = this.permissionsWaiting - 1;
    const also = queued > 0 ? ` (${queued} more waiting)` : "";
    this.renderer.line(`permission requested: ${title}${also}`);
    const options = params.options;
    options.forEach((option, index) => {
      this.renderer.line(`  [${index + 1}] ${option.name} (${option.kind})`);
    });
    const previousState = this.state;
    this.state = "permission";
    try {
      for (;;) {
        const choice = await this.readChoice(options.length);
        if (choice === null) {
          this.renderer.line(this.renderer.dim("cancelled"));
          return { outcome: { outcome: "cancelled" } };
        }
        const option = options[choice];
        if (option) {
          this.renderer.line(this.renderer.dim(`chose: ${option.name}`));
          return { outcome: { outcome: "selected", optionId: option.optionId } };
        }
        this.renderer.line(`pick 1-${options.length}, or q to cancel`);
      }
    } finally {
      this.state = previousState === "permission" ? "idle" : previousState;
    }
  }

  /**
   * Reads one option choice: a raw single keypress on a TTY, one line
   * otherwise. Returns the zero-based option index, or null for cancel.
   */
  private async readChoice(optionCount: number): Promise<number | null> {
    const stdin = process.stdin;
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      process.stdout.write(`press 1-${optionCount}, or q to cancel: `);
      const key = await new Promise<string>((resolve) => {
        const wasRaw = stdin.isRaw === true;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.once("data", (buffer: Buffer) => {
          stdin.setRawMode(wasRaw);
          resolve(buffer.toString("utf8"));
        });
      });
      process.stdout.write("\n");
      // The keypress also lands in readline's edit buffer; clear it.
      this.rl?.write(null as unknown as string, { ctrl: true, name: "u" });
      if (key === "q" || key === "Q" || key === "\x03" || key === "\x1b") {
        return null;
      }
      const index = Number.parseInt(key, 10) - 1;
      return Number.isInteger(index) ? index : Number.NaN;
    }
    if (!this.rl) {
      // Piped stdin with no line loop (run -p from a script): nobody can
      // answer, so cancel instead of hanging the turn.
      this.renderer.line("no interactive input available; cancelling the permission request");
      return null;
    }
    const line = await new Promise<string>((resolve) => {
      this.permissionResolve = resolve;
    });
    this.permissionResolve = undefined;
    if (line === "q" || line === "Q" || line === "") {
      return null;
    }
    const index = Number.parseInt(line, 10) - 1;
    return Number.isInteger(index) ? index : Number.NaN;
  }
}
