import { resolve as resolvePath } from "node:path";
import {
  AppendNoteResponseSchema,
  HandoffResponseSchema,
  type ImportSummary,
  ImportSummarySchema,
  ListSessionsResponseSchema,
  NotesResponseSchema,
  type SessionRecord,
  SearchResponseSchema,
  SendMessageResponseSchema,
  SUMMARY_TIMEOUT_MS,
  TranscriptResponseSchema,
  UpdateSessionResponseSchema,
} from "@aaroncx/protocol";
import { authHeaders, type DaemonHandle } from "./daemon.ts";
import { parseOlderThanDays } from "./gc.ts";

/**
 * monad Link from the terminal (decision record 0012): search, show, send,
 * ls --repo/--all, title, handoff, notes and import. Every command is a thin call to a /v1 route,
 * which runs the daemon's one LinkService with the human as the caller, so
 * the CLI reaches exactly what an agent reaches, through the same checks,
 * and every read lands on the target's log as an access event.
 */

export interface SearchFlags {
  query: string;
  repo?: string;
  since?: string;
  limit?: number;
  /** Search one session only (full id or a prefix the CLI resolves). */
  session?: string;
}

export interface ShowFlags {
  id: string;
  from?: number;
  limit?: number;
}

export interface LsFlags {
  repo?: string;
  all: boolean;
}

function needValue(argv: string[], index: number, flag: string, what: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs ${what}`);
  }
  return value;
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} needs a whole number, not ${value}`);
  }
  return n;
}

/**
 * --since accepts an ISO timestamp or a duration back from now (7d, 12h,
 * 30m), and always hands the daemon an ISO timestamp.
 */
export function parseSince(value: string, now: Date = new Date()): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`cannot parse ${value} as a timestamp`);
    }
    return parsed.toISOString();
  }
  const days = parseOlderThanDays(value);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A repo flag as the daemon wants it: an absolute path (it finds the root). */
function absolute(path: string): string {
  return resolvePath(process.cwd(), path);
}

