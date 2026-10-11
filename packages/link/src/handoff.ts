import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { redactSecrets } from "@aaroncx/checks";
import {
  PROVENANCE_HEADER_PATTERN,
  peerMetaOf,
  promptTexts,
  type RepoResolver,
  type SessionManager,
  type SessionStore,
  toolCallPaths,
  toolCallUpdate,
} from "@aaroncx/engine";
import {
  EventKindSchema,
  type EventRecord,
  type HandoffPayload,
  type HandoffReason,
  type HandoffRepo,
  type SessionId,
  type SessionRecord,
} from "@aaroncx/protocol";
import { redactDeep } from "./quote.ts";

/**
 * Deterministic handoffs (monad Link phase 3, decision record 0012).
 *
 * A handoff answers "where does this session stand?" for whoever picks the
 * work up next: another session, the human tomorrow, the phone. It is built
 * from what monad already holds (the event log, the session record, the
 * permissions the policy is holding, and three read-only git commands per
 * repository), with no model involved, so it costs nothing and is written
 * every time: ten minutes into an idle stretch, just before a session
 * closes, and whenever a human asks for one. The model-written summary is a
 * separate thing (LinkService.summarize) and never runs on its own, because
 * it spends Aaron's vendor tokens.
 *
 * Its text's first line is a one-line summary, which is what sessions_list
 * and `monad ls` show next to the session. Every string in the payload goes
 * through the secrets redactor before it is logged, because a handoff
 * quotes the session's own asks and errors and is read by other sessions.
 */

/** Environment variable overriding the idle window, in milliseconds (tests). */
export const HANDOFF_IDLE_ENV = "MONAD_HANDOFF_IDLE_MS";

/** A session idle this long after its last turn gets a handoff: ten minutes. */
export const DEFAULT_HANDOFF_IDLE_MS = 10 * 60 * 1000;

/** How many of the session's last asks and errors a handoff quotes. */
const LAST_ASKS = 3;
const LAST_ERRORS = 3;
/** Paths kept in `files` (the most recent ones). */
const MAX_FILES = 40;
/** Changed paths kept per repository. */
const MAX_CHANGED_FILES = 20;
/** One quoted ask or error, at most, in characters. */
const MAX_LINE = 300;
/** The one-line summary, at most, in characters. */
const MAX_SUMMARY_LINE = 240;
/** Each git command gets this long before its result is recorded as an error. */
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;

/** The idle window: MONAD_HANDOFF_IDLE_MS when it is a positive number, else ten minutes. */
export function handoffIdleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[HANDOFF_IDLE_ENV] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HANDOFF_IDLE_MS;
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  return points.length <= max ? collapsed : `${points.slice(0, max).join("")}...`;
}

/**
 * oneLine over the REDACTED text. Every cut of session-supplied text goes
 * through this: cutting first would leave a token's prefix, which no longer
 * matches its pattern (a ghp_ token needs all 36 characters) and so would
 * survive the redactDeep pass at the end of buildHandoff, into the summary
 * line, sessions_list, `monad ls` and the index. The title derivation
 * (engine indexer.ts) follows the same rule.
 */
