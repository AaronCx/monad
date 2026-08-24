import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PermissionOption,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { EventRecord, SessionPr } from "@aaroncx/protocol";
import { type BackendHooks, type SessionBackend, SessionManager } from "../src/session.ts";
import { SessionStore } from "../src/store.ts";

/**
 * Finding 3 of the untrusted-worktree review, end to end: the fix policy's
 * execute allowlist is frozen at the PR base when the session enters fix
 * mode, and stops applying at all once the session has edited package.json or
 * a lockfile. Everything here drives the real SessionManager and the real
 * store, so the allowlist is exercised exactly as the daemon reads it.
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

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "monad test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "monad test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

const CANARY = "canary-ran.txt";
const CANARY_SCRIPT = "canary.sh";

interface Repo {
  path: string;
  baseSha: string;
  headSha: string;
}

/**
 * A repo whose BASE commit has lint and test scripts, and whose head rewrites
 * scripts.test to a canary script and adds a build script. Both differences
 * matter: the rewrite is what the frozen list cannot see (it names scripts,
 * not command lines), and the added script is what freezing keeps out.
 */
function makeRepo(): Repo {
  const path = mkdtempSync(join(tmpdir(), "monad-fix-allowlist-"));
  dirs.push(path);
  git(path, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name: "under-review", scripts: { lint: "biome check .", test: "bun test" } }),
  );
  writeFileSync(join(path, "bun.lock"), "{}\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "base"]);
  const baseSha = git(path, ["rev-parse", "HEAD"]).trim();

  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({
      name: "under-review",
      scripts: { lint: "biome check .", test: `./${CANARY_SCRIPT}`, build: `./${CANARY_SCRIPT}` },
    }),
  );
  writeFileSync(join(path, CANARY_SCRIPT), `#!/bin/sh\ntouch "$(dirname "$0")/${CANARY}"\n`, {
    mode: 0o755,
  });
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "head"]);
  const headSha = git(path, ["rev-parse", "HEAD"]).trim();
  return { path, baseSha, headSha };
}

function prFor(repo: Repo): SessionPr {
  return {
    repo: "AaronCx/monad",
    number: 7,
    url: "https://github.com/AaronCx/monad/pull/7",
    headSha: repo.headSha,
    baseRef: "main",
    baseSha: repo.baseSha,
    title: "a pull request",
  };
}

class FakeBackend implements SessionBackend {
  constructor(readonly hooks: BackendHooks) {}

  prompt(_params: PromptRequest): Promise<PromptResponse> {
    return Promise.resolve({ stopReason: "end_turn" });
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  async setSessionMode(): Promise<void> {}
}

/** A fresh database in its own temp directory, cleaned up after the test. */
function openStore(dbPath?: string): { store: SessionStore; dbPath: string } {
  let path = dbPath;
  if (path === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "monad-fix-db-"));
    dirs.push(dir);
    path = join(dir, "monad.db");
  }
  const store = new SessionStore({ dbPath: path });
  stores.push(store);
  return { store, dbPath: path };
}

interface Harness {
  manager: SessionManager;
  hooks: () => BackendHooks;
  events: EventRecord[];
}

function makeManager(store: SessionStore): Harness {
  const backends: FakeBackend[] = [];
  const events: EventRecord[] = [];
  const manager = new SessionManager({
    store,
    createBackend: (_record, hooks) => {
      const backend = new FakeBackend(hooks);
      backends.push(backend);
      return backend;
    },
  });
  return { manager, hooks: () => backends[0]!.hooks, events };
}

/** A client that records what it was asked and rejects everything, so an
 *  allowed verdict is unmistakably the policy's own and never a human's. */
function rejectingClient(asked: RequestPermissionRequest[]) {
  return {
    onEvent: () => {},
    requestPermission: (params: RequestPermissionRequest) => {
      asked.push(params);
      return Promise.resolve({
        outcome: { outcome: "selected", optionId: "reject" },
      } as RequestPermissionResponse);
    },
  };
}