export function parseSearchFlags(argv: string[], now?: Date): SearchFlags {
  const words: string[] = [];
  const flags: Partial<SearchFlags> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--repo":
        flags.repo = absolute(needValue(argv, ++i, arg, "a path"));
        break;
      case "--since":
        flags.since = parseSince(needValue(argv, ++i, arg, "a timestamp or a duration like 7d"), now);
        break;
      case "--limit":
        flags.limit = positiveInt(needValue(argv, ++i, arg, "a number"), arg);
        break;
      case "--session":
        flags.session = needValue(argv, ++i, arg, "a session id");
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown flag ${arg}`);
        }
        words.push(arg);
    }
  }
  const query = words.join(" ").trim();
  if (query.length === 0) {
    throw new Error("search needs a query, e.g. monad search scroll clamp");
  }
  return { query, ...flags };
}

export function parseShowFlags(argv: string[]): ShowFlags {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("-")) {
    throw new Error("show needs a session id (see monad ls)");
  }
  const flags: ShowFlags = { id };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--from") {
      flags.from = positiveInt(needValue(rest, ++i, arg, "a seq"), arg);
    } else if (arg === "--limit") {
      flags.limit = positiveInt(needValue(rest, ++i, arg, "a number"), arg);
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

export function parseSendArgs(argv: string[]): { id: string; text: string } {
  const [id, ...words] = argv;
  if (!id || id.startsWith("-")) {
    throw new Error("send needs a session id and a message, e.g. monad send 0199ab \"status?\"");
  }
  const text = words.join(" ").trim();
  if (text.length === 0) {
    throw new Error("send needs a message after the session id");
  }
  return { id, text };
}

export function parseTitleArgs(argv: string[]): { id: string; title: string } {
  const [id, ...words] = argv;
  if (!id || id.startsWith("-")) {
    throw new Error("title needs a session id and a title");
  }
  const title = words.join(" ").trim();
  if (title.length === 0) {
    throw new Error("title needs the new title after the session id");
  }
  return { id, title };
}

export interface HandoffFlags {
  id: string;
  summarize: boolean;
}

export function parseHandoffFlags(argv: string[]): HandoffFlags {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("-")) {
    throw new Error("handoff needs a session id (see monad ls)");
  }
  const flags: HandoffFlags = { id, summarize: false };
  for (const arg of rest) {
    if (arg === "--summarize") {
      flags.summarize = true;
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

export interface NotesFlags {
  repo: string;
  append?: string;
}

/**
 * monad notes <repo> [--append text...]. The repo is any path inside the
 * repository, resolved against the current directory; everything after
 * --append is the note.
 */
export function parseNotesFlags(argv: string[]): NotesFlags {
  const [repo, ...rest] = argv;
  if (!repo || repo.startsWith("-")) {
    throw new Error("notes needs a repository path, e.g. monad notes . or monad notes ~/code/app --append \"use bun\"");
  }
  const flags: NotesFlags = { repo: absolute(repo) };
  if (rest.length === 0) {
    return flags;
  }
  if (rest[0] !== "--append") {
    throw new Error(`unknown flag ${rest[0]}`);
  }
  const text = rest.slice(1).join(" ").trim();
  if (text.length === 0) {
    throw new Error("--append needs the note text");
  }
  return { ...flags, append: text };
}

export function parseLsFlags(argv: string[]): LsFlags {
  const flags: LsFlags = { all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--repo") {
      flags.repo = absolute(needValue(argv, ++i, arg, "a path"));
    } else if (arg === "--all") {
      flags.all = true;
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

async function getJson(handle: DaemonHandle, path: string): Promise<unknown> {
  const response = await fetch(`${handle.url}${path}`, { headers: authHeaders(handle.token) });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `GET ${path} failed with ${response.status}`);
  }
  return body;
}

/**
 * How long `monad handoff --summarize` waits for the daemon: the
 * summarizer's own timeout plus a margin, so the daemon's answer (a summary
 * or its timeout error) always arrives before the CLI gives up.
 */
export const SUMMARIZE_REQUEST_TIMEOUT_MS = SUMMARY_TIMEOUT_MS + 2 * 60 * 1000;

async function sendJson(
  handle: DaemonHandle,
  method: "POST" | "PATCH",
  path: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
) {
  const response = await fetch(`${handle.url}${path}`, {
    method,
    headers: { ...authHeaders(handle.token), "content-type": "application/json" },
    body: JSON.stringify(payload),
    // Bun's fetch gives up on a response idle for five minutes, and a
    // request the daemon legitimately holds open longer (a summary) would
    // fail at the CLI after succeeding at the daemon. Such a request turns
    // that timer off and sets its own whole-request deadline instead.
    ...(options.timeoutMs === undefined
      ? {}
      : { timeout: false, signal: AbortSignal.timeout(options.timeoutMs) }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `${method} ${path} failed with ${response.status}`);
  }
  return body;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

/** monad search: one block per hit, newest best match first. */
export async function cmdSearch(handle: DaemonHandle, flags: SearchFlags): Promise<void> {
  const { hits } = SearchResponseSchema.parse(
    await getJson(
      handle,
      `/v1/search${query({ q: flags.query, repo: flags.repo, since: flags.since, limit: flags.limit, session: flags.session })}`,
    ),
  );
  if (hits.length === 0) {
    console.log("no hits");
    return;
  }
  for (const hit of hits) {
    console.log(
      `${hit.sessionId}  ${JSON.stringify(hit.title ?? "untitled")}  ${hit.kind}  seq ${hit.firstSeq}-${hit.lastSeq}  ${hit.ts}`,
    );
    if (hit.startedAt !== undefined) {
      const spawned = hit.parentId === undefined ? "" : `, spawned by ${hit.parentId}`;
      console.log(`    session active ${hit.startedAt} to ${hit.lastActiveAt ?? hit.startedAt}${spawned}`);
    }
    console.log(`    ${hit.snippet.replace(/\s+/g, " ")}`);
    console.log(`    monad show ${hit.sessionId.slice(0, 13)} --from ${hit.firstSeq}`);
  }
}

/** monad show: one page of the normalized transcript, access events included. */
export async function cmdShow(handle: DaemonHandle, id: string, flags: ShowFlags): Promise<void> {
  const page = TranscriptResponseSchema.parse(
    await getJson(handle, `/v1/sessions/${id}/transcript${query({ from: flags.from, limit: flags.limit })}`),
  );
  console.log(`session ${page.sessionId} ${JSON.stringify(page.title ?? "untitled")}`);
  console.log(page.text.length > 0 ? page.text : "(no entries at or after this seq)");
  if (page.nextFromSeq !== null) {
    console.log(`more: monad show ${page.sessionId.slice(0, 13)} --from ${page.nextFromSeq}`);
  }
}

/** monad send: a peer message from the human. */
export async function cmdSend(handle: DaemonHandle, id: string, text: string): Promise<void> {
  const result = SendMessageResponseSchema.parse(
    await sendJson(handle, "POST", `/v1/sessions/${id}/messages`, { text }),
  );
  console.log(
    result.delivery === "turn"
      ? `sent ${result.messageId}: it started the session's next turn (monad attach ${id.slice(0, 13)} to watch)`
      : `sent ${result.messageId}: the session is busy, so it is queued for its next turn`,
  );
}

