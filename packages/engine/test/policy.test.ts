import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionResolutionMeta } from "@aaroncx/protocol";
import {
  InteractivePermissionPolicy,
  type PermissionClient,
  type PermissionPolicyHooks,
} from "../src/policy.ts";
import { type BackendHooks, type SessionBackend, SessionManager } from "../src/session.ts";
import { SessionStore } from "../src/store.ts";

const SESSION_ID = Bun.randomUUIDv7();

function makePermissionRequest(sessionId = SESSION_ID): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: { toolCallId: "call-1", title: "Run bun test" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
}

const ALLOW: RequestPermissionResponse = {
  outcome: { outcome: "selected", optionId: "allow" },
};

interface HookLog {
  requested: RequestPermissionRequest[];
  resolved: RequestPermissionResponse[];
  metas: PermissionResolutionMeta[];
  statuses: string[];
}

function makeHooks(): { hooks: PermissionPolicyHooks; log: HookLog } {
  const log: HookLog = { requested: [], resolved: [], metas: [], statuses: [] };
  return {
    log,
    hooks: {
      persistRequested: (_id, params) => {
        log.requested.push(params);
      },
      persistResolved: (_id, response, meta) => {
        log.resolved.push(response);
        log.metas.push(meta);
      },
      setStatus: (_id, status) => {
        log.statuses.push(status);
      },
    },
  };
}

function answeringClient(response: RequestPermissionResponse): PermissionClient & {
  asked: RequestPermissionRequest[];
} {
  const asked: RequestPermissionRequest[] = [];
  return {
    asked,
    requestPermission: (params) => {
      asked.push(params);
      return Promise.resolve(response);
    },
  };
}

describe("InteractivePermissionPolicy", () => {
  test("forwards to the attached client and persists both sides", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const client = answeringClient(ALLOW);
    const response = await policy.request(SESSION_ID, makePermissionRequest(), client);
    expect(response).toEqual(ALLOW);
    expect(client.asked).toHaveLength(1);
    expect(log.requested).toHaveLength(1);
    expect(log.resolved).toEqual([ALLOW]);
    expect(log.statuses).toEqual([]); // Never went to waiting.
  });

  test("holds with nobody attached, then delivers on attach", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const params = makePermissionRequest();

    let settled = false;
    const held = policy.request(SESSION_ID, params, undefined).then((response) => {
      settled = true;
      return response;
    });

    await Bun.sleep(10);
    expect(settled).toBe(false); // The request is really held open.
    expect(log.requested).toEqual([params]);
    expect(log.statuses).toEqual(["waiting_for_permission"]);
    expect(policy.pendingRequest(SESSION_ID)).toEqual(params);

    const client = answeringClient(ALLOW);
    const delivered = policy.deliverPending(SESSION_ID, client);
    expect(delivered).toEqual([params]); // deliverPending returns every held request.

    const response = await held;
    expect(response).toEqual(ALLOW);
    expect(client.asked).toEqual([params]);
    expect(log.resolved).toEqual([ALLOW]);
    expect(log.statuses).toEqual(["waiting_for_permission", "running"]);
    expect(policy.pendingRequest(SESSION_ID)).toBeUndefined();
  });

  test("first answer wins when several clients see the held request", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const held = policy.request(SESSION_ID, makePermissionRequest(), undefined);
    await Bun.sleep(1);

    const reject: RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: "reject" },
    };
    policy.deliverPending(SESSION_ID, answeringClient(ALLOW));
    policy.deliverPending(SESSION_ID, answeringClient(reject));

    const response = await held;
    expect(response).toEqual(ALLOW);
    expect(log.resolved).toEqual([ALLOW]); // The losing answer is not persisted.
  });

  test("a vanished client falls back to the waiting path", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const goneClient: PermissionClient = {
      requestPermission: () => Promise.reject(new Error("connection closed")),
    };

    let settled = false;
    const held = policy
      .request(SESSION_ID, makePermissionRequest(), goneClient)
      .then((response) => {
        settled = true;
        return response;
      });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(log.statuses).toEqual(["waiting_for_permission"]);

    policy.deliverPending(SESSION_ID, answeringClient(ALLOW));
    expect(await held).toEqual(ALLOW);
  });

  test("cancel resolves a held request with a cancelled outcome", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const held = policy.request(SESSION_ID, makePermissionRequest(), undefined);
    await Bun.sleep(1);

    policy.cancel(SESSION_ID);
    const response = await held;
    expect(response.outcome).toEqual({ outcome: "cancelled" });
    expect(log.resolved).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(policy.pendingRequest(SESSION_ID)).toBeUndefined();
  });
});

/**
 * Finding 5: Claude issues tool calls in parallel, so one session can have
 * several permission requests in flight. M2 kept a single slot and threw at
 * the second one, which reached the vendor as a JSON-RPC error mid-turn.
 */
