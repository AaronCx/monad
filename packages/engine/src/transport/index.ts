/**
 * The ONLY module in the repo allowed to import the SDK's experimental
 * exports (repo rule, decision records 0001 and 0004). Everything else,
 * daemon and CLI included, imports from here so an SDK bump that moves the
 * experimental paths touches exactly one file.
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

export interface CreateAcpHttpServerOptions {
  /** Bearer token every request must carry. See packages/engine/src/auth.ts. */
  authToken: string;
  /** URL path serving ACP traffic. Default /acp. */
  path?: string;
  /** Passed through to the SDK's node handler (default 16 MiB). */
  maxRequestBodyBytes?: number;
  /**
   * Handles authenticated non-ACP requests (the /v1/* control API).
   * Runs after the bearer check; absent, non-ACP paths get a 404.
   */
  fallback?: (req: IncomingMessage, res: ServerResponse) => void;
}

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
  agent: AcpAgentConnector,
  options: CreateAcpHttpServerOptions,
): AcpHttpServer {
  const acpPath = options.path ?? "/acp";
  const acpServer = new AcpServer({ agent });
  const handleAcp = createNodeHttpHandler(
    acpServer,
    options.maxRequestBodyBytes === undefined
      ? undefined
      : { maxRequestBodyBytes: options.maxRequestBodyBytes },
  );

  const nodeServer: Server = createServer((req, res) => {
    if (!checkBearer(req.headers.authorization, options.authToken)) {
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="monad"' });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === acpPath) {
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