function redactedLine(text: string, max: number): string {
  return oneLine(redactSecrets(text).text, max);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs one read-only git command in `cwd`. Two settings keep it inert in a
 * repository monad does not control (a session's tool calls can reach any
 * checkout on disk, including a hostile clone):
 * - `core.fsmonitor=false`: a repository's own config can name an fsmonitor
 *   hook, and `git status` runs it. That is the one way a status or
 *   rev-parse executes repository-chosen code.
 * - `GIT_OPTIONAL_LOCKS=0`: status must not take the index lock, or a
 *   handoff written while an agent is mid-commit could fail its commit.
 */
function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).split("\n").find((line) => line.trim().length > 0);
          reject(new Error(`git ${args.join(" ")} failed: ${detail ?? "unknown error"}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Branch, HEAD and working-tree state of one checkout. Failures are
 * recorded on the entry, never thrown: an empty repository has no HEAD, a
 * deleted one has nothing, and neither may stop a handoff (or a close).
 */
export async function gitState(root: string, checkout: string, timeoutMs = DEFAULT_GIT_TIMEOUT_MS): Promise<HandoffRepo> {
  const entry: HandoffRepo = { root, checkout, changedFiles: [], changedCount: 0 };
  const errors: string[] = [];
  const [branch, head, status] = await Promise.allSettled([
    git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
    git(checkout, ["rev-parse", "HEAD"], timeoutMs),
    git(checkout, ["status", "--porcelain"], timeoutMs),
  ]);
  if (branch.status === "fulfilled") {
    entry.branch = branch.value.trim();
  } else {
    errors.push(String(branch.reason instanceof Error ? branch.reason.message : branch.reason));
  }
  if (head.status === "fulfilled") {
    entry.head = head.value.trim();
  } else {
    errors.push(String(head.reason instanceof Error ? head.reason.message : head.reason));
  }
  if (status.status === "fulfilled") {
    const lines = status.value.split("\n").filter((line) => line.trim().length > 0);
    entry.dirty = lines.length > 0;
    entry.changedCount = lines.length;
    entry.changedFiles = lines.slice(0, MAX_CHANGED_FILES).map((line) => line.slice(3));
  } else {
    errors.push(String(status.reason instanceof Error ? status.reason.message : status.reason));
  }
  if (errors.length > 0) {
    // The first failure says enough; an unborn HEAD fails rev-parse twice.
    entry.error = redactedLine(errors[0] ?? "git failed", MAX_LINE);
  }
  return entry;
}

/**
 * Everything in a handoff but its reason and rendered text. (Pick, not Omit:
 * the payload schema is loose, and Omit over its index signature would lose
 * every named field's type.)
 */
type HandoffBody = Pick<
  HandoffPayload,
  "lastAsks" | "files" | "repos" | "pendingPermissions" | "lastErrors" | "children" | "fromSeq" | "toSeq"
>;

export interface HandoffDeps {
  manager: SessionManager;
  store: SessionStore;
  repos: RepoResolver;
  gitTimeoutMs?: number;
}

/** The paths a session's tool calls touched, most recent last, deduplicated. */
function touchedFiles(store: SessionStore, record: SessionRecord): string[] {
  const seen = new Map<string, true>();
  for (const event of store.replayKinds(record.id, ["update"])) {
    const update = toolCallUpdate(event);
    if (!update) {
      continue;
    }
    for (const raw of toolCallPaths(update)) {
      const path = isAbsolute(raw) || raw.startsWith("~") ? raw : resolvePath(record.cwd, raw);
      // Re-inserting moves a path to the end, so the order is "last touched".
      seen.delete(path);
      seen.set(path, true);
    }
  }
  return [...seen.keys()].slice(-MAX_FILES);
}

/** One ask: what was asked, and who asked when a peer or a spawn delivered it. */
interface Ask {
  /** Every text block on one line, redacted, without a provenance header. */
  text: string;
  /** "session <short id>" or "the human (monad send)" for a delivered message. */
  from?: string;
}

/**
 * One ask as a handoff quotes it. A peer-delivered or spawned turn's prompt
 * opens with the daemon's provenance header (`[message from monad session
 * <id> "<title>", repo <x>]`), which alone is longer than the summary line's
 * quote, so it is replaced by a short sender and the ask is the body. Only a
 * prompt whose _meta says it delivered a peer message loses its first line,
 * so a human typing that text keeps it.
 */
function askOf(event: EventRecord): Ask {
  const meta = peerMetaOf(event.payload);
  let text = redactSecrets(promptTexts(event.payload).join("\n")).text;
  if (meta !== undefined) {
    const lines = text.split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first !== -1 && PROVENANCE_HEADER_PATTERN.test(lines[first]?.trim() ?? "")) {
      text = lines.slice(first + 1).join("\n");
    }
  }
  const ask: Ask = { text: oneLine(text, MAX_LINE) };
  if (meta !== undefined) {
    ask.from = meta.from === "human" ? "the human (monad send)" : `session ${meta.from.slice(0, 8)}`;
  }
  return ask;
}

/** An ask as lastAsks holds it: the sender first, so a cut never drops it. */
function askLine(ask: Ask): string {
  return ask.from === undefined ? ask.text : `(from ${ask.from}) ${ask.text}`;
}

function errorText(event: EventRecord): string {
  const message = (event.payload as { message?: unknown } | null)?.message;
  return redactedLine(typeof message === "string" ? message : "unknown error", MAX_LINE);
}

/** The newest event of any kind but `except`, for the handoff's seq range. */
function lastSeq(store: SessionStore, id: SessionId): number {
  const kinds = EventKindSchema.options.filter((kind) => kind !== "access" && kind !== "handoff");
  return store.lastEventOfKinds(id, kinds)?.seq ?? 0;
}

function repoLabel(repo: HandoffRepo): string {
  const name = repo.root.split("/").filter(Boolean).at(-1) ?? repo.root;
  if (repo.error !== undefined && repo.branch === undefined) {
    return `${name} (git unavailable)`;
  }
  const state = repo.dirty === undefined ? "state unknown" : repo.dirty ? `${repo.changedCount} changed` : "clean";
  return `${name} (${repo.branch ?? "?"}, ${state})`;
}

/**
 * The handoff's one-line summary: why it was written, the last thing asked,
 * and what is open (repos and their state, held permissions, errors in the
 * last turn, children still running).
 */
function summaryLine(
  reason: HandoffReason,
  payload: HandoffBody,
  lastAsk: Ask | undefined,
  turnErrors: number,
): string {
  const parts: string[] = [];
  if (lastAsk === undefined) {
    parts.push("no asks yet");
  } else {
    const from = lastAsk.from === undefined ? "" : ` (from ${lastAsk.from})`;
    parts.push(`last asked ${JSON.stringify(oneLine(lastAsk.text, 80))}${from}`);
  }
  if (payload.repos.length > 0) {
    parts.push(`repos ${payload.repos.map(repoLabel).join(", ")}`);
  }
  if (payload.pendingPermissions.length > 0) {
    parts.push(`${plural(payload.pendingPermissions.length, "pending permission")}`);
  }
  if (turnErrors > 0) {
    parts.push(`${plural(turnErrors, "error")} in the last turn`);
  }
  if (payload.children.length > 0) {
    const live = payload.children.filter((c) => c.status === "running" || c.status === "waiting_for_permission").length;
    const count = payload.children.length;
    parts.push(`${count} ${count === 1 ? "child" : "children"}${live > 0 ? ` (${live} running)` : ""}`);
  }
  const label = reason === "manual" ? "handoff" : reason;
  // The ask is already redacted (askText); the line is redacted again as a
  // whole before its own cut, since repo labels are session-supplied too.
  return redactedLine(`${label}: ${parts.join("; ")}`, MAX_SUMMARY_LINE);
}

function renderText(
  reason: HandoffReason,
  record: SessionRecord,
  payload: HandoffBody,
  lastAsk: Ask | undefined,
  turnErrors: number,
): string {
  const lines: string[] = [summaryLine(reason, payload, lastAsk, turnErrors), ""];
  lines.push(`Session ${record.id} ${JSON.stringify(record.title ?? "untitled")}: ${record.status}, ${record.mode}, cwd ${record.cwd}`);
  lines.push("", "## Last asks");
  if (payload.lastAsks.length === 0) {
    lines.push("none");
  } else {
    payload.lastAsks.forEach((ask, index) => {
      lines.push(`${index + 1}. ${ask}`);
    });
  }
  if (payload.repos.length > 0) {
    lines.push("", "## Repos");
    for (const repo of payload.repos) {
      const where = repo.checkout === repo.root ? repo.root : `${repo.root} (checkout ${repo.checkout})`;
      const head = repo.head === undefined ? "" : `, HEAD ${repo.head.slice(0, 12)}`;
      const state =
        repo.dirty === undefined
          ? ""
          : repo.dirty
            ? `, dirty: ${repo.changedCount} changed (${repo.changedFiles.join(", ")}${repo.changedCount > repo.changedFiles.length ? ", ..." : ""})`
            : ", clean";
      const error = repo.error === undefined ? "" : `; ${repo.error}`;
      lines.push(`- ${where}: branch ${repo.branch ?? "?"}${head}${state}${error}`);
    }
  }
  if (payload.files.length > 0) {
    lines.push("", `## Files touched (last ${payload.files.length})`);
    for (const file of payload.files) {
      lines.push(`- ${file}`);
    }
  }
  if (payload.pendingPermissions.length > 0) {
    lines.push("", "## Pending permissions");
    for (const permission of payload.pendingPermissions) {
      lines.push(`- ${permission.title ?? "untitled request"} (${permission.toolCallId})`);
    }
  }
  if (payload.lastErrors.length > 0) {
    lines.push("", "## Recent errors");
    for (const error of payload.lastErrors) {
      lines.push(`- ${error}`);
    }
  }
  if (payload.children.length > 0) {
    lines.push("", "## Spawned children");
    for (const child of payload.children) {
      lines.push(`- ${child.id} ${JSON.stringify(child.title ?? "untitled")}: ${child.status}`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds a session's handoff payload, redacted. Undefined when the session
 * does not exist, or when it never had an ask and the handoff is automatic
 * (a session nobody prompted has nothing to hand off; a human asking still
 * gets one).
 */
export async function buildHandoff(
  deps: HandoffDeps,
  id: SessionId,
  reason: HandoffReason,
): Promise<HandoffPayload | undefined> {
  const record = deps.store.get(id);
  if (!record) {
    return undefined;
  }
  const asks = deps.store.lastEventsOfKind(id, "prompt", LAST_ASKS);
  if (asks.length === 0 && reason !== "manual") {
    return undefined;
  }
  const errors = deps.store.lastEventsOfKind(id, "error", LAST_ERRORS);
  const lastAskSeq = asks.at(-1)?.seq ?? 0;
  const cwdRoot = isDirectory(record.cwd) ? deps.repos.resolve(record.cwd) : undefined;
  // Git state per repository the session touched. When the session's own
  // cwd is a checkout of that repository (a review, fix or spawn worktree
  // folds into its main repository's root), ask the cwd: its branch and
  // dirt are the session's, the main checkout's are someone else's.
  const repos = await Promise.all(
    deps.store
      .reposFor(id)
      .map((repo) =>
        gitState(
          repo.repoRoot,
          cwdRoot === repo.repoRoot ? record.cwd : repo.repoRoot,
          deps.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        ),
      ),
  );
  const firstSeq = deps.store.replay(id, 0, 1)[0]?.seq ?? 0;
  const askList = asks.map(askOf);
  const body: HandoffBody = {
    lastAsks: askList.map(askLine),
    files: touchedFiles(deps.store, record),
    repos,
    pendingPermissions: deps.manager.pendingPermissions(id).map((request, index) => ({
      toolCallId: request.toolCall?.toolCallId ?? `request-${index + 1}`,
      ...(typeof request.toolCall?.title === "string" ? { title: redactedLine(request.toolCall.title, MAX_LINE) } : {}),
    })),
    lastErrors: errors.map(errorText),
    children: deps.store.childrenOf(id).map((child) => ({
      id: child.id,
      ...(child.title === undefined ? {} : { title: child.title }),
      status: child.status,
    })),
    fromSeq: firstSeq,
    toSeq: lastSeq(deps.store, id),
  };
  const turnErrors = errors.filter((event) => event.seq > lastAskSeq).length;
  const payload: HandoffPayload = { reason, text: renderText(reason, record, body, askList.at(-1), turnErrors), ...body };
  // Asks, errors, titles, paths and branch names are all session-supplied
  // text, and other sessions read handoffs: redact every string. The cut
  // strings were redacted before their cut (redactedLine); this pass covers
  // the rest and is a second layer for those.
  return redactDeep(payload);
}

/** The first line of a handoff event's text: what a session list shows. */
export function handoffFirstLine(event: EventRecord | undefined): string | undefined {
  const text = (event?.payload as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const first = text.split("\n", 1)[0]?.trim();
  return first ? first : undefined;
}

export interface HandoffSchedulerOptions {
  manager: SessionManager;
  store: SessionStore;
  /** Writes one handoff (LinkService.writeHandoff). */
  write: (id: SessionId, reason: HandoffReason) => Promise<unknown>;
  /** The idle window. Default handoffIdleMs() (MONAD_HANDOFF_IDLE_MS, else ten minutes). */
  idleMs?: number;
  /** Sessions that never get an automatic handoff (the summarizer sessions). */
  skip?: (record: SessionRecord) => boolean;
  now?: () => number;
  /** Where a failed automatic handoff is reported (the daemon logs it). */
  onError?: (id: SessionId, error: unknown) => void;
}

interface ArmedTimer {
  /** The idle stretch this timer belongs to: the seq of the prompt that began it. */
  stretch: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Writes the automatic handoffs: one per idle stretch, idleMs after the
 * stretch's turn boundary, and one just before a session closes.
 *
 * An idle stretch is everything after a session's last prompt. It gets at
 * most one idle handoff, and whether it has one is read from the log (a
 * handoff with a seq past the stretch's prompt), so a restarted daemon
 * neither repeats one nor misses one: start() catches up every idle session
 * whose window has already passed, and arms the rest for what is left of
 * theirs. A new prompt ends the stretch (its timer is dropped) and the turn
 * boundary after it starts the next.
 *
 * Nothing a handoff writes re-arms anything. The timers are driven by the
 * manager's change listener (status flips and turn boundaries) and by
 * start(); appending a handoff or summary is neither, and neither moves the
 * session's updated_at (store.ts), so a handoff can never schedule another.
 */
export class HandoffScheduler {
  private readonly manager: SessionManager;
  private readonly store: SessionStore;
  private readonly write: (id: SessionId, reason: HandoffReason) => Promise<unknown>;
  private readonly idleMs: number;
  private readonly skip: (record: SessionRecord) => boolean;
  private readonly now: () => number;
  private readonly onError: (id: SessionId, error: unknown) => void;
  private readonly timers = new Map<SessionId, ArmedTimer>();
  private unsubscribe?: () => void;

  constructor(options: HandoffSchedulerOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.write = options.write;
    this.idleMs = options.idleMs ?? handoffIdleMs();
    this.skip = options.skip ?? (() => false);
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Subscribes to session changes, installs the closing-handoff hook, and
   * catches up: every idle session is considered once now, so one that went
   * idle more than idleMs ago under a previous daemon gets its handoff at
   * once, and one that went idle more recently gets the rest of its window.
   */
  start(): void {
    this.unsubscribe = this.manager.onSessionChange((id) => {
      this.consider(id);
    });
    this.manager.setBeforeClose((id) => this.closing(id));
    for (const record of this.store.list()) {
      this.consider(record.id);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.manager.setBeforeClose(undefined);
    for (const { timer } of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Sessions with an idle handoff armed (for tests and diagnostics). */
  armed(): SessionId[] {
    return [...this.timers.keys()];
  }

  /**
   * The open idle stretch of a session: the seq of its last prompt and the
   * time of its last turn boundary. Undefined when it was never prompted or
   * the stretch already has a handoff.
   */
  private openStretch(id: SessionId): { stretch: number; boundaryMs: number } | undefined {
    const prompt = this.store.lastEventOfKind(id, "prompt");
    if (!prompt) {
      return undefined;
    }
    const handoff = this.store.lastEventOfKind(id, "handoff");
    if (handoff && handoff.seq > prompt.seq) {
      return undefined;
    }
    const boundary = this.store.lastEventOfKinds(id, ["prompt", "turn_ended", "error"]) ?? prompt;
    const boundaryMs = Date.parse(boundary.ts);
    return { stretch: prompt.seq, boundaryMs: Number.isFinite(boundaryMs) ? boundaryMs : this.now() };
  }

  private clear(id: SessionId): void {
    const armed = this.timers.get(id);
    if (armed) {
      clearTimeout(armed.timer);
      this.timers.delete(id);
    }
  }

  private consider(id: SessionId): void {
    let record: SessionRecord | undefined;
    try {
      record = this.store.get(id);
    } catch {
      return; // The store is gone (daemon shutting down).
    }
    if (
      !record ||
      record.status !== "idle" ||
      this.manager.isTurnInFlight(id) ||
      this.skip(record)
    ) {
      this.clear(id);
      return;
    }
    const open = this.openStretch(id);
    if (!open) {
      this.clear(id);
      return;
    }
    if (this.timers.get(id)?.stretch === open.stretch) {
      return; // Already armed for this stretch.
    }
    this.clear(id);
    const delay = Math.max(0, open.boundaryMs + this.idleMs - this.now());
    const timer = setTimeout(() => {
      void this.fire(id, open.stretch);
    }, delay);
    // A pending handoff must never keep a process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(id, { stretch: open.stretch, timer });
  }

  private async fire(id: SessionId, stretch: number): Promise<void> {
    if (this.timers.get(id)?.stretch === stretch) {
      this.timers.delete(id);
    }
    try {
      const record = this.store.get(id);
      if (!record || record.status !== "idle" || this.manager.isTurnInFlight(id) || this.skip(record)) {
        return;
      }
      if (this.openStretch(id)?.stretch !== stretch) {
        return; // A new prompt, or a handoff someone else wrote, ended this stretch.
      }
      await this.write(id, "idle");
    } catch (error) {
      this.onError(id, error);
    }
  }

  private async closing(id: SessionId): Promise<void> {
    this.clear(id);
    const record = this.store.get(id);
    if (!record || this.skip(record)) {
      return;
    }
    try {
      await this.write(id, "closed");
    } catch (error) {
      this.onError(id, error);
    }
  }
}