/** monad title: names a session by hand. */
export async function cmdTitle(handle: DaemonHandle, id: string, title: string): Promise<void> {
  const { session } = UpdateSessionResponseSchema.parse(
    await sendJson(handle, "PATCH", `/v1/sessions/${id}`, { title }),
  );
  console.log(`${session.id}  ${JSON.stringify(session.title ?? "")}`);
}

/** One `monad ls` row, with the repos it touched and its last handoff when known. */
export function formatSessionRow(s: SessionRecord, repos?: string[], handoff?: string): string {
  const pr = s.pr ? `#${s.pr.number}` : "-";
  const title = JSON.stringify(s.title ?? "untitled");
  const lines = [`${s.id}  ${s.status.padEnd(22)}  ${s.mode.padEnd(11)}  ${pr.padEnd(6)}  ${title}  ${s.cwd}  ${s.updatedAt}`];
  if (repos !== undefined) {
    lines.push(`    repos: ${repos.length > 0 ? repos.join(", ") : "none"}`);
  }
  if (handoff !== undefined) {
    lines.push(`    last handoff: ${handoff}`);
  }
  return lines.join("\n");
}

/**
 * monad ls. Plain, it is the M1 list (oldest first) minus imported logs;
 * --all keeps them; --repo asks the daemon for the sessions that touched
 * that repository, most recently active first, with the repos each touched.
 */
export async function cmdLs(handle: DaemonHandle, flags: LsFlags): Promise<void> {
  const path =
    flags.repo === undefined
      ? "/v1/sessions"
      : `/v1/sessions${query({ repo: flags.repo, imported: flags.all ? "1" : "0" })}`;
  const response = ListSessionsResponseSchema.parse(await getJson(handle, path));
  const sessions = flags.all ? response.sessions : response.sessions.filter((s) => s.status !== "imported");
  if (sessions.length === 0) {
    console.log("no sessions");
    return;
  }
  for (const s of sessions) {
    console.log(formatSessionRow(s, response.repos?.[s.id], response.handoffs?.[s.id]));
  }
}

/**
 * monad handoff: writes a fresh deterministic handoff and prints it. With
 * --summarize it also runs the model-written summary (a separate read-only
 * session; it spends vendor tokens and can take minutes) and prints that.
 */
