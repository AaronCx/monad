import {
  type AgentConnection,
  type AgentContext,
  agent,
  methods,
  PROTOCOL_VERSION,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { SessionClient, SessionManager } from "@aaroncx/engine";
import type { AcpAgentFactory } from "@aaroncx/engine/transport";
import {
  ERROR_NOTIFICATION_METHOD,
  type ErrorPayload,
  type EventRecord,
  REPLAY_COUNT_META_KEY,
  SESSION_STATUS_META_KEY,
} from "@aaroncx/protocol";

/**
 * The agent side of the daemon: monadd as an ACP agent toward its own
 * clients (the CLI, editors through acp-stdio, later phones).
 *
 * One agent app instance is built per accepted HTTP connection (the
 * transport's per-connection factory), so each connection owns its own
 * subscriber bookkeeping. Replay ordering leans on that: session/load
 * subscribes and snapshots the log in one synchronous step, then enqueues
 * the replay notifications before control returns to the event loop, so no
 * live event can jump ahead of the replay on this connection's stream.
 */

export interface DaemonAgentDeps {
  manager: SessionManager;
  version: string;
}

/**
 * One (connection, session) subscriber. Translates engine events into ACP
 * traffic for this connection and serializes every outbound notification
 * through a FIFO chain so replay and live updates keep log order.
 */
class ConnectionSessionClient implements SessionClient {
  private readonly cx: AgentContext;
  private readonly sessionId: string;
  private chain: Promise<void> = Promise.resolve();
  /** The prompt params this connection itself sent, to skip the echo. */
  private ownPrompt: unknown;

  constructor(cx: AgentContext, sessionId: string) {
    this.cx = cx;
    this.sessionId = sessionId;
  }

  markOwnPrompt(params: PromptRequest): void {
    this.ownPrompt = params;
  }

  clearOwnPrompt(params: PromptRequest): void {
    if (this.ownPrompt === params) {
      this.ownPrompt = undefined;
    }
  }

  /** Forwards one session/update notification (payloads stay verbatim). */
  sendUpdate(params: SessionNotification): void {
    this.enqueue(() => this.cx.notify(methods.client.session.update, params));
  }

  /**
   * Renders a logged prompt as user_message_chunk updates, one per content
   * block, exactly like the replay path counts them.
   */
  sendPromptAsUserChunks(params: PromptRequest): void {
    for (const block of params.prompt) {
      this.sendUpdate({
        sessionId: this.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: block },
      });
    }
  }

  /** Forwards an error event on monad's extension notification method. */
  sendError(payload: ErrorPayload): void {
    this.enqueue(() =>
      this.cx.notify(ERROR_NOTIFICATION_METHOD, { ...payload, sessionId: this.sessionId }),
    );
  }

  /**
   * Resolves once every notification enqueued so far has been written.
   * The prompt handler awaits this before returning so the prompt response
   * (same session SSE stream) never overtakes the turn's trailing updates.
   */
  flush(): Promise<void> {
    return this.chain;
  }

  onEvent(event: EventRecord): void {
    switch (event.kind) {
      case "update":
        this.sendUpdate(event.payload as SessionNotification);
        return;
      case "prompt": {
        if (event.payload === this.ownPrompt) {
          // This connection sent the prompt; it does not need the echo.
          this.ownPrompt = undefined;
          return;
        }
        this.sendPromptAsUserChunks(event.payload as PromptRequest);
        return;
      }
      case "error":
        this.sendError(event.payload as ErrorPayload);
        return;
      default:
        // session_created, permission_*, turn_ended, closed have no live ACP
        // representation toward clients; permission requests go through
        // requestPermission and turn ends ride the prompt response.
        return;
    }
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.cx.request(methods.client.session.requestPermission, params);
  }

  private enqueue(op: () => Promise<void>): void {
    // Dead connections reject; the engine drops this client on close.
    this.chain = this.chain.then(op).catch(() => {});
  }
}

/** Per-connection subscriber bookkeeping, cleaned up when the client drops. */
class DaemonConnection {
  private readonly manager: SessionManager;
  private readonly clients = new Map<string, ConnectionSessionClient>();
  private context?: AgentContext;
  private disposed = false;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  bind(connection: AgentConnection): void {
    this.context = connection.client;
    connection.closed.finally(() => this.dispose()).catch(() => {});
  }

