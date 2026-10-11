import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PermissionOption,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { SessionMode, TrustLevel } from "@aaroncx/protocol";
import { type BackendHooks, type SessionBackend, SessionManager } from "../src/session.ts";
import { SessionStore } from "../src/store.ts";

/**
 * Link tool permissions through the SessionManager's own default policy
 * (decision record 0012). The policy unit tests hand the trust level in by
 * hand; these prove the manager actually reads it off the record and passes
 * it to the policy, which is the only thing that makes a monad-sessions call
 * a Link call. Without that wiring every Link call would fall through to the
 * mode's policy: rejected in review and fix, and forwarded to a human (with
 * nobody there to answer) in interactive.
 */

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

class FakeBackend implements SessionBackend {
  hooks: BackendHooks;

  constructor(hooks: BackendHooks) {
    this.hooks = hooks;
  }

  prompt(_params: PromptRequest): Promise<PromptResponse> {
    return new Promise(() => {});
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "monad-link-policy-"));
  dirs.push(dir);
  const store = new SessionStore({ dbPath: join(dir, "monad.db") });
  stores.push(store);
  const backends = new Map<string, FakeBackend>();
  // No createPolicy: the manager's own default, ModeAwarePermissionPolicy
  // with the record-backed resolveContext, is what is under test.
  const manager = new SessionManager({
    store,
    createBackend: (record, hooks) => {
      const backend = new FakeBackend(hooks);
      backends.set(record.id, backend);
      return backend;
    },
  });
  return { store, manager, backends, dir };
}

/** The vendor's permission-rule metadata, the only tool identity a live request carries. */
function vendorOptions(toolName: string): PermissionOption[] {
  return [
    { optionId: "reject", name: "Deny", kind: "reject_once" },
    { optionId: "allow", name: "Allow Once", kind: "allow_once" },
    {
      optionId: "allow_always",
      name: "Always Allow",
      kind: "allow_always",
      _meta: {
        permission: {
          version: 1,
          changes: [
            {
              type: "policy_rule",
              operation: "add",
              ruleBehavior: "allow",
              description: `Allow all ${toolName} calls`,
              lifetime: { scope: "session" },
              targets: [{ type: "tool", toolName }],
            },
          ],
        },
      },
    },
  ];
}

/** A live-shaped Link call: kind other, named only by the vendor's rule metadata. */
function linkToolRequest(sessionId: string, tool: string): RequestPermissionRequest {
  const name = `mcp__monad-sessions__${tool}`;
  return {
    sessionId,
    toolCall: { toolCallId: `call-${tool}`, kind: "other", title: name, rawInput: {} },
    options: vendorOptions(name),
  };
}

/** Asks the session's backend hook for a permission; undefined if nobody answered in time. */
async function ask(
  backend: FakeBackend | undefined,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse | undefined> {
  const answer = backend?.hooks.requestPermission(params);
  const timeout = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), 300);
  });
  return await Promise.race([answer, timeout]);
}

async function liveSession(
  h: ReturnType<typeof makeManager>,
  mode: SessionMode,
  trust: TrustLevel,
): Promise<string> {
  const record = h.manager.createRecord({ cwd: h.dir, mode, trust });
  await h.manager.activate(record.id);
  return record.id;
}

function resolvedBy(h: ReturnType<typeof makeManager>, id: string): Array<Record<string, unknown>> {
  return h.store.replayKinds(id, ["permission_resolved"]).map((e) => e.payload as Record<string, unknown>);
}

describe("Link permissions through the SessionManager's own policy", () => {
  test("trusted review: sessions_read is allowed, sessions_message is rejected as a Link tool", async () => {
    const h = makeManager();
    const id = await liveSession(h, "review", "trusted");
    const backend = h.backends.get(id);

    const read = await ask(backend, linkToolRequest(id, "sessions_read"));
    expect(read?.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    const message = await ask(backend, linkToolRequest(id, "sessions_message"));
    expect(message?.outcome).toEqual({ outcome: "selected", optionId: "reject" });

    const resolved = resolvedBy(h, id);
    expect(resolved.map((r) => r.by)).toEqual(["policy:review", "policy:review"]);
    // Rejected by the Link branch (which knows what the tool is), not by the
    // review policy's unknown-tool fallthrough.
    expect(String(resolved[1]?.message)).toContain("not available in review mode");
  });

  test("trusted interactive with nobody attached: every Link tool is allowed by policy", async () => {
    const h = makeManager();
    const id = await liveSession(h, "interactive", "trusted");
    const backend = h.backends.get(id);
    for (const tool of ["sessions_message", "sessions_spawn", "sessions_wait"]) {
      const response = await ask(backend, linkToolRequest(id, tool));
      expect(response?.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    }
    expect(resolvedBy(h, id).map((r) => r.by)).toEqual([
      "policy:interactive",
      "policy:interactive",
      "policy:interactive",
    ]);
    expect(h.manager.pendingPermissionCount(id)).toBe(0);
  });

  test("untrusted review: a call by a Link name is not a Link call and is rejected", async () => {
    const h = makeManager();
    const id = await liveSession(h, "review", "untrusted");
    const response = await ask(h.backends.get(id), linkToolRequest(id, "sessions_read"));
    expect(response?.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(String(resolvedBy(h, id)[0]?.message)).toContain("not allowed in review mode");
  });

  test("the trust level is re-read per request", async () => {
    const h = makeManager();
    const id = await liveSession(h, "review", "trusted");
    expect((await ask(h.backends.get(id), linkToolRequest(id, "sessions_list")))?.outcome).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
    // Flip the stored trust (nothing in monad does this, but the policy
    // must follow the record, not a value captured at start).
    (h.store as unknown as { db: { run: (sql: string, ...args: unknown[]) => void } }).db.run(
      "UPDATE sessions SET trust = 'untrusted' WHERE id = ?",
      id,
    );
    expect((await ask(h.backends.get(id), linkToolRequest(id, "sessions_list")))?.outcome).toEqual({
      outcome: "selected",
      optionId: "reject",
    });
  });
});
