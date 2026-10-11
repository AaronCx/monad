import {
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  ActiveBackend,
  BackendId,
  ErrorPayload,
  EventKind,
  EventRecord,
  PeerMessagePayload,
  SessionId,
  SessionMode,
  SessionPr,
  SessionRecord,
  SessionStatus,
  TrustLevel,
} from "@aaroncx/protocol";
import { peerPromptRequest, undeliveredPeerMessages } from "./peer.ts";
import {
  editedExecAllowlistInputs,
  execAllowlistFromManifest,
  fixExecAllowlist,
  ModeAwarePermissionPolicy,
  type PermissionClient,
  type PermissionPolicy,
  type PermissionPolicyHooks,
} from "./policy.ts";
import type { SessionStore } from "./store.ts";
import { ensureFixBranch, fixBranchName, readFileAtRef } from "./worktree.ts";

/**
 * JSON-RPC error code returned when a prompt is already in flight.
 *
 * Deliberately NOT -32000: the SDK's RequestError.authRequired() uses -32000,
 * and clients must be able to tell "log in to the vendor" apart from "wait
 * for the current turn" by code alone.
 */
export const PROMPT_IN_FLIGHT_ERROR_CODE = -32001;

/**
 * A monad client attached to a session: it receives every appended event
 * live and can answer permission requests.
 */
export interface SessionClient extends PermissionClient {
  onEvent(event: EventRecord): void;
}

/**
 * What the engine needs from a backend. packages/backends implements this
 * around a spawned vendor ACP agent.
 */
export interface SessionBackend {
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  /**
   * Applies a monad session mode's vendor layer (review => plan mode, fix
   * and interactive => default; decision 0007). Optional: backends without
   * vendor modes simply do not implement it.
   */
  setSessionMode?(mode: SessionMode): Promise<void>;
}

/**
 * Callbacks a backend uses to reach the engine. The manager appends events,
 * fans them out, and routes permission requests through the policy.
 */
export interface BackendHooks {
  /** Store a session/update notification verbatim and fan it out. */
  onUpdate(params: SessionNotification): void;
  /** Route an agent-side session/request_permission through the policy. */
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Record the vendor adapter's own session id for restore-on-restart. */
  setAgentSessionId(agentSessionId: string): void;
  /**
   * Append an error event visible to subscribers and in replays. Backends use
   * this for degradations that must never be silent, such as a failed vendor
   * session/load after a daemon restart (context not restored).
   */
  onError(payload: ErrorPayload): void;
}

export type BackendFactory = (
  record: SessionRecord,
  hooks: BackendHooks,
) => Promise<SessionBackend> | SessionBackend;

/** Try-lock mutex: one prompt in flight per session, a second one errors. */
class PromptLock {
  private held = false;

  tryAcquire(): boolean {
    if (this.held) {
      return false;
    }
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
  }

  get isHeld(): boolean {
    return this.held;
  }
}

/**
 * Called whenever something that decides a session's Link wait condition may
 * have changed: its status, or a turn settling (the prompt lock released).
 * Listeners re-read what they need; the call carries only the id.
 */
export type SessionChangeListener = (id: SessionId) => void;

/**
 * Decides whether a queued or incoming peer message may start a turn on an
 * otherwise ready session now. Link installs one to hold spawned sessions to
 * the daemon's concurrency cap (decision record 0012); a refused message
 * stays queued and is retried whenever a session's turn ends or it closes.
 */
export type PeerTurnGate = (record: SessionRecord) => boolean;

interface LiveSession {
  id: SessionId;
  backend?: SessionBackend;
  backendStarting?: Promise<SessionBackend>;
  subscribers: Set<SessionClient>;
  lastActive?: SessionClient;
  promptLock: PromptLock;
}

export interface SessionManagerOptions {
  store: SessionStore;
  createBackend: BackendFactory;
  /**
   * Builds the permission policy from hooks the manager provides (persisting
   * permission events through the fan-out path and flipping session status).
   * Defaults to the mode-aware policy (interactive forwarding for
   * interactive sessions, auto-deciding review/fix policies for review and
   * fix sessions); injectable for tests.
   */
  createPolicy?: (hooks: PermissionPolicyHooks) => PermissionPolicy;
}