  clientFor(sessionId: string): ConnectionSessionClient | undefined {
    return this.clients.get(sessionId);
  }

  /**
   * Subscribes this connection to a session: creates the client, attaches it
   * (atomic snapshot plus live subscription, re-delivering any held
   * permission request), and returns the snapshot for replay.
   */
  subscribe(
    sessionId: string,
    requestContext: AgentContext,
  ): { client: ConnectionSessionClient; events: EventRecord[] } {
    const existing = this.clients.get(sessionId);
    if (existing) {
      this.manager.detach(sessionId, existing);
      this.clients.delete(sessionId);
    }
    const client = new ConnectionSessionClient(this.context ?? requestContext, sessionId);
    const { events } = this.manager.attach(sessionId, client);
    this.clients.set(sessionId, client);
    return { client, events };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [sessionId, client] of this.clients) {
      this.manager.detach(sessionId, client);
    }
    this.clients.clear();
  }
}

/**
 * Builds the per-connection agent factory handed to createAcpHttpServer.
 * Verified 1.4.0 initialize shape: loadSession plus
 * sessionCapabilities.list: {} advertises session/list (see the SDK's
 * dist/schema/types.gen.d.ts, AgentCapabilities and SessionCapabilities).
 */
export function createDaemonAgentFactory(deps: DaemonAgentDeps): AcpAgentFactory {
  return () => {
    const conn = new DaemonConnection(deps.manager);
    return agent({ name: "monadd" })
      .onConnect((connection) => {
        conn.bind(connection);
      })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "monadd", version: deps.version },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }))
      .onRequest(methods.agent.session.new, async (ctx) => {
        const record = await deps.manager.create({ cwd: ctx.params.cwd });
        const { client, events } = conn.subscribe(record.id, ctx.client);
        // Updates the backend emitted while starting (the vendor fires an
        // available_commands_update during session/new) are already in the
        // log; deliver them so the creating client sees vendor behavior.
        for (const event of events) {
          if (event.kind === "update") {
            client.sendUpdate(event.payload as SessionNotification);
          }
        }
        return { sessionId: record.id };
      })
      .onRequest(methods.agent.session.load, (ctx) => {
        const sessionId = ctx.params.sessionId;
        // attach() subscribes and snapshots in one synchronous step, and the
        // replay below enqueues before control returns to the event loop, so
        // live events cannot interleave into the replay on this connection.
        const { client, events } = conn.subscribe(sessionId, ctx.client);
        let replayCount = 0;
        for (const event of events) {
          if (event.kind === "update") {
            client.sendUpdate(event.payload as SessionNotification);
            replayCount += 1;
          } else if (event.kind === "prompt") {
            const prompt = event.payload as PromptRequest;
            client.sendPromptAsUserChunks(prompt);
            replayCount += prompt.prompt.length;
          } else if (event.kind === "error") {
            // Extension notifications do not count toward the replay
            // divider; clients count session/update notifications only.
            client.sendError(event.payload as ErrorPayload);
          }
        }
        return { _meta: { [REPLAY_COUNT_META_KEY]: replayCount } };
      })
      .onRequest(methods.agent.session.list, () => ({
        sessions: deps.manager.list().map((record) => ({
          sessionId: record.id,
          cwd: record.cwd,
          updatedAt: record.updatedAt,
          _meta: { [SESSION_STATUS_META_KEY]: record.status },
        })),
      }))
      .onRequest(methods.agent.session.prompt, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        const client = conn.clientFor(sessionId) ?? conn.subscribe(sessionId, ctx.client).client;
        client.markOwnPrompt(ctx.params);
        try {
          const response = await deps.manager.prompt(sessionId, ctx.params, client);
          await client.flush();
          return response;
        } finally {
          client.clearOwnPrompt(ctx.params);
        }
      })
      .onNotification(methods.agent.session.cancel, async (ctx) => {
        await deps.manager.cancel(ctx.params.sessionId);
      });
  };
}