export async function cmdHandoff(handle: DaemonHandle, id: string, flags: HandoffFlags): Promise<void> {
  if (flags.summarize) {
    console.error("monad: writing the handoff, then running the summarizer (this can take a few minutes)");
  }
  const result = HandoffResponseSchema.parse(
    await sendJson(
      handle,
      "POST",
      `/v1/sessions/${id}/handoff`,
      flags.summarize ? { summarize: true } : {},
      flags.summarize ? { timeoutMs: SUMMARIZE_REQUEST_TIMEOUT_MS } : {},
    ),
  );
  console.log(`handoff ${result.sessionId} seq ${result.handoff.seq} (${result.handoff.reason})`);
  console.log(result.handoff.text);
  if (result.summary) {
    console.log("");
    console.log(`summary seq ${result.summary.seq} (by summarizer session ${result.summary.summarizerSessionId})`);
    console.log(result.summary.text);
  }
}

/** monad notes: prints a repository's notes, or appends one. */
export async function cmdNotes(handle: DaemonHandle, flags: NotesFlags): Promise<void> {
  if (flags.append !== undefined) {
    const { repo, note } = AppendNoteResponseSchema.parse(
      await sendJson(handle, "POST", "/v1/notes", { repo: flags.repo, text: flags.append }),
    );
    console.log(`noted for ${repo} at ${note.ts}`);
    return;
  }
  const { repo, notes } = NotesResponseSchema.parse(await getJson(handle, `/v1/notes${query({ repo: flags.repo })}`));
  if (notes.length === 0) {
    console.log(`no notes for ${repo}`);
    return;
  }
  console.log(`notes for ${repo}`);
  for (const note of notes) {
    const [first = "", ...rest] = note.text.split("\n");
    console.log(`${note.ts}  ${note.by}  ${first}`);
    for (const line of rest) {
      console.log(`    ${line}`);
    }
  }
}

export interface ImportFlags {
  /** Only these files or directories; empty means the daemon's configured roots. */
  paths: string[];
}

/** monad import [--path P ...]: each --path is resolved against the current directory. */
export function parseImportFlags(argv: string[]): ImportFlags {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--path") {
      paths.push(absolute(needValue(argv, ++i, arg, "a file or directory")));
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return { paths };
}

/**
 * How long `monad import` waits for the daemon. A first import of a large
 * ~/.claude/projects reads every log once (about 2 s per 150 MB measured on
 * the Mac mini), and Bun's fetch would give up on a response idle for five
 * minutes.
 */
export const IMPORT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/** The lines `monad import` prints for a run's summary. */
export function formatImportSummary(summary: ImportSummary): string[] {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  const lines = [`scanned ${summary.filesScanned} log file(s) under ${summary.roots.join(", ")} in ${seconds}s`];
  if (summary.eventsAppended === 0 && summary.sessionsReset === 0) {
    lines.push("nothing new to import");
  } else {
    const reset =
      summary.sessionsReset > 0 ? `, ${summary.sessionsReset} re-read from the start (truncated or replaced)` : "";
    lines.push(
      `imported ${summary.eventsAppended} event(s): ${summary.sessionsCreated} new session(s), ${summary.sessionsUpdated} updated${reset}`,
    );
  }
  if (summary.linesMalformed > 0) {
    lines.push(`skipped ${summary.linesMalformed} malformed line(s)`);
  }
  for (const skip of summary.skipped) {
    lines.push(`skipped ${skip.path}: ${skip.reason}`);
  }
  if (summary.skippedCount > summary.skipped.length) {
    lines.push(`... and ${summary.skippedCount - summary.skipped.length} more skipped`);
  }
  return lines;
}

/**
 * monad import: reads Claude Code and Codex logs into read-only sessions
 * (Link phase 4). They show up in `monad search`, `monad show` and
 * `monad ls --all`; they can never be attached or messaged.
 */
export async function cmdImport(handle: DaemonHandle, flags: ImportFlags): Promise<void> {
  const summary = ImportSummarySchema.parse(
    await sendJson(handle, "POST", "/v1/import", flags.paths.length > 0 ? { paths: flags.paths } : {}, {
      timeoutMs: IMPORT_REQUEST_TIMEOUT_MS,
    }),
  );
  for (const line of formatImportSummary(summary)) {
    console.log(line);
  }
}
