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
  ErrorPayload,
  EventRecord,
  SessionId,
  SessionRecord,
} from "@aaroncx/protocol";
import {
  InteractivePermissionPolicy,
  type PermissionClient,
  type PermissionPolicy,
  type PermissionPolicyHooks,
} from "./policy.ts";
import type { SessionStore } from "./store.ts";

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
}

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
   * Defaults to the interactive policy; injectable for tests and for the
   * review policy in a later milestone.
   */
  createPolicy?: (hooks: PermissionPolicyHooks) => PermissionPolicy;
}

export interface AttachResult {
  record: SessionRecord;
  /** The full event log in seq order; the caller replays it to the client. */
  events: EventRecord[];
  /** A held permission request, re-delivered to the attaching client. */
  pendingPermission?: RequestPermissionRequest;
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

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.createBackend = options.createBackend;
    const hooks: PermissionPolicyHooks = {
      persistRequested: (id, params) => {
        this.appendAndPublish(id, "permission_requested", params);
      },
      persistResolved: (id, response) => {
        this.appendAndPublish(id, "permission_resolved", response);
      },
      setStatus: (id, status) => {
        this.store.setStatus(id, status);
      },
    };
    const createPolicy =
      options.createPolicy ?? ((h: PermissionPolicyHooks) => new InteractivePermissionPolicy(h));
    this.policy = createPolicy(hooks);
  }

  async create(params: { cwd: string }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: Bun.randomUUIDv7(),
      cwd: params.cwd,
      backend: "claude-acp",
      mode: "interactive",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(record);
    this.appendAndPublish(record.id, "session_created", record);
    // Start the backend eagerly so session/new surfaces spawn failures.
    await this.ensureBackend(record.id);
    return this.mustGet(record.id);
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
   * Subscribes a client: returns the record, the full replay, and any held
   * permission request (which is also re-delivered to this client).
   */
  attach(id: SessionId, client: SessionClient): AttachResult {
    const record = this.mustGet(id);
    const session = this.ensureLive(id);
    session.subscribers.add(client);
    session.lastActive = client;
    const events = this.store.replay(id);
    const pendingPermission = this.policy.deliverPending(id, client);
    return { record, events, pendingPermission };
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
   * queue.
   */
  async prompt(id: SessionId, params: PromptRequest, client?: SessionClient): Promise<PromptResponse> {
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
      this.store.setStatus(id, "running");
      const backend = await this.ensureBackend(id);
      const response = await backend.prompt(params);
      this.appendAndPublish(id, "turn_ended", { stopReason: response.stopReason });
      this.store.setStatus(id, "idle");
      return response;
    } catch (error) {
      this.appendAndPublish(id, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.store.setStatus(id, "idle");
      throw error;
    } finally {
      session.promptLock.release();
    }
  }

  /** Cancels the in-flight turn and resolves any held permission request. */
  async cancel(id: SessionId): Promise<void> {
    const session = this.live.get(id);
    this.policy.cancel(id);
    if (session?.backend) {
      await session.backend.cancel();
    }
    this.store.setStatus(id, "idle");
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
    this.store.setStatus(id, "closed");
  }

  /** Daemon shutdown: closes every live backend without closing sessions. */
  async shutdown(): Promise<void> {
    for (const session of this.live.values()) {
      if (session.backend) {
        await session.backend.close();
      }
    }
    this.live.clear();
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
