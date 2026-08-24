/**
 * The ONLY module in the repo allowed to import the SDK's experimental
 * exports (repo rule, decision records 0001 and 0004). Everything else,
 * daemon and CLI included, imports from here so an SDK bump that moves the
 * experimental paths touches exactly one file.
 *
 * Liveness: the SDK only tears a connection down on an explicit HTTP DELETE
 * (dist/server.js handleDelete -> registry.remove -> shutdown). When a
 * client dies abruptly (SIGKILL, network drop) its SSE GET socket closes
 * without a DELETE; the SDK merely releases the mailbox lease
 * (dist/server-sse.js cancel -> lease.release) and the connection stays
 * registered forever with connection.closed never settling, so delegated
 * requests toward that client hang. Because the node:http server here is
 * ours, per-connection SSE sockets are observable: every SSE GET carries the
 * Acp-Connection-Id header (decision record 0004). We count live receivers
 * per connection id and, when a connection's receivers drop to zero and none
 * returns within a grace window, invoke the SDK's own DELETE teardown via a
 * synthetic request, which makes the death look exactly like a graceful
 * disconnect to everything above.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import {
  AcpServer,
  type AcpServerOptions,
} from "@agentclientprotocol/sdk/experimental/server";
import { checkBearer } from "../auth.ts";

// Client-side transport, re-exported for the CLI and tests so they never
// touch the experimental paths directly.
export {
  createHttpStream,
  MemoryAcpCookieStore,
  type AcpCookieStore,
  type HttpStreamOptions,
} from "@agentclientprotocol/sdk/experimental/http-client";

/** The agent connector shape AcpServer accepts (acp.agent(...) satisfies it). */
export type AcpAgentConnector = NonNullable<AcpServerOptions["agent"]>;

/**
 * Builds a fresh agent connector per accepted connection. The daemon uses
 * this so each client connection gets its own handler closure (subscriber
 * bookkeeping per connection) instead of one shared app instance.
 */
export type AcpAgentFactory = () => AcpAgentConnector;

export interface CreateAcpHttpServerOptions {
  /** Bearer token every request must carry. See packages/engine/src/auth.ts. */
  authToken: string;
  /** URL path serving ACP traffic. Default /acp. */
  path?: string;
  /** Passed through to the SDK's node handler (default 16 MiB). */
  maxRequestBodyBytes?: number;
  /**
   * Handles non-ACP requests (the /v1/* control API and the /mcp/<sessionId>
   * checks mounts). Runs after the bearer check unless the pathname matched
   * selfAuthenticated; absent, non-ACP paths get a 404.
   */
  fallback?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Pathnames the fallback authenticates by itself. A match SKIPS the
   * blanket daemon-token check and goes straight to the fallback, which must
   * refuse anything it does not recognize. Default deny: absent, every path
   * goes through the daemon-token check.
   *
   * /mcp/<sessionId> uses this because the daemon token is deliberately NOT
   * a credential there (decision record 0009): only that session's derived
   * mount token opens it, so a blanket check ahead of the route would both
   * admit the wrong token and reject the right one.
   */
  selfAuthenticated?: (pathname: string) => boolean;
  /**
   * How long (ms) a connection may sit with zero live SSE receivers before
   * it is declared dead and torn down (default 3000). Reconnecting SSE
   * within the window keeps the connection alive. Injectable for tests.
   */
  sseGraceMs?: number;
  /**
   * Called after a dead connection (SSE gone, no DELETE, grace elapsed) has
   * been torn down. Not called for connections that closed gracefully.
   */
  onConnectionDead?: (connectionId: string) => void;
}

const DEFAULT_SSE_GRACE_MS = 3000;
const CONNECTION_ID_HEADER = "acp-connection-id";

