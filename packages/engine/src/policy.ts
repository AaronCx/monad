import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { SessionId } from "@aaroncx/protocol";

/** A client able to answer a permission request (an attached CLI, editor, ...). */
export interface PermissionClient {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/**
 * Persistence hooks the policy calls. The SessionManager implements these
 * against the store so the policy itself stays free of storage concerns.
 */
export interface PermissionPolicyHooks {
  persistRequested(sessionId: SessionId, params: RequestPermissionRequest): void;
  persistResolved(sessionId: SessionId, response: RequestPermissionResponse): void;
  setStatus(sessionId: SessionId, status: "running" | "waiting_for_permission"): void;
}

export interface PermissionPolicy {
  /**
   * Routes one agent-side session/request_permission. The returned promise
   * stays open until a client answers or the session is cancelled; the
   * caller (the backend's client handler) returns it to the vendor agent.
   */
  request(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    client: PermissionClient | undefined,
  ): Promise<RequestPermissionResponse>;

  /**
   * Offers a held request to a newly attached client. Returns the pending
   * params if there was one to deliver, undefined otherwise. First answer
   * wins if several clients see the same request.
   */
  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest | undefined;

  /** The held request for a session, if any. */
  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined;

  /** Resolves a held request with a cancelled outcome (session/cancel path). */
  cancel(sessionId: SessionId): void;
}

interface PendingPermission {
  params: RequestPermissionRequest;
  settled: boolean;
  resolve: (response: RequestPermissionResponse) => void;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/**
 * The M1 policy: interactive. Forward the request to the most recently
 * active attached client; with nobody attached, persist permission_requested,
 * mark the session waiting_for_permission, and hold the vendor agent's
 * request open until a client attaches and answers or the session is
 * cancelled. This is the seed of answering from a phone later: the waiting
 * path is real, not a timeout.
 */
export class InteractivePermissionPolicy implements PermissionPolicy {
  private readonly hooks: PermissionPolicyHooks;
  private readonly pending = new Map<SessionId, PendingPermission>();

  constructor(hooks: PermissionPolicyHooks) {
    this.hooks = hooks;
  }

  async request(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    client: PermissionClient | undefined,
  ): Promise<RequestPermissionResponse> {
    if (this.pending.has(sessionId)) {
      throw new Error(`a permission request is already pending for session ${sessionId}`);
    }
    this.hooks.persistRequested(sessionId, params);
    if (client) {
      try {
        const response = await client.requestPermission(params);
        this.hooks.persistResolved(sessionId, response);
        return response;
      } catch {
        // The client vanished mid-question. Fall through to the waiting path.
      }
    }
    this.hooks.setStatus(sessionId, "waiting_for_permission");
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(sessionId, { params, settled: false, resolve });
    });
  }

  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest | undefined {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.settled) {
      return undefined;
    }
    client
      .requestPermission(entry.params)
      .then((response) => {
        this.settle(sessionId, entry, response, "running");
      })
      .catch(() => {
        // This client vanished too; the request stays held for the next one.
      });
    return entry.params;
  }

  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined {
    return this.pending.get(sessionId)?.params;
  }

  cancel(sessionId: SessionId): void {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.settled) {
      return;
    }
    // Status is left to the caller: session/cancel ends the turn and the
    // manager sets the session idle.
    entry.settled = true;
    this.pending.delete(sessionId);
    this.hooks.persistResolved(sessionId, CANCELLED);
    entry.resolve(CANCELLED);
  }

  private settle(
    sessionId: SessionId,
    entry: PendingPermission,
    response: RequestPermissionResponse,
    status: "running",
  ): void {
    if (entry.settled || this.pending.get(sessionId) !== entry) {
      return; // Another client answered first.
    }
    entry.settled = true;
    this.pending.delete(sessionId);
    this.hooks.persistResolved(sessionId, response);
    this.hooks.setStatus(sessionId, status);
    entry.resolve(response);
  }
}
