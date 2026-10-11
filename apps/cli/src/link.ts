import { resolve as resolvePath } from "node:path";
import {
  ListSessionsResponseSchema,
  type SessionRecord,
  SearchResponseSchema,
  SendMessageResponseSchema,
  TranscriptResponseSchema,
  UpdateSessionResponseSchema,
} from "@aaroncx/protocol";
import { authHeaders, type DaemonHandle } from "./daemon.ts";
import { parseOlderThanDays } from "./gc.ts";

/**
 * monad Link from the terminal (decision record 0012): search, show, send,
 * ls --repo/--all and title. Every command is a thin call to a /v1 route,
 * which runs the daemon's one LinkService with the human as the caller, so
 * the CLI reaches exactly what an agent reaches, through the same checks,
 * and every read lands on the target's log as an access event.
 */

export interface SearchFlags {
  query: string;
  repo?: string;
  since?: string;
  limit?: number;
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

async function sendJson(handle: DaemonHandle, method: "POST" | "PATCH", path: string, payload: unknown) {
  const response = await fetch(`${handle.url}${path}`, {
    method,
    headers: { ...authHeaders(handle.token), "content-type": "application/json" },
    body: JSON.stringify(payload),
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
      `/v1/search${query({ q: flags.query, repo: flags.repo, since: flags.since, limit: flags.limit })}`,
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

/** One `monad ls` row. */
export function formatSessionRow(s: SessionRecord, repos?: string[]): string {
  const pr = s.pr ? `#${s.pr.number}` : "-";
  const title = JSON.stringify(s.title ?? "untitled");
  const row = `${s.id}  ${s.status.padEnd(22)}  ${s.mode.padEnd(11)}  ${pr.padEnd(6)}  ${title}  ${s.cwd}  ${s.updatedAt}`;
  return repos === undefined ? row : `${row}\n    repos: ${repos.length > 0 ? repos.join(", ") : "none"}`;
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
    console.log(formatSessionRow(s, response.repos?.[s.id]));
  }
}
