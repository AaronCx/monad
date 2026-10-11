import { statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { redactSecrets } from "@aaroncx/checks";
import {
  type PeerMessageInput,
  peerPromptRequest,
  RepoResolver,
  type SessionManager,
  type SessionStore,
  turnHop,
} from "@aaroncx/engine";
import {
  type AccessOp,
  type AccessPayload,
  type BackendId,
  LINK_READ_ONLY_TOOL_NAMES,
  LINK_TOOL_NAMES,
  type LinkActor,
  type LinkSearchHit,
  type LinkToolName,
  MAX_PEER_MESSAGE_LENGTH,
  type PeerMessagePayload,
  type SessionId,
  type SessionMode,
  type SessionRecord,
  type SessionStatus,
} from "@aaroncx/protocol";
import type { LinkConfig } from "./config.ts";
import { RateLimiter } from "./rate.ts";
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  MAX_TRANSCRIPT_LIMIT,
  normalizeTranscript,
  TRANSCRIPT_PAGE_BYTES,
  type TranscriptPage,
} from "./transcript.ts";

/**
 * LinkService: the one implementation of everything monad Link lets a caller
 * do to another session (decision record 0012). The monad-sessions MCP server
 * calls it for a session, and the control API calls it for the human at the
 * CLI, so the two can never drift: a check here holds for both.
 *
 * Every rule that matters is enforced here, by the daemon, and none of it is
 * left to a prompt:
 * - who may call what (the trust table, re-read from the record per call);
 * - what a caller may see (link.json's repo scope);
 * - what comes back (redacted; the MCP layer also fences it);
 * - the loop guards (hop count, per-sender rate, spawn depth, concurrency);
 * - that every cross-session access is on the record, on both logs.
 *
 * A peer message is only ever a prompt (SessionManager.deliverPeerMessage).
 * Nothing in this file touches the permission policy, a session's mode, or
 * a policy config, which is the peers-cannot-grant rule by construction.
 */

/** Who is calling: a monad session (over its sessions mount) or the human (control API). */
export type LinkCaller = { kind: "human" } | { kind: "session"; id: SessionId };

export type LinkErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "refused"
  | "rate_limited"
  | "unavailable";

/** A refusal with a reason the caller is shown. Never carries history text. */
export class LinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LinkError";
  }
}

export interface LinkServiceOptions {
  manager: SessionManager;
  store: SessionStore;
  config: LinkConfig;
  /** Canonicalizes repo paths for scope checks and the repo filters. */
  repos?: RepoResolver;
  /**
   * Says whether a vendor backend can be started, before a spawn creates a
   * record for it: undefined when it can, otherwise the reason (naming what
   * IS installed). Absent means only claude-acp is known to work.
   */
  backendUnavailable?: (backend: BackendId) => string | undefined;
  /**
   * Creates a detached worktree of the repo containing `cwd`, at HEAD, for a
   * spawned session, and returns its path. Injected by the daemon (engine's
   * worktree helpers); absent means worktree spawns are refused.
   */
  createWorktree?: (cwd: string, sessionId: SessionId) => Promise<string>;
  /** Clock for the rate limiter. */
  now?: () => number;
}

export interface LinkSessionSummary {
  id: SessionId;
  title?: string;
  backend: BackendId;
  status: SessionStatus;
  mode: SessionMode;
  cwd: string;
  repos: string[];
  updatedAt: string;
  parentId?: SessionId;
  /** The last handoff's first line (Link phase 3). Absent until handoffs exist. */
  lastHandoff?: string;
}

export interface ListOptions {
  repo?: string;
  status?: SessionStatus;
  since?: string;
  limit?: number;
  includeImported?: boolean;
}

export interface SearchOptions {
  repo?: string;
  since?: string;
  limit?: number;
}

export interface ReadOptions {
  fromSeq?: number;
  limit?: number;
}

export interface ReadResult extends TranscriptPage {
  sessionId: SessionId;
  title?: string;
}

export interface SpawnOptions {
  cwd: string;
  prompt: string;
  backend?: BackendId;
  mode?: "interactive" | "review";
  worktree?: boolean;
}

