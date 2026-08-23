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
  statuses: string[];
}

function makeHooks(): { hooks: PermissionPolicyHooks; log: HookLog } {
  const log: HookLog = { requested: [], resolved: [], statuses: [] };
  return {
    log,
    hooks: {
      persistRequested: (_id, params) => {
        log.requested.push(params);
      },
      persistResolved: (_id, response) => {
        log.resolved.push(response);
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
    expect(delivered).toEqual(params);

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
});