const ONCE_OPTIONS: PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function request(sessionId: string, toolCall: Partial<ToolCallUpdate> & { toolCallId: string }) {
  return { sessionId, toolCall, options: ONCE_OPTIONS } as RequestPermissionRequest;
}

async function startFixSession(
  store: SessionStore,
  repo: Repo,
  options: { withPr?: boolean } = {},
): Promise<{ harness: Harness; id: string; asked: RequestPermissionRequest[] }> {
  const harness = makeManager(store);
  const record = harness.manager.createRecord({
    cwd: repo.path,
    mode: "review",
    trust: "untrusted",
    base: repo.baseSha,
    head: repo.headSha,
    pr: options.withPr ? prFor(repo) : undefined,
  });
  await harness.manager.activate(record.id);
  const asked: RequestPermissionRequest[] = [];
  harness.manager.attach(record.id, {
    ...rejectingClient(asked),
    onEvent: (event: EventRecord) => {
      harness.events.push(event);
    },
  });
  await harness.manager.setMode(record.id, "fix");
  return { harness, id: record.id, asked };
}

describe("the fix exec allowlist is frozen at the base commit", () => {
  test("freezes the base commit's scripts, not the head's", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const { harness, id } = await startFixSession(store, repo, { withPr: true });

    const frozen = harness.manager.get(id)?.execAllowlist ?? [];
    expect(frozen).toContain("bun run lint");
    expect(frozen).toContain("bun run test");
    expect(frozen).toContain("bun test");
    expect(frozen).toContain("git commit");
    // The head added a build script pointing at the canary. The base had none,
    // so `bun run build` is not on the frozen list however the worktree reads.
    expect(frozen).not.toContain("bun run build");
    expect(frozen).not.toContain("npm run build");
  });

  test("a second setMode(fix) cannot refresh the list against an edited worktree", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const { harness, id } = await startFixSession(store, repo);
    const first = harness.manager.get(id)?.execAllowlist;

    await harness.manager.setMode(id, "interactive");
    await harness.manager.setMode(id, "fix");
    expect(harness.manager.get(id)?.execAllowlist).toEqual(first);
    expect(harness.manager.get(id)?.execAllowlist).not.toContain("bun run build");
  });

  test("an untrusted session with no base gets the git prefixes alone", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const harness = makeManager(store);
    const record = harness.manager.createRecord({
      cwd: repo.path,
      mode: "review",
      trust: "untrusted",
    });
    await harness.manager.activate(record.id);
    await harness.manager.setMode(record.id, "fix");
    const frozen = harness.manager.get(record.id)?.execAllowlist ?? [];
    expect(frozen).toContain("git status");
    expect(frozen).not.toContain("bun run test");
    expect(frozen).not.toContain("bun test");
  });

  test("a trusted session with no PR falls back to its own worktree manifest", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const harness = makeManager(store);
    const record = harness.manager.createRecord({
      cwd: repo.path,
      mode: "interactive",
      trust: "trusted",
    });
    await harness.manager.activate(record.id);
    await harness.manager.setMode(record.id, "fix");
    // Its worktree is the user's own repo, so the head's build script counts.
    expect(harness.manager.get(record.id)?.execAllowlist).toContain("bun run build");
  });
});

