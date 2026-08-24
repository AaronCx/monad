import type { IncomingMessage, ServerResponse } from "node:http";
import { createChecksMcpServer } from "@aaroncx/checks";
import { checkBearer, deriveMountToken, type SessionManager } from "@aaroncx/engine";

/**
 * Routes /mcp/<sessionId> to that session's checks MCP server.
 *
 * This route authenticates itself rather than riding the transport's blanket
 * daemon-token check, and it is mounted through the transport's
 * selfAuthenticated hook so that check never runs in front of it. Decision
 * record 0009: the vendor agent holds only this session's derived mount
 * token, so the daemon token must be REFUSED here (it opens /acp and /v1/*,
 * and an agent that could replay it from its own MCP config could create
 * sessions with an arbitrary cwd). Keeping the blanket check as well would
 * do the opposite of what is wanted: it admits the daemon token and rejects
 * the mount token.
 *
 * Auth is checked before the session lookup, so an unknown or closed session
 * id is not an oracle for anyone without the matching mount token. The mount
 * token derives from the daemon token plus the id alone, so it is checkable
 * with no record in hand.
 *
 * The binding is rebuilt from the session record per request (the transport
 * is stateless per decision record 0006), so the session's trust level is
 * re-read every time rather than captured once, which makes the mount survive
 * daemon restarts with no registry: any stored, non-closed session is
 * servable the moment the daemon is back up.
 */

export interface McpRouteDeps {
  manager: SessionManager;
  /**
   * The daemon token, used ONLY to derive each session's mount token. It is
   * never accepted as a credential on this route.
   */
  daemonToken: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** True when the pathname is an /mcp/<sessionId> mount. */
export function isMcpMountPath(pathname: string): boolean {
  return /^\/mcp\/[^/]+$/.test(pathname);
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
    const mountToken = deriveMountToken(deps.daemonToken, sessionId);
    if (!checkBearer(req.headers.authorization, mountToken)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="monad"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return true;
    }
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
      // Decision record 0009: an untrusted session's rules come from the PR
      // base (record.base), never from the worktree the PR controls, and the
      // executing fields are stripped from them either way.
      trust: record.trust,
      configRef: record.trust === "untrusted" ? record.base : undefined,
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
