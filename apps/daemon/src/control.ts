import type { IncomingMessage, ServerResponse } from "node:http";
import { runReviewPlaybook, type SessionManager } from "@aaroncx/engine";
import { LinkError, type LinkErrorCode, type LinkService } from "@aaroncx/link";
import {
  AppendNoteRequestSchema,
  type AppendNoteResponse,
  type DaemonStatus,
  HandoffRequestSchema,
  type HandoffResponse,
  type ListSessionsResponse,
  type NotesResponse,
  ReviewRequestSchema,
  type ReviewStreamLine,
  type SearchResponse,
  SendMessageRequestSchema,
  type SendMessageResponse,
  type SessionRecord,
  SessionStatusSchema,
  SetModeRequestSchema,
  type SetModeResponse,
  type TranscriptResponse,
  UpdateSessionRequestSchema,
  type UpdateSessionResponse,
} from "@aaroncx/protocol";

/**
 * The control API: plain JSON beside ACP for what the protocol does not
 * cover (cross-repo session listing, daemon introspection, the review
 * playbook, mode switches, session titles, and monad Link's search, read,
 * send, handoffs and repo notes for the human at the CLI). Runs behind the same bearer check as /acp;
 * the transport wrapper calls this only for authenticated non-ACP paths.
 */

export interface ControlDeps {
  manager: SessionManager;
  /**
   * monad Link (decision record 0012). The routes below call it with the
   * human as the caller, through the same service the monad-sessions MCP
   * server uses, so the CLI (and later the phone) gets exactly an agent's
   * reach plus the human's privileges, and nothing a separate code path
   * could get wrong.
   */
  link: LinkService;
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
      trust: parsed.data.trust,
      install: parsed.data.install,
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
      trust: result.trust,
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

/**
 * PATCH /v1/sessions/<id>: names a session by hand ({ title: "..." }) or
 * drops the manual name and re-derives it from the first prompt
 * ({ title: null }). A manual title is never overwritten by derivation
 * (monad Link, decision record 0012). Titles are metadata, not activity, so
 * updatedAt does not move.
 */
async function handleUpdateSession(
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
  const parsed = UpdateSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid session update: ${parsed.error.message}` });
    return;
  }
  if (!deps.manager.get(sessionId)) {
    sendJson(res, 404, { error: `no session ${sessionId}` });
    return;
  }
  try {
    // Whitespace runs (newlines included) collapse to one space: a title is
    // one line wherever it is shown.
    const title = parsed.data.title === null ? null : parsed.data.title.replace(/\s+/g, " ");
    const response: UpdateSessionResponse = {
      session: deps.manager.setTitle(sessionId, title),
    };
    sendJson(res, 200, response);
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) });
  }
}

const LINK_ERROR_STATUS: Record<LinkErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  refused: 409,
  rate_limited: 429,
  unavailable: 503,
};

/** A Link refusal as its HTTP status; anything else is a 500. */
function sendLinkError(res: ServerResponse, error: unknown): void {
  if (error instanceof LinkError) {
    sendJson(res, LINK_ERROR_STATUS[error.code], { error: errorMessage(error), code: error.code });
    return;
  }
  sendJson(res, 500, { error: errorMessage(error) });
}

/** An optional integer query parameter; absent or blank is undefined. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  return Number(raw);
}

const LIST_FILTERS = ["repo", "status", "since", "limit", "imported"];

/**
 * GET /v1/sessions. With no Link filter, every record oldest first (the M1
 * contract `monad attach` and `monad gc` rely on), plus each one's last
 * handoff line. With any of repo, status,
 * since, limit or imported, the Link list: filtered, most recently active
 * first, with each session's repos. imported=0 hides imported logs (the
 * default `monad ls`); anything else includes them.
 */
function handleListSessions(deps: ControlDeps, res: ServerResponse, params: URLSearchParams): void {
  if (!LIST_FILTERS.some((name) => params.has(name))) {
    const sessions = deps.manager.list();
    // Each session's last handoff line rides along (an optional field the M1
    // clients ignore), so plain `monad ls` shows where every session stands.
    const handoffs: Record<string, string> = {};
    for (const session of sessions) {
      const line = deps.link.lastHandoffLine(session.id);
      if (line !== undefined) {
        handoffs[session.id] = line;
      }
    }
    const body: ListSessionsResponse = {
      sessions,
      ...(Object.keys(handoffs).length === 0 ? {} : { handoffs }),
    };
    sendJson(res, 200, body);
    return;
  }
  const status = params.get("status") ?? undefined;
  if (status !== undefined && !SessionStatusSchema.safeParse(status).success) {
    sendJson(res, 400, { error: `unknown status ${status}` });
    return;
  }
  try {
    const summaries = deps.link.list(
      { kind: "human" },
      {
        repo: params.get("repo") ?? undefined,
        status: status as SessionRecord["status"] | undefined,
        since: params.get("since") ?? undefined,
        limit: intParam(params, "limit"),
        includeImported: params.get("imported") !== "0",
      },
    );
    const sessions = summaries
      .map((summary) => deps.manager.get(summary.id))
      .filter((record): record is SessionRecord => record !== undefined);
    const handoffs = summaries.filter((summary) => summary.lastHandoff !== undefined);
    const body: ListSessionsResponse = {
      sessions,
      repos: Object.fromEntries(summaries.map((summary) => [summary.id, summary.repos])),
      ...(handoffs.length === 0
        ? {}
        : { handoffs: Object.fromEntries(handoffs.map((summary) => [summary.id, summary.lastHandoff as string])) }),
    };
    sendJson(res, 200, body);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/** GET /v1/search?q=&repo=&since=&limit=: Link search, the human as caller. */
function handleSearch(deps: ControlDeps, res: ServerResponse, params: URLSearchParams): void {
  const query = params.get("q");
  if (query === null || query.trim() === "") {
    sendJson(res, 400, { error: "q is required" });
    return;
  }
  try {
    const body: SearchResponse = {
      hits: deps.link.search({ kind: "human" }, query, {
        repo: params.get("repo") ?? undefined,
        since: params.get("since") ?? undefined,
        limit: intParam(params, "limit"),
      }),
    };
    sendJson(res, 200, body);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/** GET /v1/sessions/<id>/transcript?from=&limit=: one redacted page. */
function handleTranscript(
  deps: ControlDeps,
  res: ServerResponse,
  sessionId: string,
  params: URLSearchParams,
): void {
  try {
    const page = deps.link.read({ kind: "human" }, sessionId, {
      fromSeq: intParam(params, "from"),
      limit: intParam(params, "limit"),
    });
    const body: TranscriptResponse = {
      sessionId: page.sessionId,
      ...(page.title === undefined ? {} : { title: page.title }),
      text: page.text,
      entries: page.entries.length,
      fromSeq: page.fromSeq,
      toSeq: page.toSeq,
      nextFromSeq: page.nextFromSeq,
    };
    sendJson(res, 200, body);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/** POST /v1/sessions/<id>/messages: the human sends a peer message. */
async function handleSendMessage(
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
  const parsed = SendMessageRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid message: ${parsed.error.message}` });
    return;
  }
  try {
    const response: SendMessageResponse = deps.link.message({ kind: "human" }, sessionId, parsed.data.text);
    sendJson(res, 200, response);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/**
 * POST /v1/sessions/<id>/handoff: writes a fresh deterministic handoff
 * (reason manual) and returns it; with { summarize: true } also runs the
 * model-written summary, which spends vendor tokens and so only ever runs
 * on a request like this (or the sessions_summarize tool). The response
 * waits for the summary.
 */
async function handleHandoff(
  deps: ControlDeps,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (error) {
    sendJson(res, 400, { error: `unreadable body: ${errorMessage(error)}` });
    return;
  }
  const parsed = HandoffRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid handoff request: ${parsed.error.message}` });
    return;
  }
  try {
    const result = await deps.link.handoff({ kind: "human" }, sessionId, { summarize: parsed.data.summarize });
    const payload = result.handoff.payload as { reason: HandoffResponse["handoff"]["reason"]; text: string };
    const response: HandoffResponse = {
      sessionId: result.sessionId,
      handoff: { seq: result.handoff.seq, ts: result.handoff.ts, reason: payload.reason, text: payload.text },
      ...(result.summary
        ? {
            summary: {
              seq: result.summary.seq,
              ts: result.summary.ts,
              text: result.summary.text,
              summarizerSessionId: result.summary.summarizerSessionId,
            },
          }
        : {}),
    };
    sendJson(res, 200, response);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/** GET /v1/notes?repo=P: a repository's notes, the human as reader. */
function handleReadNotes(deps: ControlDeps, res: ServerResponse, params: URLSearchParams): void {
  const repo = params.get("repo");
  if (repo === null || repo.trim() === "") {
    sendJson(res, 400, { error: "repo is required" });
    return;
  }
  try {
    const body: NotesResponse = deps.link.notesRead({ kind: "human" }, repo);
    sendJson(res, 200, body);
  } catch (error) {
    sendLinkError(res, error);
  }
}

/** POST /v1/notes { repo, text }: the human writes a note. */
async function handleAppendNote(deps: ControlDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: `unreadable body: ${errorMessage(error)}` });
    return;
  }
  const parsed = AppendNoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: `invalid note: ${parsed.error.message}` });
    return;
  }
  try {
    const response: AppendNoteResponse = deps.link.notesAppend({ kind: "human" }, parsed.data.repo, parsed.data.text);
    sendJson(res, 200, response);
  } catch (error) {
    sendLinkError(res, error);
  }
}

export function createControlHandler(deps: ControlDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (req.method === "POST") {
      if (pathname === "/v1/review") {
        void handleReview(deps, req, res);
        return;
      }
      if (pathname === "/v1/notes") {
        void handleAppendNote(deps, req, res);
        return;
      }
      const handoffMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/handoff$/);
      if (handoffMatch) {
        void handleHandoff(deps, req, res, handoffMatch[1] ?? "");
        return;
      }
      const messageMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (messageMatch) {
        void handleSendMessage(deps, req, res, messageMatch[1] ?? "");
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
    if (req.method === "PATCH") {
      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        void handleUpdateSession(deps, req, res, sessionMatch[1] ?? "");
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
      handleListSessions(deps, res, url.searchParams);
      return;
    }
    if (pathname === "/v1/search") {
      handleSearch(deps, res, url.searchParams);
      return;
    }
    if (pathname === "/v1/notes") {
      handleReadNotes(deps, res, url.searchParams);
      return;
    }
    const transcriptMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      handleTranscript(deps, res, transcriptMatch[1] ?? "", url.searchParams);
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