describe("InteractivePermissionPolicy with several requests in flight", () => {
  function callRequest(id: string, title: string): RequestPermissionRequest {
    return {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: id, title },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    };
  }

  test("two concurrent requests are both held, and the session waits once", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const first = callRequest("call-1", "first");
    const second = callRequest("call-2", "second");

    const settled: string[] = [];
    const heldFirst = policy.request(SESSION_ID, first, undefined).then((response) => {
      settled.push("first");
      return response;
    });
    const heldSecond = policy.request(SESSION_ID, second, undefined).then((response) => {
      settled.push("second");
      return response;
    });

    await Bun.sleep(10);
    expect(settled).toEqual([]); // Neither threw, neither resolved.
    expect(log.requested).toEqual([first, second]);
    expect(log.statuses).toEqual(["waiting_for_permission"]); // Once, on the first hold.
    expect(policy.pendingRequests(SESSION_ID)).toEqual([first, second]);
    expect(policy.pendingRequest(SESSION_ID)).toEqual(first); // The oldest.

    policy.cancel(SESSION_ID);
    await Promise.all([heldFirst, heldSecond]);
  });

  test("attach delivers every held request, oldest first", async () => {
    const { hooks } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const first = callRequest("call-1", "first");
    const second = callRequest("call-2", "second");
    const heldFirst = policy.request(SESSION_ID, first, undefined);
    const heldSecond = policy.request(SESSION_ID, second, undefined);
    await Bun.sleep(1);

    const client = answeringClient(ALLOW);
    const delivered = policy.deliverPending(SESSION_ID, client);
    expect(delivered).toEqual([first, second]);
    expect(client.asked).toEqual([first, second]);

    expect(await heldFirst).toEqual(ALLOW);
    expect(await heldSecond).toEqual(ALLOW);
    expect(policy.pendingRequests(SESSION_ID)).toEqual([]);
  });

  test("answering one leaves the other held and the session still waiting", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const first = callRequest("call-1", "first");
    const second = callRequest("call-2", "second");
    const heldFirst = policy.request(SESSION_ID, first, undefined);
    const heldSecond = policy.request(SESSION_ID, second, undefined);
    await Bun.sleep(1);

    // A human who answers the first question and leaves the second on screen.
    const answers = new Map<string, RequestPermissionResponse>([["call-1", ALLOW]]);
    const client: PermissionClient = {
      requestPermission: (params) => {
        const answer = answers.get(params.toolCall?.toolCallId ?? "");
        return answer ? Promise.resolve(answer) : new Promise(() => {});
      },
    };
    policy.deliverPending(SESSION_ID, client);

    expect(await heldFirst).toEqual(ALLOW);
    await Bun.sleep(5);
    expect(log.resolved).toEqual([ALLOW]);
    expect(log.statuses).toEqual(["waiting_for_permission"]); // NOT back to running.
    expect(policy.pendingRequests(SESSION_ID)).toEqual([second]);

    // Answering the last one is what returns the session to running.
    policy.deliverPending(SESSION_ID, answeringClient(ALLOW));
    expect(await heldSecond).toEqual(ALLOW);
    expect(log.statuses).toEqual(["waiting_for_permission", "running"]);
  });

  test("cancel resolves every held request", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const heldFirst = policy.request(SESSION_ID, callRequest("call-1", "first"), undefined);
    const heldSecond = policy.request(SESSION_ID, callRequest("call-2", "second"), undefined);
    await Bun.sleep(1);

    policy.cancel(SESSION_ID);
    expect((await heldFirst).outcome).toEqual({ outcome: "cancelled" });
    expect((await heldSecond).outcome).toEqual({ outcome: "cancelled" });
    expect(log.resolved).toHaveLength(2);
    expect(log.metas.map((meta) => meta.toolCallId)).toEqual(["call-1", "call-2"]);
    expect(policy.pendingRequests(SESSION_ID)).toEqual([]);
  });

  test("a request with no toolCallId is held, under a synthetic key", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const anonymous: RequestPermissionRequest = {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "", title: "no id at all" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const held = policy.request(SESSION_ID, anonymous, undefined);
    const alsoHeld = policy.request(SESSION_ID, anonymous, undefined);
    await Bun.sleep(1);
    // Nothing was dropped to make room: both anonymous requests are held.
    expect(policy.pendingRequests(SESSION_ID)).toHaveLength(2);

    policy.deliverPending(SESSION_ID, answeringClient(ALLOW));
    expect(await held).toEqual(ALLOW);
    expect(await alsoHeld).toEqual(ALLOW);
    // The synthetic keys reach the transcript, and differ per request.
    const ids = log.metas.map((meta) => meta.toolCallId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test("a duplicate toolCallId does not evict the request already held", async () => {
    const { hooks, log } = makeHooks();
    const policy = new InteractivePermissionPolicy(hooks);
    const first = callRequest("call-1", "first");
    const duplicate = callRequest("call-1", "same id again");
    const heldFirst = policy.request(SESSION_ID, first, undefined);
    const heldDuplicate = policy.request(SESSION_ID, duplicate, undefined);
    await Bun.sleep(1);
    expect(policy.pendingRequests(SESSION_ID)).toEqual([first, duplicate]);

    policy.deliverPending(SESSION_ID, answeringClient(ALLOW));
    expect(await heldFirst).toEqual(ALLOW);
    expect(await heldDuplicate).toEqual(ALLOW);
    // The real id is never dropped; the collision gets the synthetic one.
    expect(log.metas[0]?.toolCallId).toBe("call-1");
    expect(log.metas[1]?.toolCallId).toBe("call-1");
  });
});

describe("policy through the SessionManager (attach delivers)", () => {
  let dirs: string[] = [];
  let stores: SessionStore[] = [];

  afterEach(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // Already closed.
      }
    }
    stores = [];
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  test("permission asked with nobody attached is held, attach answers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monad-policy-"));
    dirs.push(dir);
    const store = new SessionStore({ dbPath: join(dir, "monad.db") });
    stores.push(store);

    // A backend whose turn asks for permission, then finishes.
    let capturedHooks: BackendHooks | undefined;
    const permissionOutcomes: RequestPermissionResponse[] = [];
    const backend = (hooks: BackendHooks): SessionBackend => {
      capturedHooks = hooks;
      return {
        prompt: async (_params: PromptRequest): Promise<PromptResponse> => {
          const outcome = await hooks.requestPermission(makePermissionRequest());
          permissionOutcomes.push(outcome);
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
      };
    };
    const manager = new SessionManager({
      store,
      createBackend: (_record, hooks) => backend(hooks),
    });

    const record = await manager.create({ cwd: "/tmp/repo" });
    expect(capturedHooks).toBeDefined();

    // Prompt with no attached client: the turn blocks on the permission.
    const turn = manager.prompt(record.id, {
      sessionId: record.id,
      prompt: [{ type: "text", text: "do the thing" }],
    });
    await Bun.sleep(10);
    expect(manager.get(record.id)?.status).toBe("waiting_for_permission");
    expect(store.replay(record.id).map((e) => e.kind)).toEqual([
      "session_created",
      "prompt",
      "permission_requested",
    ]);

    // Attach: the pending request is surfaced and this client answers it.
    const { pendingPermission } = manager.attach(record.id, {
      onEvent: () => {},
      requestPermission: () => Promise.resolve(ALLOW),
    });
    expect(pendingPermission?.toolCall.title).toBe("Run bun test");

    const response = await turn;
    expect(response.stopReason).toBe("end_turn");
    expect(permissionOutcomes).toEqual([ALLOW]);
    expect(store.replay(record.id).map((e) => e.kind)).toEqual([
      "session_created",
      "prompt",
      "permission_requested",
      "permission_resolved",
      "turn_ended",
    ]);
    expect(manager.get(record.id)?.status).toBe("idle");
  });

  test("two parallel tool calls are both held and both surface on attach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monad-policy-parallel-"));
    dirs.push(dir);
    const store = new SessionStore({ dbPath: join(dir, "monad.db") });
    stores.push(store);

    function parallelRequest(id: string): RequestPermissionRequest {
      return {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: id, title: `Run ${id}` },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      };
    }

    // A backend that asks for two permissions at once, the way an agent
    // issuing parallel tool calls does.
    const outcomes: RequestPermissionResponse[] = [];
    const manager = new SessionManager({
      store,
      createBackend: (_record, hooks: BackendHooks) => ({
        prompt: async (): Promise<PromptResponse> => {
          const answers = await Promise.all([
            hooks.requestPermission(parallelRequest("call-a")),
            hooks.requestPermission(parallelRequest("call-b")),
          ]);
          outcomes.push(...answers);
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
      }),
    });

    const record = await manager.create({ cwd: "/tmp/repo" });
    const turn = manager.prompt(record.id, {
      sessionId: record.id,
      prompt: [{ type: "text", text: "do two things" }],
    });
    await Bun.sleep(10);
    expect(manager.get(record.id)?.status).toBe("waiting_for_permission");

    const asked: string[] = [];
    const { pendingPermission, pendingPermissions } = manager.attach(record.id, {
      onEvent: () => {},
      requestPermission: (params) => {
        asked.push(params.toolCall?.toolCallId ?? "");
        return Promise.resolve(ALLOW);
      },
    });
    expect(pendingPermissions.map((p) => p.toolCall?.toolCallId)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(pendingPermission?.toolCall.toolCallId).toBe("call-a");
    expect(asked).toEqual(["call-a", "call-b"]);

    expect((await turn).stopReason).toBe("end_turn");
    expect(outcomes).toEqual([ALLOW, ALLOW]);
    expect(store.replay(record.id).map((e) => e.kind)).toEqual([
      "session_created",
      "prompt",
      "permission_requested",
      "permission_requested",
      "permission_resolved",
      "permission_resolved",
      "turn_ended",
    ]);
    expect(manager.get(record.id)?.status).toBe("idle");
  });
});