export interface SpawnResult {
  sessionId: SessionId;
  cwd: string;
  backend: BackendId;
  mode: SessionMode;
  worktree: boolean;
  parentId?: SessionId;
  spawnDepth: number;
}

export type WaitUntil = "idle" | "closed" | "waiting_for_permission";

export interface WaitResult {
  reached: boolean;
  status: SessionStatus;
  lastTurnStopReason?: string;
}

/** The access op each tool records. */
const TOOL_OPS: Record<LinkToolName, AccessOp> = {
  sessions_list: "list",
  sessions_search: "search",
  sessions_read: "read",
  sessions_message: "message",
  sessions_spawn: "spawn",
  sessions_wait: "wait",
};

/** The longest sessions_wait the daemon will hold a call open for. */
export const MAX_WAIT_MS = 600_000;

/** Events read per transcript page, an upper bound on work per call. */
const TRANSCRIPT_EVENT_WINDOW = 20_000;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function actorOf(caller: LinkCaller): LinkActor {
  return caller.kind === "human" ? "human" : caller.id;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

function isTerminal(status: SessionStatus): boolean {
  return status === "closed" || status === "imported";
}

export class LinkService {
  private readonly manager: SessionManager;
  private readonly store: SessionStore;
  private readonly config: LinkConfig;
  private readonly repos: RepoResolver;
  private readonly backendUnavailable: (backend: BackendId) => string | undefined;
  private readonly createWorktree?: (cwd: string, sessionId: SessionId) => Promise<string>;
  private readonly rate: RateLimiter;
  /** Canonical roots of link.json's repo allowlist; undefined means everything. */
  private readonly scopeRoots?: Set<string>;
  /** Spawns between their checks and their child's first turn. */
  private spawning = 0;

  constructor(options: LinkServiceOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.config = options.config;
    this.repos = options.repos ?? new RepoResolver();
    this.backendUnavailable =
      options.backendUnavailable ??
      ((backend) => (backend === "claude-acp" ? undefined : `${backend} is not available on this daemon`));
    this.createWorktree = options.createWorktree;
    this.rate = new RateLimiter({
      perMinute: options.config.limits.messagesPerMinute,
      burst: options.config.limits.messageBurst,
      now: options.now,
    });
    if (options.config.repos !== null) {
      this.scopeRoots = new Set(options.config.repos.map((repo) => this.canonicalRepo(repo)));
    }
  }

  // ---------------------------------------------------------------- trust

  /**
   * Whether a session gets a monad-sessions mount at all: Link is enabled,
   * the session is trusted and live, and (with a repo allowlist) its cwd is
   * inside an allowlisted repo. The daemon asks this before injecting the
   * mcpServers entry, and the route asks it again on every request.
   */
  mountAllowed(record: SessionRecord | undefined): boolean {
    if (!record || !this.config.enabled || record.trust !== "trusted" || isTerminal(record.status)) {
      return false;
    }
    if (this.scopeRoots === undefined) {
      return true;
    }
    const root = this.repos.resolve(record.cwd);
    return root !== undefined && this.scopeRoots.has(root);
  }

  /**
   * The trust table, re-read from the record on every call:
   * untrusted (any mode): none; trusted review or fix: list, search, read;
   * trusted interactive: all. A session with no mount has no tools.
   */
  toolsFor(sessionId: SessionId): LinkToolName[] {
    const record = this.store.get(sessionId);
    if (!record || !this.mountAllowed(record)) {
      return [];
    }
    return record.mode === "interactive" ? [...LINK_TOOL_NAMES] : [...LINK_READ_ONLY_TOOL_NAMES];
  }

  // ------------------------------------------------------------ operations

  list(caller: LinkCaller, options: ListOptions = {}): LinkSessionSummary[] {
    this.authorize(caller, "sessions_list", "list");
    let records = this.store.list().filter((record) => this.visibleTo(caller, record.id));
    if (options.repo !== undefined) {
      const ids = new Set(this.store.sessionsForRepo(this.canonicalRepo(options.repo)));
      records = records.filter((record) => ids.has(record.id));
    }
    if (options.status !== undefined) {
      records = records.filter((record) => record.status === options.status);
    }
    if (options.since !== undefined) {
      const since = options.since;
      records = records.filter((record) => record.updatedAt >= since);
    }
    if (options.includeImported === false) {
      records = records.filter((record) => record.status !== "imported");
    }
    records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const limit = clampInt(options.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const summaries = records.slice(0, limit).map((record) => this.summarize(record));
    this.logCaller(caller, { op: "list", count: summaries.length });
    return summaries;
  }

  search(caller: LinkCaller, query: string, options: SearchOptions = {}): LinkSearchHit[] {
    this.authorize(caller, "sessions_search", "search");
    if (typeof query !== "string" || query.trim().length === 0) {
      throw this.refuse(caller, "search", "invalid", "query must be a non-empty string");
    }
    const sessionIds = this.scopedSessionIds(caller);
    const hits = this.store.search(query, {
      repo: options.repo === undefined ? undefined : this.canonicalRepo(options.repo),
      since: options.since,
      limit: options.limit,
      sessionIds,
    });
    const titles = new Map<string, string | undefined>();
    const results: LinkSearchHit[] = hits.map((hit) => {
      if (!titles.has(hit.sessionId)) {
        titles.set(hit.sessionId, this.store.get(hit.sessionId)?.title);
      }
      const title = titles.get(hit.sessionId);
      return {
        sessionId: hit.sessionId,
        ...(title === undefined ? {} : { title: redact(title) }),
        kind: hit.kind,
        firstSeq: hit.firstSeq,
        lastSeq: hit.lastSeq,
        ts: hit.ts,
        // The index only ever holds redacted text; redacting again costs
        // little and keeps this true if that ever changes.
        snippet: redact(hit.snippet),
      };
    });
    const loggedQuery = redact(query);
    const targets = [...new Set(results.map((hit) => hit.sessionId))];
    this.logCaller(caller, { op: "search", query: loggedQuery, hits: results.length, sessions: targets });
    for (const target of targets) {
      const ranges = results.filter((hit) => hit.sessionId === target);
      this.logTarget(caller, target, {
        op: "search",
        query: loggedQuery,
        fromSeq: Math.min(...ranges.map((hit) => hit.firstSeq)),
        toSeq: Math.max(...ranges.map((hit) => hit.lastSeq)),
      });
    }
    return results;
  }

  read(caller: LinkCaller, targetId: string, options: ReadOptions = {}): ReadResult {
    this.authorize(caller, "sessions_read", "read");
    const target = this.requireVisible(caller, "read", targetId);
    const fromSeq = clampInt(options.fromSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(options.limit, DEFAULT_TRANSCRIPT_LIMIT, 1, MAX_TRANSCRIPT_LIMIT);
    const events = this.store.replay(target.id, fromSeq, TRANSCRIPT_EVENT_WINDOW);
    const page = normalizeTranscript(events, {
      fromSeq,
      limit,
      maxBytes: TRANSCRIPT_PAGE_BYTES,
      hasMore: events.length === TRANSCRIPT_EVENT_WINDOW,
    });
    // Redact the whole page at once so a secret split across two entries is
    // still one match; then each entry is redacted on its own for callers
    // that use them separately.
    const redacted: ReadResult = {
      ...page,
      text: redact(page.text),
      entries: page.entries.map((entry) => ({ ...entry, text: redact(entry.text) })),
      sessionId: target.id,
      ...(target.title === undefined ? {} : { title: redact(target.title) }),
    };
    const range = {
      fromSeq: page.entries[0]?.firstSeq ?? fromSeq,
      ...(page.toSeq === null ? {} : { toSeq: page.toSeq }),
    };
    this.logCaller(caller, { op: "read", target: target.id, ...range });
    this.logTarget(caller, target.id, { op: "read", ...range });
    return redacted;
  }

  /**
   * Sends a peer message. The target must be a live, trusted, interactive
   * session the caller can see, and not the caller itself; a session caller
   * must itself be trusted and interactive (the trust table), within its
   * rate, and under the hop limit. The message is redacted (a token one
   * session saw does not travel to another) and then it is a prompt and
   * nothing else.
   */
  message(caller: LinkCaller, to: string, text: string): { messageId: string; delivery: "turn" | "queued" } {
    this.authorize(caller, "sessions_message", "message");
    if (typeof text !== "string" || text.trim().length === 0) {
      throw this.refuse(caller, "message", "invalid", "text must be a non-empty string", to);
    }
    if (text.length > MAX_PEER_MESSAGE_LENGTH) {
      throw this.refuse(caller, "message", "invalid", `text is longer than ${MAX_PEER_MESSAGE_LENGTH} characters`, to);
    }
    const target = this.requireVisible(caller, "message", to);
    if (caller.kind === "session" && caller.id === target.id) {
      throw this.refuse(caller, "message", "refused", "a session cannot message itself", target.id);
    }
    this.requireReachable(caller, "message", target);
    const hop = this.nextHop(caller);
    if (hop > this.config.limits.maxHops) {
      throw this.refuse(
        caller,
        "message",
        "refused",
        `dropped: this message would be hop ${hop}, past the limit of ${this.config.limits.maxHops} session-to-session hops`,
        target.id,
      );
    }
    this.takeRate(caller, "message", target.id);
    const messageId = crypto.randomUUID();
    const input: PeerMessageInput = {
      messageId,
      ...this.senderInfo(caller),
      to: target.id,
      text: redact(text),
      hop,
    };
    this.logCaller(caller, { op: "message", target: target.id, peer: target.id, messageId, hop });
    this.logTarget(caller, target.id, {
      op: "message",
      messageId,
      hop,
      ...(caller.kind === "session" ? { peer: caller.id } : {}),
    });
    let event: ReturnType<SessionManager["deliverPeerMessage"]>;
    try {
      event = this.manager.deliverPeerMessage(input);
    } catch (error) {
      throw this.refuse(
        caller,
        "message",
        "refused",
        `could not deliver: ${error instanceof Error ? error.message : String(error)}`,
        target.id,
      );
    }
    return { messageId, delivery: (event.payload as PeerMessagePayload).delivery };
  }

  /**
   * Starts a child session and returns its id once its first turn is
   * running. The child is trusted (a trusted session started it) and
   * interactive unless asked for review; the parent/child link is on the
   * child's record, and both logs carry the spawn.
   */
  async spawn(caller: LinkCaller, options: SpawnOptions): Promise<SpawnResult> {
    this.authorize(caller, "sessions_spawn", "spawn");
    const parent = caller.kind === "session" ? this.store.get(caller.id) : undefined;
    const backend: BackendId = options.backend ?? "claude-acp";
    const mode: SessionMode = options.mode ?? "interactive";
    if (backend !== "claude-acp" && backend !== "codex-acp") {
      throw this.refuse(caller, "spawn", "invalid", `backend must be claude-acp or codex-acp, not ${backend}`);
    }
    if (mode !== "interactive" && mode !== "review") {
      throw this.refuse(caller, "spawn", "invalid", "mode must be interactive or review");
    }
    if (typeof options.prompt !== "string" || options.prompt.trim().length === 0) {
      throw this.refuse(caller, "spawn", "invalid", "prompt must be a non-empty string");
    }
    if (options.prompt.length > MAX_PEER_MESSAGE_LENGTH) {
      throw this.refuse(caller, "spawn", "invalid", `prompt is longer than ${MAX_PEER_MESSAGE_LENGTH} characters`);
    }
    if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) {
      throw this.refuse(caller, "spawn", "invalid", "cwd must be an absolute path");
    }
    const cwd = resolvePath(options.cwd);
    if (!isDirectory(cwd)) {
      throw this.refuse(caller, "spawn", "invalid", `cwd ${cwd} is not a directory`);
    }
    if (caller.kind === "session" && this.scopeRoots !== undefined) {
      const root = this.repos.resolve(cwd);
      if (root === undefined || !this.scopeRoots.has(root)) {
        throw this.refuse(caller, "spawn", "forbidden", `cwd ${cwd} is outside the repos link.json allows`);
      }
    }
    const spawnDepth = (parent?.spawnDepth ?? 0) + (parent ? 1 : 0);
    if (spawnDepth > this.config.limits.maxSpawnDepth) {
      throw this.refuse(
        caller,
        "spawn",
        "refused",
        `spawn depth ${spawnDepth} is past the limit of ${this.config.limits.maxSpawnDepth}`,
      );
    }
    const hop = this.nextHop(caller);
    if (hop > this.config.limits.maxHops) {
      throw this.refuse(
        caller,
        "spawn",
        "refused",
        `dropped: the spawn would be hop ${hop}, past the limit of ${this.config.limits.maxHops}`,
      );
    }
    const running = this.store
      .list()
      .filter(
        (record) =>
          record.parentId !== undefined &&
          (record.status === "running" || record.status === "waiting_for_permission"),
      ).length;
    if (running + this.spawning >= this.config.limits.maxConcurrentSpawned) {
      throw this.refuse(
        caller,
        "spawn",
        "refused",
        `${running + this.spawning} spawned sessions are already running; the limit is ${this.config.limits.maxConcurrentSpawned}`,
      );
    }
    const unavailable = this.backendUnavailable(backend);
    if (unavailable !== undefined) {
      throw this.refuse(caller, "spawn", "unavailable", unavailable);
    }
    if (options.worktree === true && !this.createWorktree) {
      throw this.refuse(caller, "spawn", "unavailable", "worktree spawns are not available on this daemon");
    }
    this.takeRate(caller, "spawn");

    this.spawning += 1;
    try {
      const id = Bun.randomUUIDv7();
      let childCwd = cwd;
      if (options.worktree === true && this.createWorktree) {
        try {
          childCwd = await this.createWorktree(cwd, id);
        } catch (error) {
          throw this.refuse(
            caller,
            "spawn",
            "invalid",
            `could not create a worktree of ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.manager.createRecord({
        id,
        cwd: childCwd,
        mode,
        trust: "trusted",
        backend,
        ...(parent ? { parentId: parent.id } : {}),
        spawnDepth,
      });
      try {
        await this.manager.activate(id);
      } catch (error) {
        await this.manager.close(id).catch(() => {});
        throw this.refuse(
          caller,
          "spawn",
          "unavailable",
          `the ${backend} backend did not start: ${error instanceof Error ? error.message : String(error)}`,
          id,
        );
      }
      this.logCaller(caller, { op: "spawn", target: id, peer: id, backend, mode, worktree: options.worktree === true });
      this.logTarget(caller, id, { op: "spawn", ...(parent ? { peer: parent.id } : {}) });
      // The first prompt is a peer turn from the parent: same provenance
      // header, and the spawn counts as a hop.
      const first: PeerMessagePayload = {
        messageId: crypto.randomUUID(),
        ...this.senderInfo(caller),
        to: id,
        text: redact(options.prompt),
        hop,
        delivery: "turn",
      };
      // prompt() takes the lock and sets the child running before its first
      // await, so a sessions_wait right after this returns sees it busy.
      this.manager.prompt(id, peerPromptRequest(id, first)).catch(() => {});
      return {
        sessionId: id,
        cwd: childCwd,
        backend,
        mode,
        worktree: options.worktree === true,
        ...(parent ? { parentId: parent.id } : {}),
        spawnDepth,
      };
    } finally {
      this.spawning -= 1;
    }
  }

  /**
   * Waits until a session reaches a state, or the timeout passes. idle means
   * really idle: no turn in flight and no queued peer message. A session that
   * closes ends every wait. Driven by the manager's change listener, never by
   * polling.
   */
  async wait(caller: LinkCaller, targetId: string, until: WaitUntil, timeoutMs: number): Promise<WaitResult> {
    this.authorize(caller, "sessions_wait", "wait");
    if (until !== "idle" && until !== "closed" && until !== "waiting_for_permission") {
      throw this.refuse(caller, "wait", "invalid", "until must be idle, closed or waiting_for_permission");
    }
    const target = this.requireVisible(caller, "wait", targetId);
    const timeout = clampInt(timeoutMs, MAX_WAIT_MS, 0, MAX_WAIT_MS);
    this.logCaller(caller, { op: "wait", target: target.id, until });
    this.logTarget(caller, target.id, { op: "wait", until });

    const check = (): WaitResult | undefined => {
      const record = this.store.get(target.id);
      if (!record) {
        return { reached: false, status: "closed" };
      }
      const reached =
        until === "idle"
          ? record.status === "idle" &&
            !this.manager.isTurnInFlight(target.id) &&
            this.manager.queuedPeerMessages(target.id).length === 0
          : record.status === until;
      if (reached || isTerminal(record.status)) {
        return { reached, status: record.status, ...this.lastStopReason(target.id) };
      }
      return undefined;
    };

    const immediate = check();
    if (immediate) {
      return immediate;
    }
    return await new Promise<WaitResult>((resolve) => {
      let done = false;
      const finish = (result: WaitResult) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = this.manager.onSessionChange((id) => {
        if (id !== target.id) {
          return;
        }
        const result = check();
        if (result) {
          finish(result);
        }
      });
      const timer = setTimeout(() => {
        const record = this.store.get(target.id);
        finish({ reached: false, status: record?.status ?? "closed", ...this.lastStopReason(target.id) });
      }, timeout);
    });
  }

  /**
   * Records a tools/call for a tool the session was not offered (a review
   * session calling sessions_message, say) as a refused access on its log.
   */
  recordRefusedTool(sessionId: SessionId, tool: string): void {
    const op = TOOL_OPS[tool as LinkToolName];
    const caller: LinkCaller = { kind: "session", id: sessionId };
    if (op === undefined) {
      return;
    }
    const record = this.store.get(sessionId);
    this.refuse(
      caller,
      op,
      "forbidden",
      record && this.mountAllowed(record)
        ? `${tool} is not available to a ${record.mode} session`
        : "this session has no monad-sessions access",
    );
  }

  // ----------------------------------------------------------------- helpers

  private summarize(record: SessionRecord): LinkSessionSummary {
    return {
      id: record.id,
      ...(record.title === undefined ? {} : { title: redact(record.title) }),
      backend: record.backend,
      status: record.status,
      mode: record.mode,
      cwd: record.cwd,
      repos: this.store.reposFor(record.id).map((repo) => repo.repoRoot),
      updatedAt: record.updatedAt,
      ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
    };
  }

  private lastStopReason(id: SessionId): { lastTurnStopReason?: string } {
    const payload = this.store.lastEventOfKind(id, "turn_ended")?.payload as { stopReason?: unknown } | undefined;
    return typeof payload?.stopReason === "string" ? { lastTurnStopReason: payload.stopReason } : {};
  }

  /** A repo path as session_repos stores it: the canonical repository root. */
  private canonicalRepo(path: string): string {
    return this.repos.resolve(path) ?? resolvePath(path);
  }

  /**
   * The sessions a caller may see, for search's filter. The human sees all
   * of them; a session sees those tagged with an allowlisted repo, or all
   * of them when there is no allowlist.
   */
  private scopedSessionIds(caller: LinkCaller): SessionId[] | undefined {
    if (caller.kind === "human" || this.scopeRoots === undefined) {
      return undefined;
    }
    const ids = new Set<SessionId>();
    for (const root of this.scopeRoots) {
      for (const id of this.store.sessionsForRepo(root)) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  private visibleTo(caller: LinkCaller, sessionId: SessionId): boolean {
    if (caller.kind === "human" || this.scopeRoots === undefined) {
      return true;
    }
    const roots = this.scopeRoots;
    return this.store.reposFor(sessionId).some((repo) => roots.has(repo.repoRoot));
  }

  /**
   * The caller may use this tool now. The human always may (the control API
   * already authenticated them with the daemon token). A session may only
   * call what the trust table offers it, re-read from its record now: a
   * session that went from interactive to review mid-turn loses message and
   * spawn mid-turn.
   */
  private authorize(caller: LinkCaller, tool: LinkToolName, op: AccessOp): void {
    if (caller.kind === "human") {
      return;
    }
    if (!this.toolsFor(caller.id).includes(tool)) {
      const record = this.store.get(caller.id);
      const why =
        !record || !this.mountAllowed(record)
          ? "this session has no monad-sessions access"
          : `${tool} is not available to a ${record.mode} session`;
      throw this.refuse(caller, op, "forbidden", why);
    }
  }

  private requireVisible(caller: LinkCaller, op: AccessOp, targetId: string): SessionRecord {
    const target = typeof targetId === "string" ? this.store.get(targetId) : undefined;
    if (!target || !this.visibleTo(caller, target.id)) {
      // One answer for "absent" and "out of scope", so scope is not an oracle.
      throw this.refuse(caller, op, "not_found", `no session ${String(targetId)}`);
    }
    return target;
  }

  /** A message target must be a live, trusted, interactive session. */
  private requireReachable(caller: LinkCaller, op: AccessOp, target: SessionRecord): void {
    if (isTerminal(target.status)) {
      throw this.refuse(caller, op, "refused", `session ${target.id} is ${target.status}`, target.id);
    }
    if (target.trust !== "trusted") {
      throw this.refuse(caller, op, "refused", `session ${target.id} is untrusted and takes no peer messages`, target.id);
    }
    if (target.mode !== "interactive") {
      throw this.refuse(
        caller,
        op,
        "refused",
        `session ${target.id} is a ${target.mode} session; only interactive sessions take peer messages`,
        target.id,
      );
    }
  }

  /**
   * The hop count a message or spawn from this caller carries: one more
   * than the turn the caller is in (0 for a turn a human started). The
   * human at the CLI is hop 0 itself.
   */
  private nextHop(caller: LinkCaller): number {
    if (caller.kind === "human") {
      return 0;
    }
    return turnHop(this.store.lastEventOfKind(caller.id, "prompt")?.payload) + 1;
  }

  private takeRate(caller: LinkCaller, op: AccessOp, target?: SessionId): void {
    if (caller.kind === "human") {
      return;
    }
    if (!this.rate.take(caller.id)) {
      throw this.refuse(
        caller,
        op,
        "rate_limited",
        `rate limited: at most ${this.config.limits.messagesPerMinute} messages and spawns a minute (burst ${this.config.limits.messageBurst})`,
        target,
      );
    }
  }

  private senderInfo(caller: LinkCaller): Pick<PeerMessageInput, "from" | "fromTitle" | "fromRepo"> {
    if (caller.kind === "human") {
      return { from: "human" };
    }
    const record = this.store.get(caller.id);
    const repo = this.store.reposFor(caller.id)[0]?.repoRoot ?? (record ? this.repos.resolve(record.cwd) : undefined);
    return {
      from: caller.id,
      ...(record?.title === undefined ? {} : { fromTitle: redact(record.title) }),
      ...(repo === undefined ? {} : { fromRepo: repo }),
    };
  }

  /** Builds a LinkError and records the refusal on a session caller's log. */
  private refuse(caller: LinkCaller, op: AccessOp, code: LinkErrorCode, message: string, target?: string): LinkError {
    this.logCaller(caller, {
      op,
      ...(target !== undefined && this.store.get(target) ? { target } : {}),
      refused: message,
    });
    return new LinkError(code, message);
  }

  private logCaller(caller: LinkCaller, fields: Partial<AccessPayload> & Record<string, unknown>): void {
    if (caller.kind !== "session" || !this.store.get(caller.id)) {
      return;
    }
    this.append(caller.id, { ...fields, by: caller.id, role: "caller" } as AccessPayload);
  }

  private logTarget(caller: LinkCaller, target: SessionId, fields: Partial<AccessPayload> & Record<string, unknown>): void {
    if (caller.kind === "session" && caller.id === target) {
      return; // A session reading itself is on its log once, as the caller.
    }
    this.append(target, { ...fields, by: actorOf(caller), role: "target", target } as AccessPayload);
  }

  private append(sessionId: SessionId, payload: AccessPayload): void {
    try {
      this.manager.appendEvent(sessionId, "access", payload);
    } catch {
      // The session vanished between the check and the log; nothing to record on.
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
