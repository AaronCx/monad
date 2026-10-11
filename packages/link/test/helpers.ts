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
  type BackendHooks,
  RepoResolver,
  type SessionBackend,
  SessionManager,
  SessionStore,
} from "@aaroncx/engine";
import type { EventKind, SessionId, SessionRecord } from "@aaroncx/protocol";
import { defaultLinkConfig, type LinkConfig, type LinkLimits } from "../src/config.ts";
import { LinkService, type LinkServiceOptions } from "../src/service.ts";

/**
 * A planted GitHub token, built from parts so the literal never sits in the
 * source for a scanner to trip on. Every Link output test asserts it never
 * comes back.
 */
export const PLANTED_TOKEN = ["ghp_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A backend whose turns stay open until the test ends them. */
export class FakeBackend implements SessionBackend {
  hooks: BackendHooks;
  prompts: PromptRequest[] = [];
  turns: Deferred<PromptResponse>[] = [];

  constructor(hooks: BackendHooks) {
    this.hooks = hooks;
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.prompts.push(params);
    const turn = deferred<PromptResponse>();
    this.turns.push(turn);
    return turn.promise;
  }

  /** Ends the most recent open turn. */
  endTurn(stopReason: PromptResponse["stopReason"] = "end_turn"): void {
    const turn = this.turns.at(-1);
    turn?.resolve({ stopReason });
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.hooks.requestPermission(params);
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

export interface Harness {
  dir: string;
  store: SessionStore;
  manager: SessionManager;
  backends: Map<string, FakeBackend>;
  link: LinkService;
  config: LinkConfig;
  /** A live interactive trusted session, as `monad run` makes one. */
  session(cwd?: string, overrides?: Partial<Parameters<SessionManager["createRecord"]>[0]>): Promise<SessionRecord>;
  /** Appends events straight to a session's log (history fixtures). */
  history(id: SessionId, events: Array<[EventKind, unknown]>): void;
  close(): void;
}

export interface HarnessOptions {
  config?: Partial<Omit<LinkConfig, "limits">> & { limits?: Partial<LinkLimits> };
  link?: Partial<LinkServiceOptions>;
  home?: string;
  /** Awaited before a session's fake backend exists, as a real vendor adapter's startup is. */
  backendStartup?: (record: SessionRecord) => Promise<void> | undefined;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "monad-link-"));
  const repos = new RepoResolver(options.home ? { home: options.home } : {});
  const store = new SessionStore({ dbPath: join(dir, "monad.db"), repoResolver: repos });
  const backends = new Map<string, FakeBackend>();
  const manager = new SessionManager({
    store,
    createBackend: async (record, hooks) => {
      await options.backendStartup?.(record);
      const backend = new FakeBackend(hooks);
      backends.set(record.id, backend);
      return backend;
    },
  });
  const defaults = defaultLinkConfig();
  const config: LinkConfig = {
    ...defaults,
    ...options.config,
    limits: { ...defaults.limits, ...options.config?.limits },
  };
  const link = new LinkService({ manager, store, config, repos, ...options.link });
  return {
    dir,
    store,
    manager,
    backends,
    link,
    config,
    async session(cwd = dir, overrides = {}) {
      const record = manager.createRecord({ cwd, ...overrides });
      return await manager.activate(record.id);
    },
    history(id, events) {
      for (const [kind, payload] of events) {
        store.append(id, kind, payload);
      }
    },
    close() {
      void manager.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function promptText(prompt: PromptRequest | undefined): string {
  const block = prompt?.prompt[0];
  return block?.type === "text" ? block.text : "";
}

export function userPrompt(id: SessionId, text: string): PromptRequest {
  return { sessionId: id, prompt: [{ type: "text", text }] };
}

export function agentChunk(id: SessionId, text: string) {
  return {
    sessionId: id,
    update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text } },
  };
}

/** The access events of a session's log, payloads only. */
export function accessEvents(store: SessionStore, id: SessionId): Array<Record<string, unknown>> {
  return store.replayKinds(id, ["access"]).map((event) => event.payload as Record<string, unknown>);
}
