import type { IncomingMessage, ServerResponse } from "node:http";
import { runReviewPlaybook, type SessionManager } from "@aaroncx/engine";
import {
  type DaemonStatus,
  type ListSessionsResponse,
  ReviewRequestSchema,
  type ReviewStreamLine,
  SetModeRequestSchema,
  type SetModeResponse,
} from "@aaroncx/protocol";

/**
 * The control API: plain JSON beside ACP for what the protocol does not
 * cover (cross-repo session listing, daemon introspection, the review
 * playbook, mode switches). Runs behind the same bearer check as /acp; the
 * transport wrapper calls this only for authenticated non-ACP paths.
 */

export interface ControlDeps {
  manager: SessionManager;
  version: string;
  startedAt: Date;
}

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  // codeql[js/stack-trace-exposure]: error text reaching here has been through
  // errorMessage (first line only, no stack frames, length capped), and this
  // server is loopback-only behind a bearer token, serving the same user who
  // ran the command. Reporting why a review failed is the point of the reply.
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The diagnostic monad shows the caller for a failed control request. The
 * control API is loopback-only behind a bearer token and its only client is
 * the user's own CLI, so the failure reason IS the product: "git fetch
 * origin main failed: ..." is what the user needs to see. What is never
 * shown is anything past it, so this keeps the first line only, drops any
 * line that looks like a stack frame, and caps the length. An Error's stack
 * is never read.
 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const cleaned = /^\s*at\s/.test(firstLine) ? "request failed" : firstLine.trim();
  return (cleaned || "request failed").slice(0, 500);
}

/**
 * POST /v1/review: runs the review playbook and streams ndjson, one line
 * per appended event as it happens, then exactly one result (or error)
 * line. The CLI renders events live and reads the verdict off the result.
 */
async function handleReview(
  deps: ControlDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: `unreadable body: ${errorMessage(error)}` });
    return;
  }
  const parsed = ReviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid review request: ${parsed.error.message}` });
    return;
  }
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const writeLine = (line: ReviewStreamLine) => {
    res.write(`${JSON.stringify(line)}\n`);
  };
  try {
    const result = await runReviewPlaybook(deps.manager, {
      repoRoot: parsed.data.repoRoot,
      pr: parsed.data.pr,
      full: parsed.data.full,
      noInstall: parsed.data.noInstall,
      onEvent: (event) => {
        writeLine({ type: "event", event });
      },
    });
    writeLine({
      type: "result",
      sessionId: result.sessionId,
      worktree: result.worktree,
      report: result.report,
      structured: result.structured,
      checksFailed: result.checksFailed,
      failed: result.failed,
      checksTable: result.checksTable,
      baseSha: result.baseSha,
      headSha: result.headSha,
    });
  } catch (error) {
    writeLine({ type: "error", message: errorMessage(error) });
  } finally {
    res.end();
  }
}

/**
 * POST /v1/sessions/<id>/mode: switches the stored session mode, swaps the
 * policy (the mode-aware policy reads the record at decision time), and
 * re-layers the vendor mode on any live backend. The CLI sends the
 * mode-switch user prompt itself, over ACP, so it lands as a prompt event.
 */
async function handleSetMode(
  deps: ControlDeps,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: `unreadable body: ${errorMessage(error)}` });
    return;
  }
  const parsed = SetModeRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid mode request: ${parsed.error.message}` });
    return;
  }
  if (!deps.manager.get(sessionId)) {
    sendJson(res, 404, { error: `no session ${sessionId}` });
    return;
  }
  try {
    const record = await deps.manager.setMode(sessionId, parsed.data.mode);
    const response: SetModeResponse = { session: record };
    sendJson(res, 200, response);
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) });
  }
}

export function createControlHandler(deps: ControlDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST") {
      if (pathname === "/v1/review") {
        void handleReview(deps, req, res);
        return;
      }
      const modeMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/mode$/);
      if (modeMatch) {
        void handleSetMode(deps, req, res, modeMatch[1] ?? "");
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
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