export interface CreateSessionParams {
  /** Caller-supplied id (the review playbook names the worktree after it). */
  id?: SessionId;
  cwd: string;
  mode?: SessionMode;
  /**
   * Decision record 0009. Interactive sessions from `monad run` are trusted
   * (you own the repo you are sitting in); review sessions carry whatever
   * the review playbook resolved, and a fix session is the same record, so
   * it inherits that level. Absent means trusted for an interactive session
   * and untrusted for a review or fix one, so a caller that forgets never
   * gets the permissive answer on a PR.
   */
  trust?: TrustLevel;
  base?: string;
  head?: string;
  pr?: SessionPr;
  /** Vendor adapter. Default claude-acp. Link's sessions_spawn may pick codex-acp. */
  backend?: BackendId;
  /** The session that spawned this one (Link), and the depth that puts it at. */
  parentId?: SessionId;
  spawnDepth?: number;
}

/** Input of deliverPeerMessage: a peer_message payload minus its delivery. */
export type PeerMessageInput = Omit<PeerMessagePayload, "delivery">;

export interface AttachResult {
  record: SessionRecord;
  /** The full event log in seq order; the caller replays it to the client. */
  events: EventRecord[];
  /**
   * The OLDEST held permission request, re-delivered to the attaching client.
   * Kept for callers that only ever showed one; pendingPermissions is the
   * whole set, and a session can hold several at once because the agent
   * issues tool calls in parallel.
   */
  pendingPermission?: RequestPermissionRequest;
  /**
   * Every held permission request, oldest first, all of them re-delivered to
   * the attaching client. The client answers them in sequence.
   */
  pendingPermissions: RequestPermissionRequest[];
}

