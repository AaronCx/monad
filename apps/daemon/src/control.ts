import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "@aaroncx/engine";
import type { DaemonStatus, ListSessionsResponse } from "@aaroncx/protocol";

/**
 * The control API: plain JSON beside ACP for what the protocol does not
 * cover (cross-repo session listing, daemon introspection). Runs behind the
 * same bearer check as /acp; the transport wrapper calls this only for
 * authenticated non-ACP paths.
 */

export interface ControlDeps {
  manager: SessionManager;
  version: string;
  startedAt: Date;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createControlHandler(deps: ControlDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (pathname === "/v1/sessions") {
      const body: ListSessionsResponse = { sessions: deps.manager.list() };
      sendJson(res, 200, body);
      return;
    }
    if (pathname === "/v1/status") {
      const body: DaemonStatus = {
        version: deps.version,
        startedAt: deps.startedAt.toISOString(),
        uptimeMs: Math.max(0, Date.now() - deps.startedAt.getTime()),
        activeBackends: deps.manager.activeBackends(),
      };
      sendJson(res, 200, body);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  };
}