describe("editing package.json or a lockfile forwards every later execute", () => {
  test("bun run test is allowed before the edit and forwarded after it, canary never runs", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const { harness, id, asked } = await startFixSession(store, repo);
    const hooks = harness.hooks();

    // Before: `bun run test` is on the frozen list, so the policy allows it
    // and the human (who rejects everything here) is never consulted.
    const before = await hooks.requestPermission(
      request(id, { toolCallId: "exec-1", kind: "execute", rawInput: { command: "bun run test" } }),
    );
    expect(before.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(asked).toHaveLength(0);

    // The agent rewrites scripts.test to point at a canary. In fix mode an
    // in-worktree edit is auto-granted, which is exactly the hole.
    const edit = await hooks.requestPermission(
      request(id, {
        toolCallId: "edit-1",
        kind: "edit",
        locations: [{ path: join(repo.path, "package.json") }],
      }),
    );
    expect(edit.outcome).toEqual({ outcome: "selected", optionId: "allow" });

    // After: the same command no longer means what the frozen list vouched
    // for, so it goes to the human, who rejects it.
    const after = await hooks.requestPermission(
      request(id, { toolCallId: "exec-2", kind: "execute", rawInput: { command: "bun run test" } }),
    );
    expect(asked).toHaveLength(1);
    expect(after.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(existsSync(join(repo.path, CANARY))).toBe(false);
  });

  test("a lockfile edit trips the same rule", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const { harness, id, asked } = await startFixSession(store, repo);
    const hooks = harness.hooks();

    const allowed = await hooks.requestPermission(
      request(id, { toolCallId: "exec-1", kind: "execute", rawInput: { command: "git status" } }),
    );
    expect(allowed.outcome).toEqual({ outcome: "selected", optionId: "allow" });

    await hooks.requestPermission(
      request(id, {
        toolCallId: "edit-1",
        kind: "edit",
        locations: [{ path: join(repo.path, "bun.lock") }],
      }),
    );

    const forwarded = await hooks.requestPermission(
      request(id, { toolCallId: "exec-2", kind: "execute", rawInput: { command: "git status" } }),
    );
    expect(asked).toHaveLength(1);
    expect(forwarded.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  test("an ordinary source edit leaves the allowlist working", async () => {
    const repo = makeRepo();
    const { store } = openStore();
    const { harness, id, asked } = await startFixSession(store, repo);
    const hooks = harness.hooks();

    await hooks.requestPermission(
      request(id, {
        toolCallId: "edit-1",
        kind: "edit",
        locations: [{ path: join(repo.path, "src", "thing.ts") }],
      }),
    );
    const after = await hooks.requestPermission(
      request(id, { toolCallId: "exec-1", kind: "execute", rawInput: { command: "bun run lint" } }),
    );
    expect(after.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(asked).toHaveLength(0);
  });
});

describe("the frozen allowlist is on the record", () => {
  test("it survives a daemon restart and is still what the policy decides on", async () => {
    const repo = makeRepo();
    const { store, dbPath } = openStore();
    const { harness, id } = await startFixSession(store, repo);
    const frozen = harness.manager.get(id)?.execAllowlist;
    expect(frozen).toContain("bun run lint");
    store.close();

    // A new daemon process: new store, new manager, same database.
    const restarted = makeManager(openStore(dbPath).store);
    expect(restarted.manager.get(id)?.execAllowlist).toEqual(frozen);
    expect(restarted.manager.get(id)?.mode).toBe("fix");

    const asked: RequestPermissionRequest[] = [];
    await restarted.manager.activate(id);
    restarted.manager.attach(id, rejectingClient(asked));
    const hooks = restarted.hooks();
    const verdict = await hooks.requestPermission(
      request(id, { toolCallId: "exec-1", kind: "execute", rawInput: { command: "bun run lint" } }),
    );
    expect(verdict.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(asked).toHaveLength(0);
  });

  test("an edit recorded before the restart still forwards after it", async () => {
    const repo = makeRepo();
    const { store, dbPath } = openStore();
    const { harness, id } = await startFixSession(store, repo);
    await harness.hooks().requestPermission(
      request(id, {
        toolCallId: "edit-1",
        kind: "edit",
        locations: [{ path: join(repo.path, "package.json") }],
      }),
    );
    store.close();

    const restarted = makeManager(openStore(dbPath).store);
    const asked: RequestPermissionRequest[] = [];
    await restarted.manager.activate(id);
    restarted.manager.attach(id, rejectingClient(asked));
    // The permission events are the record of the edit, so the rule holds
    // across the restart without any new state.
    const verdict = await restarted.hooks().requestPermission(
      request(id, { toolCallId: "exec-1", kind: "execute", rawInput: { command: "bun run lint" } }),
    );
    expect(asked).toHaveLength(1);
    expect(verdict.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });
});