/**
 * Owns one live Session per session id: the backend handle, the subscriber
 * set, and the single-prompt-in-flight lock. Everything appended to the log
 * goes through here so subscribers always see exactly what the store saw.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly policy: PermissionPolicy;
  private readonly createBackend: BackendFactory;
  private readonly live = new Map<SessionId, LiveSession>();
  /**
   * Sessions known to have edited package.json or a lockfile. Editing one is
   * monotone, so this only ever grows and only ever saves a log scan; it is
   * never the source of a permissive answer.
   */
  private readonly allowlistInputsEdited = new Set<SessionId>();
  private readonly changeListeners = new Set<SessionChangeListener>();
  /**
   * Set by beginShutdown() (and shutdown()). From then on no deferred peer
   * drain starts a turn: the daemon is about to cancel and close everything,
   * and a turn started now would log its prompt (marking the message
   * delivered) and then be killed, losing the message across the restart.
   */
  private stopping = false;
  /** Sessions with a peer drain already scheduled, so a burst schedules one. */
  private readonly drainsScheduled = new Set<SessionId>();
  /** Sessions whose queued message the peer turn gate held back; retried as slots free. */
  private readonly gatedQueues = new Set<SessionId>();
  private peerTurnGate?: PeerTurnGate;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.createBackend = options.createBackend;
    const hooks: PermissionPolicyHooks = {
      persistRequested: (id, params) => {
        this.appendAndPublish(id, "permission_requested", params);
      },
      persistResolved: (id, response, meta) => {
        this.appendAndPublish(id, "permission_resolved", { ...response, ...meta });
      },
      setStatus: (id, status) => {
        this.setStatus(id, status);
      },
    };
    const createPolicy =
      options.createPolicy ??
      ((h: PermissionPolicyHooks) =>
        new ModeAwarePermissionPolicy({
          hooks: h,
          resolveContext: (id) => {
            const record = this.store.get(id);
            if (!record) {
              return undefined;
            }
            if (record.mode !== "fix") {
              return { mode: record.mode, cwd: record.cwd, trust: record.trust };
            }
            return {
              mode: record.mode,
              cwd: record.cwd,
              trust: record.trust,
              // Frozen at fix-mode entry (decision record 0009). Reading it
              // off the record rather than off the worktree is the whole
              // point: the worktree is what the agent edits. Only fix mode
              // consults either field, so only fix mode pays for the scan.
              execAllowlist: record.execAllowlist,
              execAllowlistInputsEdited: this.editedExecAllowlistInputs(id),
            };
          },
          beforeEditGrant: async (id) => {
            // Fix sessions branch lazily on the first granted edit; sessions
            // without PR metadata (a fix switch on a plain repo) stay on
            // whatever HEAD they have.
            const record = this.store.get(id);
            if (record?.mode === "fix" && record.pr) {
              await ensureFixBranch({
                worktreePath: record.cwd,
                branchName: fixBranchName(record.pr),
              });
            }
          },
        }));
    this.policy = createPolicy(hooks);
  }

  async create(params: CreateSessionParams): Promise<SessionRecord> {
    const record = this.createRecord(params);
    return await this.activate(record.id);
  }

  /**
   * Inserts the session row without starting a backend or appending any
   * event. The review playbook uses this to get a session id (worktree paths
   * embed it) and append its pre-session events (worktree_ready, checks)
   * before the vendor session exists; plain create() wraps this + activate.
   */
  createRecord(params: CreateSessionParams): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: params.id ?? Bun.randomUUIDv7(),
      cwd: params.cwd,
      backend: params.backend ?? "claude-acp",
      mode: params.mode ?? "interactive",
      status: "idle",
      trust: params.trust ?? ((params.mode ?? "interactive") === "interactive" ? "trusted" : "untrusted"),
      // Review sessions pin the checks diff to the PR's shas; interactive
      // sessions leave both unset.
      base: params.base,
      head: params.head,
      pr: params.pr,
      parentId: params.parentId,
      spawnDepth: params.spawnDepth,
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(record);
    return record;
  }

  /**
   * Appends session_created and starts the backend (spawn failures surface).
   * options.afterCreated runs synchronously right after session_created is
   * logged and before the backend starts: Link's spawn starts the child's
   * first turn there, so it holds the prompt lock before anyone else can
   * reach the child, and a message that arrives while the vendor adapter is
   * still starting queues behind it instead of racing it.
   */
  async activate(id: SessionId, options?: { afterCreated?: () => void }): Promise<SessionRecord> {
    const record = this.mustGet(id);
    if (record.mode === "fix") {
      // A session created directly in fix mode never passes through setMode,
      // so freeze its allowlist here too. Both paths are idempotent.
      await this.freezeExecAllowlist(id);
    }
    this.appendAndPublish(record.id, "session_created", this.mustGet(record.id));
    options?.afterCreated?.();
    await this.ensureBackend(record.id);
    return this.mustGet(record.id);
  }

  /**
   * Appends one event to a session's log and fans it out to subscribers.
   * The review playbook appends its step events (worktree_ready, checks,
   * review_report) through this.
   */
  appendEvent(id: SessionId, kind: EventKind, payload: unknown): EventRecord {
    this.mustGet(id);
    return this.appendAndPublish(id, kind, payload);
  }

  /**
   * Switches a session's stored mode and applies the vendor layer on the
   * live backend (review => plan, fix/interactive => default). With no live
   * backend the mode is picked up when the next backend starts (the factory
   * reads the record fresh).
   *
   * Trust is deliberately NOT touched here: "fix it" on an untrusted review
   * is the same session and the same worktree, so it keeps the same level
   * (decision record 0009).
   */
  async setMode(id: SessionId, mode: SessionMode): Promise<SessionRecord> {
    this.mustGet(id);
    this.store.setMode(id, mode);
    if (mode === "fix") {
      await this.freezeExecAllowlist(id);
    }
    const backend = this.live.get(id)?.backend;
    if (backend?.setSessionMode) {
      await backend.setSessionMode(mode);
    }
    if (mode === "interactive") {
      // Messages queued while the session was review or fix (or busy) are
      // deliverable again; without this they wait for an unrelated turn.
      this.schedulePeerDrain(id);
    }
    return this.mustGet(id);
  }

  /**
   * Names a session by hand (title) or drops the manual name and derives one
   * from its first prompt again (null). A manual title is never overwritten
   * by prompt derivation (monad Link, decision record 0012).
   */
  setTitle(id: SessionId, title: string | null): SessionRecord {
    this.mustGet(id);
    if (title === null) {
      this.store.resetTitle(id);
    } else {
      this.store.setTitle(id, title, "manual");
    }
    return this.mustGet(id);
  }

  list(): SessionRecord[] {
    return this.store.list();
  }

  get(id: SessionId): SessionRecord | undefined {
    return this.store.get(id);
  }

  activeBackends(): ActiveBackend[] {
    const result: ActiveBackend[] = [];
    for (const [id, session] of this.live) {
      if (session.backend) {
        const record = this.store.get(id);
        if (record) {
          result.push({ sessionId: id, backend: record.backend });
        }
      }
    }
    return result;
  }

  /**
   * Subscribes a client: returns the record, the full replay, and every held
   * permission request (all of which are re-delivered to this client, oldest
   * first, for it to answer in sequence).
   */
  attach(id: SessionId, client: SessionClient): AttachResult {
    const record = this.mustGet(id);
    const session = this.ensureLive(id);
    session.subscribers.add(client);
    session.lastActive = client;
    const events = this.store.replay(id);
    const pendingPermissions = this.policy.deliverPending(id, client);
    return { record, events, pendingPermission: pendingPermissions[0], pendingPermissions };
  }

  detach(id: SessionId, client: SessionClient): void {
    const session = this.live.get(id);
    if (!session) {
      return;
    }
    session.subscribers.delete(client);
    if (session.lastActive === client) {
      session.lastActive = [...session.subscribers].at(-1);
    }
  }

  /** Marks a client as the most recently active one for permission routing. */
  markActive(id: SessionId, client: SessionClient): void {
    const session = this.live.get(id);
    if (session?.subscribers.has(client)) {
      session.lastActive = client;
    }
  }

  /**
   * Runs one prompt turn. Appends the prompt verbatim, forwards it to the
   * backend, and appends turn_ended with the backend's stopReason. A second
   * prompt while one is in flight fails with a JSON-RPC error; M1 does not
   * queue. options.beforeTurnEnded runs after the backend's turn resolves
   * but before turn_ended is appended; the review playbook uses it to place
   * its review_report event inside the turn (it must never throw).
   */
  async prompt(
    id: SessionId,
    params: PromptRequest,
    client?: SessionClient,
    options?: { beforeTurnEnded?: (stopReason: string) => void },
  ): Promise<PromptResponse> {
    const session = this.ensureLive(id);
    this.mustGet(id);
    if (client) {
      this.markActive(id, client);
    }
    if (!session.promptLock.tryAcquire()) {
      throw new RequestError(
        PROMPT_IN_FLIGHT_ERROR_CODE,
        "a prompt is already in flight for this session; wait for the turn to end",
        { sessionId: id },
      );
    }
    try {
      this.appendAndPublish(id, "prompt", params);
      this.setStatus(id, "running");
      const backend = await this.ensureBackend(id);
      const response = await backend.prompt(params);
      options?.beforeTurnEnded?.(response.stopReason);
      this.appendAndPublish(id, "turn_ended", { stopReason: response.stopReason });
      this.setStatus(id, "idle");
      return response;
    } catch (error) {
      this.appendAndPublish(id, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(id, "idle");
      throw error;
    } finally {
      session.promptLock.release();
      // The turn boundary. Waiters re-check now that the lock is free, and
      // one queued peer message (if any) gets the next turn. The drain is
      // deferred so this turn's response reaches its caller before the next
      // turn's prompt is published.
      this.notifyChange(id);
      this.schedulePeerDrain(id);
    }
  }

  /** True while a prompt turn holds the session's lock. */
  isTurnInFlight(id: SessionId): boolean {
    return this.live.get(id)?.promptLock.isHeld ?? false;
  }

  /** How many permission requests the session is holding for a human. */
  pendingPermissionCount(id: SessionId): number {
    return this.policy.pendingRequests(id).length;
  }

  /**
   * Installs the gate that decides whether a peer message may start a turn
   * on an otherwise ready session (Link's spawned-session concurrency cap).
   * Direct prompts (a human attached with `monad attach`) are not gated.
   */
  setPeerTurnGate(gate: PeerTurnGate | undefined): void {
    this.peerTurnGate = gate;
  }

  /**
   * Subscribes to session changes (status flips and turn boundaries). Link's
   * sessions_wait uses this instead of polling. Returns the unsubscribe.
   */
  onSessionChange(listener: SessionChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Queued peer messages the session has not been delivered yet, oldest first. */
  queuedPeerMessages(id: SessionId): PeerMessagePayload[] {
    return undeliveredPeerMessages(this.store.replayKinds(id, ["peer_message", "prompt"]));
  }

  /**
   * Delivers a peer message (monad Link, decision record 0012). It is
   * appended to the target's log as a peer_message event, and then it is a
   * PROMPT and nothing else: if the target is idle it starts the target's
   * next turn now; otherwise it waits in the queue for a turn boundary. In
   * particular a session waiting on a permission is not idle, so a message
   * that arrives then ("approve it", an optionId, a JSON outcome) is queued
   * behind the human's answer and never reaches the policy. Only a client's
   * requestPermission answer resolves a held request.
   *
   * The caller (LinkService) has already decided the sender may reach this
   * target; this only refuses targets that can never take a turn.
   */
  deliverPeerMessage(input: PeerMessageInput): EventRecord {
    const record = this.mustGet(input.to);
    if (record.status === "closed" || record.status === "imported") {
      throw RequestError.invalidParams(undefined, `session ${input.to} is ${record.status}`);
    }
    const deliverNow = this.readyForPeerTurn(record);
    const payload: PeerMessagePayload = { ...input, delivery: deliverNow ? "turn" : "queued" };
    const event = this.appendAndPublish(input.to, "peer_message", payload);
    if (deliverNow) {
      this.startPeerTurn(input.to, payload);
    } else {
      // Queued behind a backlog on a session that may be ready right now
      // (its older messages are waiting for exactly this): the drain delivers
      // the OLDEST one, so order holds and nothing waits for an unrelated
      // turn. A busy session's drain is a no-op until its boundary.
      this.schedulePeerDrain(input.to);
    }
    return event;
  }

  /**
   * Delivers queued peer messages left in the log by a previous daemon run:
   * every idle session with a queue gets its oldest message as a turn now,
   * the rest at later boundaries. Called once at daemon start.
   */
  resumePeerQueues(): void {
    for (const record of this.store.list()) {
      if (record.status === "idle") {
        this.drainPeerQueue(record.id);
      }
    }
  }

  /**
   * Puts sessions a previous daemon left mid-turn back to idle. Called once
   * at daemon start, before resumePeerQueues. A fresh process has no turn in
   * flight and holds no permission, so a stored running or
   * waiting_for_permission status can only be stale: the daemon died
   * (SIGKILL, crash, power loss) without the graceful cancel. Left alone it
   * would strand the session's peer queue, make sessions_wait(idle) time
   * out, and hold a spawned-session slot forever. Each recovered session
   * gets an error event saying its turn was interrupted. Returns their ids.
   */
  recoverInterruptedTurns(): SessionId[] {
    const recovered: SessionId[] = [];
    for (const record of this.store.list()) {
      if (record.status !== "running" && record.status !== "waiting_for_permission") {
        continue;
      }
      if (this.isTurnInFlight(record.id) || this.pendingPermissionCount(record.id) > 0) {
        continue; // Live in this process after all; nothing to recover.
      }
      this.appendAndPublish(record.id, "error", {
        message: `the daemon stopped while this session was ${record.status === "running" ? "running a turn" : "waiting for a permission"}; that turn was interrupted`,
      });
      this.store.setStatus(record.id, "idle");
      this.notifyChange(record.id);
      recovered.push(record.id);
    }
    return recovered;
  }

  /** Cancels the in-flight turn and resolves any held permission request. */
  async cancel(id: SessionId): Promise<void> {
    const session = this.live.get(id);
    this.policy.cancel(id);
    if (session?.backend) {
      await session.backend.cancel();
    }
    this.setStatus(id, "idle");
    // With no turn in flight (nothing to end and drain at its boundary),
    // the idle session can take its queued peer message now.
    this.schedulePeerDrain(id);
  }

  /** Closes a session for good: backend down, closed event, status closed. */
  async close(id: SessionId): Promise<void> {
    const session = this.live.get(id);
    this.policy.cancel(id);
    if (session?.backend) {
      await session.backend.close();
    }
    this.live.delete(id);
    this.appendAndPublish(id, "closed", null);
    this.setStatus(id, "closed");
  }

  /**
   * Stops peer delivery ahead of a daemon shutdown. The daemon calls this
   * before it cancels in-flight turns: a cancelled turn's boundary (or one
   * that ended just before the signal) would otherwise start the next
   * queued message's turn mid-shutdown, log its prompt and then lose it.
   * Messages stay queued in the log and are delivered after the restart.
   */
  beginShutdown(): void {
    this.stopping = true;
  }

  /** Daemon shutdown: closes every live backend without closing sessions. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const session of this.live.values()) {
      if (session.backend) {
        await session.backend.close();
      }
    }
    this.live.clear();
  }

  /**
   * Freezes the fix policy's execute allowlist on the record the first time a
   * session enters fix mode, from a source the session itself cannot edit
   * (decision record 0009, finding 3).
   *
   * Order, strictest first:
   * 1. A review-derived session reads `git show <baseSha>:package.json`. The
   *    base is the last state a repo maintainer approved, and open decision 4
   *    picks it over the fix-entry state deliberately: an earlier legitimate
   *    fix commit adding a script is the cost, and it is a cheap one (that
   *    command forwards to the human once instead of running unattended).
   * 2. A trusted session with no PR (you switched `monad run` to fix in your
   *    own repo) reads the worktree's package.json, which is yours.
   * 3. Anything else gets the git prefixes alone.
   *
   * Written exactly once. A session already carrying a list keeps it, so a
   * second `--mode fix` cannot refresh it against an edited worktree.
   */
  private async freezeExecAllowlist(id: SessionId): Promise<void> {
    const record = this.mustGet(id);
    if (record.execAllowlist !== undefined) {
      return;
    }
    const baseSha = record.pr?.baseSha ?? record.base;
    let allowlist: string[];
    if (baseSha !== undefined && baseSha.length > 0) {
      allowlist = execAllowlistFromManifest(
        await readFileAtRef(record.cwd, baseSha, "package.json"),
      );
    } else if (record.trust === "trusted") {
      allowlist = fixExecAllowlist(record.cwd);
    } else {
      allowlist = execAllowlistFromManifest(undefined);
    }
    this.store.setExecAllowlist(id, allowlist);
  }

  /**
   * Whether the session has been granted an edit to package.json or a
   * lockfile, reconstructed from the permission events already in the log so
   * this needs no new state. Monotone (an edit never un-happens), so a true
   * answer is memoized and the log is not scanned again.
   */
  private editedExecAllowlistInputs(id: SessionId): boolean {
    if (this.allowlistInputsEdited.has(id)) {
      return true;
    }
    let edited: boolean;
    try {
      edited = editedExecAllowlistInputs(
        this.store.replayKinds(id, ["permission_requested", "permission_resolved"]),
      );
    } catch {
      // The edited set could not be determined; default deny (record 0009).
      edited = true;
    }
    if (edited) {
      this.allowlistInputsEdited.add(id);
    }
    return edited;
  }

  /**
   * Persists a status and tells change listeners. A session leaving running
   * or waiting_for_permission may free a spawned-session slot, so messages
   * the peer turn gate held back are retried.
   */
  private setStatus(id: SessionId, status: SessionStatus): void {
    this.store.setStatus(id, status);
    this.notifyChange(id);
    if ((status === "idle" || status === "closed") && this.gatedQueues.size > 0) {
      for (const gated of this.gatedQueues) {
        if (gated !== id) {
          this.schedulePeerDrain(gated);
        }
      }
    }
  }

  private notifyChange(id: SessionId): void {
    for (const listener of this.changeListeners) {
      try {
        listener(id);
      } catch {
        // A broken listener must not break a status change or its peers.
      }
    }
  }

  /**
   * Whether a peer message may start a turn right now: the session is idle,
   * no turn holds its lock, no permission is held, nothing is queued ahead
   * of it, it is an interactive session, and the peer turn gate (Link's
   * spawned-session cap) lets it run. A session switched to review or fix
   * after a message was queued keeps the message queued until it is
   * interactive again (setMode then drains it): peers only ever reach
   * interactive sessions.
   */
  private readyForPeerTurn(record: SessionRecord): boolean {
    return (
      this.canTakePeerTurn(record) &&
      this.queuedPeerMessages(record.id).length === 0 &&
      this.gateAllows(record)
    );
  }

  /** The session-side half of readiness: idle, interactive, unlocked, holding nothing. */
  private canTakePeerTurn(record: SessionRecord): boolean {
    return (
      record.status === "idle" &&
      record.mode === "interactive" &&
      !this.isTurnInFlight(record.id) &&
      this.pendingPermissionCount(record.id) === 0
    );
  }

  private gateAllows(record: SessionRecord): boolean {
    if (!this.peerTurnGate) {
      return true;
    }
    try {
      return this.peerTurnGate(record);
    } catch {
      return false; // A broken gate holds messages; it never lets one through.
    }
  }

  /**
   * Starts the turn that delivers one peer message. Not awaited: the sender
   * learns the message was delivered, not what the target made of it (it
   * can sessions_wait and sessions_read for that). prompt() takes the lock
   * and logs the prompt synchronously, before its first await, so the
   * session is running by the time this returns. A failed turn is already
   * an error event on the target's log.
   */
  private startPeerTurn(id: SessionId, message: PeerMessagePayload): void {
    this.prompt(id, peerPromptRequest(id, message)).catch(() => {});
  }

  private schedulePeerDrain(id: SessionId): void {
    if (this.stopping || this.drainsScheduled.has(id)) {
      return;
    }
    this.drainsScheduled.add(id);
    setTimeout(() => {
      this.drainsScheduled.delete(id);
      this.drainPeerQueue(id);
    }, 0);
  }

  /** Delivers the oldest queued peer message when the session can take it. */
  private drainPeerQueue(id: SessionId): void {
    if (this.stopping) {
      return;
    }
    let record: SessionRecord | undefined;
    try {
      record = this.store.get(id);
    } catch {
      return; // The store is gone (daemon shutting down).
    }
    if (!record || record.status === "closed" || record.status === "imported") {
      this.gatedQueues.delete(id);
      return;
    }
    if (!this.canTakePeerTurn(record)) {
      return;
    }
    const next = this.queuedPeerMessages(id)[0];
    if (!next) {
      this.gatedQueues.delete(id);
      return;
    }
    if (!this.gateAllows(record)) {
      this.gatedQueues.add(id);
      return;
    }
    this.gatedQueues.delete(id);
    this.startPeerTurn(id, next);
  }

  private appendAndPublish(id: SessionId, kind: EventRecord["kind"], payload: unknown): EventRecord {
    const event = this.store.append(id, kind, payload);
    const session = this.live.get(id);
    if (session) {
      for (const subscriber of session.subscribers) {
        try {
          subscriber.onEvent(event);
        } catch {
          // A dead subscriber must not break the append path or its peers.
        }
      }
    }
    return event;
  }

  private ensureLive(id: SessionId): LiveSession {
    let session = this.live.get(id);
    if (!session) {
      this.mustGet(id);
      session = { id, subscribers: new Set(), promptLock: new PromptLock() };
      this.live.set(id, session);
    }
    return session;
  }

  private async ensureBackend(id: SessionId): Promise<SessionBackend> {
    const session = this.ensureLive(id);
    if (session.backend) {
      return session.backend;
    }
    if (!session.backendStarting) {
      const record = this.mustGet(id);
      const hooks: BackendHooks = {
        onUpdate: (params) => {
          this.appendAndPublish(id, "update", params);
        },
        requestPermission: (params) => {
          const live = this.live.get(id);
          return this.policy.request(id, params, live?.lastActive);
        },
        setAgentSessionId: (agentSessionId) => {
          this.store.setAgentSessionId(id, agentSessionId);
        },
        onError: (payload) => {
          this.appendAndPublish(id, "error", payload);
        },
      };
      session.backendStarting = Promise.resolve(this.createBackend(record, hooks));
    }
    try {
      session.backend = await session.backendStarting;
    } catch (error) {
      session.backendStarting = undefined;
      throw error;
    }
    return session.backend;
  }

  private mustGet(id: SessionId): SessionRecord {
    const record = this.store.get(id);
    if (!record) {
      throw RequestError.resourceNotFound(id);
    }
    return record;
  }
}
