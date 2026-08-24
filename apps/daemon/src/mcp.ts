import type { IncomingMessage, ServerResponse } from "node:http";
import { createChecksMcpServer } from "@aaroncx/checks";
import type { SessionManager } from "@aaroncx/engine";

/**
 * Routes /mcp/<sessionId> to that session's checks MCP server. Mounted
 * inside the daemon's authenticated fallback, so every request here already
 * passed the same bearer check as /acp.
 *
 * The binding is rebuilt from the session record per request (the transport
 * is stateless per decision record 0006), which makes the mount survive
 * daemon restarts with no registry: any stored, non-closed session is
 * servable the moment the daemon is back up.
 */

export interface McpRouteDeps {
  manager: SessionManager;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Returns true when the request was an /mcp/* request and has been handled
 * (or refused); false hands the request to the next fallback handler.
 */
export function createMcpRoute(deps: McpRouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      return false;
    }
    const sessionId = match[1] ?? "";
    const record = deps.manager.get(sessionId);
    if (!record || record.status === "closed") {
      sendJson(res, 404, { error: `no open session ${sessionId}` });
      return true;
    }
    const server = createChecksMcpServer({
      cwd: record.cwd,
      base: record.base,
      head: record.head,
      sessionId: record.id,
    });
    void server.handleRequest(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(error) });
      } else {
        res.end();
      }
    });
    return true;
  };
}