export interface AcpHttpServer {
  /** Binds and starts serving. Host defaults to loopback (M1 is loopback only). */
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  /** Ends every ACP connection (closing SSE streams) and stops the server. */
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Wraps AcpServer + createNodeHttpHandler (the setup validated under Bun in
 * decision record 0004) behind listen/close, with the bearer token check in
 * front of the handler.
 */
export function createAcpHttpServer(
  agent: AcpAgentConnector | AcpAgentFactory,
  options: CreateAcpHttpServerOptions,
): AcpHttpServer {
  const acpPath = options.path ?? "/acp";
  // A plain function is a per-connection factory; an object is one shared
  // connector (an AgentApp instance is an object with a connect method).
  const acpServer = new AcpServer(
    typeof agent === "function" ? { createAgent: agent } : { agent },
  );
  const handleAcp = createNodeHttpHandler(
    acpServer,
    options.maxRequestBodyBytes === undefined
      ? undefined
      : { maxRequestBodyBytes: options.maxRequestBodyBytes },
  );

  // SSE liveness bookkeeping (see the module comment). Counts are keyed by
  // connection id; increments and decrements are symmetric per GET, so
  // rejected acquires (404/406/409) cannot corrupt the count.
  const sseGraceMs = options.sseGraceMs ?? DEFAULT_SSE_GRACE_MS;
  const sseReceivers = new Map<string, number>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let serverClosed = false;

  function reapConnection(connectionId: string): void {
    graceTimers.delete(connectionId);
    if (serverClosed) {
      return;
    }
    // The SDK's own teardown: exactly what a client's HTTP DELETE triggers
    // (registry.remove -> shutdown), so connection.closed settles and every
    // in-flight request delegated to this client rejects.
    void acpServer
      .handleRequest(
        new Request(`http://127.0.0.1${acpPath}`, {
          method: "DELETE",
          headers: { "Acp-Connection-Id": connectionId },
        }),
      )
      .then((response) => {
        // 202: the connection was still registered, a real abrupt death.
        // 404: it already closed gracefully; nothing to report.
        if (response.status === 202) {
          options.onConnectionDead?.(connectionId);
        }
      })
      .catch(() => {});
  }

  function trackSseReceiver(connectionId: string, req: IncomingMessage, res: ServerResponse): void {
    const pendingReap = graceTimers.get(connectionId);
    if (pendingReap !== undefined) {
      clearTimeout(pendingReap);
      graceTimers.delete(connectionId);
    }
    sseReceivers.set(connectionId, (sseReceivers.get(connectionId) ?? 0) + 1);
    let gone = false;
    const onGone = (): void => {
      if (gone) {
        return;
      }
      gone = true;
      res.off("close", onGone);
      req.socket.off("close", onGone);
      // Bun (1.3.10) does not emit res "close" when the socket dies
      // abruptly, so the SDK's node adapter never cancels the SSE body
      // reader and the mailbox lease stays held, blocking re-acquires with
      // 409. Destroying the response emits the missing "close" (verified by
      // probe); after a normally completed response this is a no-op.
      if (!res.writableEnded && !res.destroyed) {
        res.destroy();
      }
      const remaining = (sseReceivers.get(connectionId) ?? 1) - 1;
      if (remaining > 0) {
        sseReceivers.set(connectionId, remaining);
        return;
      }
      sseReceivers.delete(connectionId);
      if (serverClosed) {
        return;
      }
      graceTimers.set(
        connectionId,
        setTimeout(() => reapConnection(connectionId), sseGraceMs),
      );
    };
    // res "close" covers normal completion (and, on Node, socket death); the
    // socket listener covers abrupt deaths Bun surfaces only on the socket.
    // onGone is idempotent and detaches both listeners, so keep-alive
    // sockets serving many requests do not accumulate handlers.
    res.once("close", onGone);
    req.socket.once("close", onGone);
  }

  const nodeServer: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (options.selfAuthenticated?.(pathname) === true) {
      if (options.fallback) {
        options.fallback(req, res);
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!checkBearer(req.headers.authorization, options.authToken)) {
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="monad"' });
      return;
    }
    if (pathname === acpPath) {
      if (req.method === "GET") {
        const connectionId = req.headers[CONNECTION_ID_HEADER];
        if (typeof connectionId === "string" && connectionId.length > 0) {
          trackSseReceiver(connectionId, req, res);
        }
      }
      handleAcp(req, res);
      return;
    }
    if (options.fallback) {
      options.fallback(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  return {
    listen(port: number, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        nodeServer.once("error", reject);
        nodeServer.listen(port, host, () => {
          nodeServer.removeListener("error", reject);
          const address = nodeServer.address();
          if (address === null || typeof address === "string") {
            reject(new Error("unexpected server address"));
            return;
          }
          resolve({ port: address.port, host: address.address });
        });
      });
    },
    async close() {
      serverClosed = true;
      for (const timer of graceTimers.values()) {
        clearTimeout(timer);
      }
      graceTimers.clear();
      sseReceivers.clear();
      // Close ACP connections first so held SSE responses end; otherwise
      // nodeServer.close() would wait on them forever.
      await acpServer.close();
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => (error ? reject(error) : resolve()));
        nodeServer.closeAllConnections();
      });
    },
  };
}
