import type { FileSink, Subprocess } from "bun";
import {
  client,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { BackendHooks, SessionBackend } from "@aaroncx/engine";
import type { SessionId, SessionMode } from "@aaroncx/protocol";

/**
 * The vendor session mode each monad mode layers on (decision 0007): review
 * runs in plan mode (the vendor's own read-only discipline under monad's
 * review policy); fix stays in default so monad's policy is the thing
 * granting each edit and the transcript shows every grant.
 */
export const VENDOR_MODE_FOR: Record<SessionMode, string> = {
  interactive: "default",
  review: "plan",
  fix: "default",
};

/**
 * Wraps a Bun.spawn stdin FileSink into the WritableStream ndJsonStream
 * expects. Bun's spawn gives a FileSink, not a web WritableStream, so every
 * write is flushed immediately and close maps to end (decision record 0005).
 */
function fileSinkToWritable(sink: FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
    close() {
      sink.end();
    },
    abort() {
      sink.end();
    },
  });
}

export interface AcpClientBackendOptions {
  /**
   * argv of the vendor ACP agent, absolute paths preferred. The child is
   * spawned once per monad session and owns exactly one vendor session.
   */
  command: string[];
  /** Working directory for the child process and for session/new. */
  cwd: string;
  /** monad's session id; every outbound event is rewritten to carry it. */
  monadSessionId: SessionId;
  /** Engine callbacks: verbatim update append, permission policy, restore. */
  hooks: BackendHooks;
  /**
   * Child environment. Callers pass a deliberate minimal env (HOME + PATH);
   * vendor credentials live inside the vendor's own binary and files, monad
   * never handles tokens.
   */
  env?: Record<string, string | undefined>;
  /** Where child stderr goes. The vendor keeps stdout pure ACP. */
  stderr?: "inherit" | "ignore";
}

const HOW_LONG_TO_WAIT_FOR_EXIT_MS = 3000;

/**
 * ACP client side of the daemon: one spawned vendor agent subprocess per
 * session, stdio wrapped in ndJsonStream, driven through the SDK's stable
 * client() builder API.
 *
 * Session id rewriting happens here and only here (the engine never touches
 * ids): inbound session/update and session/request_permission are rewritten
 * vendor id -> monad id before they reach the engine, outbound
 * session/prompt and session/cancel are rewritten monad id -> vendor id.
 */
export class AcpClientBackend implements SessionBackend {
  private readonly options: AcpClientBackendOptions;
  private readonly proc: Subprocess<"pipe", "pipe", "inherit" | "ignore">;
  private connection!: ClientConnection;
  private init!: InitializeResponse;
  private vendorSessionId?: string;
  /**
   * True while a vendor session/load runs. The vendor replays its own history
   * as session/update notifications during load; monad's event log already
   * holds that history, so replayed updates are dropped instead of appended
   * twice. Over stdio the load response arrives strictly after the replayed
   * notifications, so clearing the flag when load resolves is safe.
   */
  private restoring = false;
  private closed = false;

  private constructor(
    options: AcpClientBackendOptions,
    proc: Subprocess<"pipe", "pipe", "inherit" | "ignore">,
  ) {
    this.options = options;
    this.proc = proc;
  }

  /** Spawns the vendor agent, connects, and runs initialize. */
  static async start(options: AcpClientBackendOptions): Promise<AcpClientBackend> {
    const proc = Bun.spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: options.stderr ?? "inherit",
    });
    const backend = new AcpClientBackend(options, proc);
    const stream = ndJsonStream(fileSinkToWritable(proc.stdin), proc.stdout);
    backend.connection = client({ name: "monad-daemon" })
      .onNotification(methods.client.session.update, (ctx) => {
        backend.handleUpdate(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        backend.handlePermission(ctx.params),
      )
      .connect(stream);
    try {
      backend.init = await backend.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // M1: the agent performs its own file and shell operations in cwd;
        // monad exposes no client-side fs or terminal to it.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
    return backend;
  }

  /** The vendor's initialize response, verbatim. */
  get initializeResponse(): InitializeResponse {
    return this.init;
  }

  /** The vendor-side session id, once session/new or session/load ran. */
  get agentSessionId(): string | undefined {
    return this.vendorSessionId;
  }

  supportsLoadSession(): boolean {
    return this.init.agentCapabilities?.loadSession === true;
  }

  /**
   * Creates a fresh vendor session in cwd and records its id through
   * hooks.setAgentSessionId for restore-on-restart. `mcpServers` becomes
   * part of the vendor's session fingerprint (decision record 0006 fact 3),
   * so the restore path must pass the identical array.
   */
  async newSession(mcpServers: McpServer[] = []): Promise<string> {
    const response = await this.connection.agent.request(methods.agent.session.new, {
      cwd: this.options.cwd,
      mcpServers,
    });
    this.vendorSessionId = response.sessionId;
    this.options.hooks.setAgentSessionId(response.sessionId);
    return response.sessionId;
  }

  /**
   * Restores an existing vendor session after a daemon restart. Replayed
   * updates the vendor streams during load are dropped (see `restoring`).
   * Throws if the vendor rejects the load; callers decide what a failed
   * restore means (packages/backends/src/claude.ts never degrades silently).
   */
  async loadSession(agentSessionId: string, mcpServers: McpServer[] = []): Promise<void> {
    this.restoring = true;
    try {
      await this.connection.agent.request(methods.agent.session.load, {
        sessionId: agentSessionId,
        cwd: this.options.cwd,
        mcpServers,
      });
      this.vendorSessionId = agentSessionId;
    } finally {
      this.restoring = false;
    }
  }

  /**
   * Applies a monad mode's vendor layer via session/set_mode. Decision 0007
   * fact 4: a client-initiated set_mode returns an empty response and emits
   * NO current_mode_update; the empty acknowledgment IS success, so nothing
   * here waits for a mode notification.
   */
  async setSessionMode(mode: SessionMode): Promise<void> {
    await this.connection.agent.request(methods.agent.session.setMode, {
      sessionId: this.requireVendorSessionId(),
      modeId: VENDOR_MODE_FOR[mode],
    });
  }

  /** Forwards one prompt turn, rewriting monad id -> vendor id. */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return await this.connection.agent.request(methods.agent.session.prompt, {
      ...params,
      sessionId: this.requireVendorSessionId(),
    });
  }

  /** Cancels the in-flight turn (fire-and-forget notification per ACP). */
  async cancel(): Promise<void> {
    if (!this.vendorSessionId) {
      return;
    }
    await this.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.vendorSessionId,
    });
  }

  /** Closes the connection and reaps the child (SIGKILL after a grace period). */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connection?.close();
    this.proc.kill();
    const killTimer = setTimeout(() => {
      this.proc.kill("SIGKILL");
    }, HOW_LONG_TO_WAIT_FOR_EXIT_MS);
    try {
      await this.proc.exited;
    } finally {
      clearTimeout(killTimer);
    }
  }

  private handleUpdate(params: SessionNotification): void {
    if (this.restoring) {
      return;
    }
    // Verbatim payload, monad's session id. available_commands_update and
    // usage_update pass through untouched like every other kind.
    this.options.hooks.onUpdate({ ...params, sessionId: this.options.monadSessionId });
  }

  private handlePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.options.hooks.requestPermission({
      ...params,
      sessionId: this.options.monadSessionId,
    });
  }

  private requireVendorSessionId(): string {
    if (!this.vendorSessionId) {
      throw new Error(
        "no vendor session established; call newSession() or loadSession() first",
      );
    }
    return this.vendorSessionId;
  }
}
