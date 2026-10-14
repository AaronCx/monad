import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer, deriveSessionsMountToken, type SessionManager } from "@aaroncx/engine";
import { createSessionsMcpServer, type LinkService } from "@aaroncx/link";

/**
 * Routes /mcp-sessions/<sessionId> to that session's monad-sessions MCP
 * server (monad Link, decision record 0012). A copy of the /mcp/<id> checks
 * mount (mcp.ts, decision record 0009) with its own credential:
 *
 * - self-authenticating, mounted through the transport's selfAuthenticated
 *   hook so the blanket daemon-token check never runs in front of it;
 * - the bearer is checked BEFORE the session lookup, against
 *   HMAC-SHA256(daemonToken, "sessions-mount:" + id). The daemon token is
 *   refused, the session's checks mount token is refused (different label),
 *   and another session's sessions token is refused (different id);
 * - stateless per request: the record is re-read every time, so a session
 *   that is closed, imported, untrusted, out of link.json's scope or in a
 *   mode with fewer tools is answered as it is NOW.
 *
 * An untrusted session never has the entry in its vendor config at all
 * (packages/backends), so the 403 here is defense in depth: the derived
 * token exists for every id, and anyone who can read ~/.monad/token could
 * compute one, so the route must not treat a correct token as permission.
 */

export interface SessionsMcpRouteDeps {
  manager: SessionManager;
  link: LinkService;
  /** Used ONLY to derive each session's sessions-mount token. */
  daemonToken: string;
}

const MOUNT = /^\/mcp-sessions\/([^/]+)$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** True when the pathname is an /mcp-sessions/<sessionId> mount. */
export function isSessionsMountPath(pathname: string): boolean {
  return MOUNT.test(pathname);
}

/**
 * Returns true when the request was an /mcp-sessions/* request and has been
 * handled (or refused); false hands it to the next fallback handler.
 */
export function createSessionsMcpRoute(deps: SessionsMcpRouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = pathname.match(MOUNT);
    if (!match) {
      return false;
    }
    const sessionId = match[1] ?? "";
    if (!checkBearer(req.headers.authorization, deriveSessionsMountToken(deps.daemonToken, sessionId))) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="monad"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return true;
    }
    const record = deps.manager.get(sessionId);
    if (!record || record.status === "closed" || record.status === "imported") {
      sendJson(res, 404, { error: `no open session ${sessionId}` });
      return true;
    }
    if (!deps.link.mountAllowed(record)) {
      sendJson(res, 403, { error: `session ${sessionId} has no monad-sessions access` });
      return true;
    }
    const server = createSessionsMcpServer({ service: deps.link, sessionId: record.id });
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
