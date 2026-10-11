import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { HandoffPayload, SessionId } from "@aaroncx/protocol";
import { HandoffScheduler, handoffIdleMs } from "../src/handoff.ts";
import { type Harness, makeHarness, PLANTED_TOKEN, userPrompt, waitFor } from "./helpers.ts";

/**
 * Deterministic handoffs (monad Link phase 3, decision record 0012): written
 * once per idle stretch and just before close, caught up at daemon start,
 * carrying git state, held permissions and children, redacted, and never a
 * reason to spend vendor tokens.
 */

let harnesses: Harness[] = [];
let schedulers: HandoffScheduler[] = [];
let extraDirs: string[] = [];

afterEach(() => {
  for (const scheduler of schedulers) {
    scheduler.stop();
  }
  schedulers = [];
  for (const harness of harnesses) {
    harness.close();
  }
  harnesses = [];
  for (const dir of extraDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  extraDirs = [];
});

function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

function scheduler(h: Harness, idleMs: number): HandoffScheduler {
  const s = new HandoffScheduler({
    manager: h.manager,
    store: h.store,
    write: (id, reason) => h.link.writeHandoff(id, reason),
    idleMs,
    skip: (record) => h.link.isSummarizer(record),
  });
  schedulers.push(s);
  return s;
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extraDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

/** A real git repository with one commit on main. */
function gitRepo(prefix: string): string {
  const dir = tempDir(prefix);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: init");
  return dir;
}

function handoffs(h: Harness, id: SessionId): HandoffPayload[] {
  return h.store.replayKinds(id, ["handoff"]).map((event) => event.payload as HandoffPayload);
}

/** Runs one whole turn through the manager and its fake backend. */
async function turn(h: Harness, id: SessionId, text: string): Promise<void> {
  const before = h.backends.get(id)?.prompts.length ?? 0;
  const done = h.manager.prompt(id, userPrompt(id, text));
  await waitFor(() => (h.backends.get(id)?.prompts.length ?? 0) > before, "the turn to reach the backend");
  h.backends.get(id)?.endTurn();
  await done;
}

const PERMISSION: RequestPermissionRequest = {
  sessionId: "x",
  toolCall: { toolCallId: "call_edit", title: "Edit config.json", kind: "edit", status: "pending" },
  options: [
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Skip", optionId: "reject" },
  ],
};

describe("the idle window", () => {
  test("MONAD_HANDOFF_IDLE_MS overrides ten minutes; junk does not", () => {
    expect(handoffIdleMs({})).toBe(600_000);
    expect(handoffIdleMs({ MONAD_HANDOFF_IDLE_MS: "250" })).toBe(250);
    expect(handoffIdleMs({ MONAD_HANDOFF_IDLE_MS: "soon" })).toBe(600_000);
    expect(handoffIdleMs({ MONAD_HANDOFF_IDLE_MS: "-5" })).toBe(600_000);
  });
});

describe("idle handoffs", () => {
  test("exactly one per idle stretch, and a new prompt starts a new stretch", async () => {
    const h = harness();
    const s = await h.session();
    scheduler(h, 40).start();

    await turn(h, s.id, "fix the scroll clamp");
    const updatedAt = h.store.get(s.id)?.updatedAt;
    await waitFor(() => handoffs(h, s.id).length === 1, "the first idle handoff");
    expect(handoffs(h, s.id)[0]?.reason).toBe("idle");

    // Several more windows pass: the stretch already has its handoff, and
    // writing it re-armed nothing and did not move updatedAt.
    await Bun.sleep(200);
    expect(handoffs(h, s.id)).toHaveLength(1);
    expect(h.store.get(s.id)?.updatedAt).toBe(updatedAt);

    // A turn in flight is not idle, however long it runs.
    const done = h.manager.prompt(s.id, userPrompt(s.id, "now the status row"));
    await waitFor(() => h.backends.get(s.id)?.prompts.length === 2, "the second turn");
    await Bun.sleep(150);
    expect(handoffs(h, s.id)).toHaveLength(1);
    h.backends.get(s.id)?.endTurn();
    await done;

    await waitFor(() => handoffs(h, s.id).length === 2, "the second stretch's handoff");
    expect(handoffs(h, s.id)[1]?.lastAsks).toEqual(["fix the scroll clamp", "now the status row"]);
    await Bun.sleep(150);
    expect(handoffs(h, s.id)).toHaveLength(2);
  });

  test("a session nobody prompted gets no automatic handoff", async () => {
    const h = harness();
    const s = await h.session();
    scheduler(h, 20).start();
    await Bun.sleep(120);
    expect(handoffs(h, s.id)).toEqual([]);
    await h.manager.close(s.id);
    expect(handoffs(h, s.id)).toEqual([]);
  });
});

describe("closing handoffs", () => {
  test("close writes the handoff before closed, with what the session still held", async () => {
    const h = harness();
    const s = await h.session();
    scheduler(h, 60_000).start();
    await turn(h, s.id, "edit the config");
    // A turn holding a permission when the session is closed: the handoff
    // is written before close cancels it, so it says what was pending.
    void h.manager.prompt(s.id, userPrompt(s.id, "and the other config"));
    await waitFor(() => h.backends.get(s.id)?.prompts.length === 2, "the second turn");
    void h.backends.get(s.id)?.requestPermission({ ...PERMISSION, sessionId: s.id });
    await waitFor(() => h.store.get(s.id)?.status === "waiting_for_permission", "the permission to be held");

    await h.manager.close(s.id);
    // The handoff comes first; only close's own teardown (the held request
    // resolved as cancelled, then closed) follows it.
    const kinds = h.store.replay(s.id).map((event) => event.kind);
    expect(kinds.slice(kinds.indexOf("handoff"))).toEqual(["handoff", "permission_resolved", "closed"]);
    const [handoff] = handoffs(h, s.id);
    expect(handoff?.reason).toBe("closed");
    expect(handoff?.pendingPermissions).toEqual([{ toolCallId: "call_edit", title: "Edit config.json" }]);
    expect(handoff?.text.split("\n")[0]).toContain("1 pending permission");
  });
});

describe("catch-up at daemon start", () => {
  test("a session idle past the window under a previous daemon is handed off at once; a recent one waits", async () => {
    const h = harness();
    const stale = await h.session();
    const recent = await h.session();
    const done = await h.session();
    // The previous daemon: turns ran, nobody scheduled anything.
    await turn(h, stale.id, "old work");
    await turn(h, done.id, "already handed off");
    await h.link.writeHandoff(done.id, "idle");
    await Bun.sleep(300);
    await turn(h, recent.id, "fresh work");

    const s = scheduler(h, 250);
    s.start();
    await waitFor(() => handoffs(h, stale.id).length === 1, "the stale session's catch-up handoff", 1_000);
    expect(handoffs(h, recent.id)).toEqual([]);
    expect(s.armed()).toContain(recent.id);
    expect(handoffs(h, done.id)).toHaveLength(1);
    await waitFor(() => handoffs(h, recent.id).length === 1, "the recent session's handoff, later", 2_000);
    expect(handoffs(h, done.id)).toHaveLength(1);
  });
});

describe("what a handoff holds", () => {
  test("the git state of two repos, one dirty, from a session that ran outside both", async () => {
    const h = harness();
    const home = tempDir("monad-handoff-home-");
    const clean = gitRepo("monad-handoff-clean-");
    const dirty = gitRepo("monad-handoff-dirty-");
    writeFileSync(join(dirty, "README.md"), "# changed\n");
    writeFileSync(join(dirty, "new.txt"), "untracked\n");
    git(clean, "checkout", "-q", "-b", "feat/clamp");
    const s = await h.session(home);
    h.history(s.id, [
      ["prompt", userPrompt(s.id, "touch both repos")],
      [
        "update",
        {
          sessionId: s.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read README",
            kind: "read",
            locations: [{ path: join(clean, "README.md") }],
          },
        },
      ],
      [
        "update",
        {
          sessionId: s.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "Edit README",
            kind: "edit",
            locations: [{ path: join(dirty, "README.md") }],
          },
        },
      ],
      ["turn_ended", { stopReason: "end_turn" }],
    ]);

    const event = await h.link.writeHandoff(s.id, "manual");
    const payload = event?.payload as HandoffPayload;
    expect(payload.files).toEqual([join(clean, "README.md"), join(dirty, "README.md")]);
    const byRoot = new Map(payload.repos.map((repo) => [repo.root, repo]));
    expect([...byRoot.keys()].sort()).toEqual([clean, dirty].sort());
    expect(byRoot.get(clean)).toMatchObject({
      checkout: clean,
      branch: "feat/clamp",
      head: git(clean, "rev-parse", "HEAD"),
      dirty: false,
      changedCount: 0,
    });
    expect(byRoot.get(dirty)).toMatchObject({ branch: "main", head: git(dirty, "rev-parse", "HEAD"), dirty: true, changedCount: 2 });
    expect(byRoot.get(dirty)?.changedFiles.sort()).toEqual(["README.md", "new.txt"]);
    expect(byRoot.get(dirty)?.error).toBeUndefined();
    const first = payload.text.split("\n")[0] ?? "";
    expect(first).toContain('handoff: last asked "touch both repos"');
    expect(first).toContain("(main, 2 changed)");
    expect(first).toContain("(feat/clamp, clean)");
  });

  test("a repository git cannot read is recorded as an error, never thrown", async () => {
    const h = harness();
    const repo = tempDir("monad-handoff-gone-");
    // A .git directory with nothing in it: the resolver calls it a repo,
    // git does not.
    execFileSync("mkdir", [join(repo, ".git")]);
    const s = await h.session(repo);
    h.history(s.id, [["prompt", userPrompt(s.id, "anything")]]);
    const payload = (await h.link.writeHandoff(s.id, "manual"))?.payload as HandoffPayload;
    expect(payload.repos).toHaveLength(1);
    expect(payload.repos[0]?.error).toContain("git");
  });

  test("pending permissions and spawned children with their status", async () => {
    const h = harness();
    const parent = await h.session();
    const child = h.manager.createRecord({ cwd: h.dir, parentId: parent.id, spawnDepth: 1, trust: "trusted" });
    void h.manager.prompt(parent.id, userPrompt(parent.id, "spawn a helper and edit"));
    await waitFor(() => h.backends.get(parent.id)?.prompts.length === 1, "the turn");
    void h.backends.get(parent.id)?.requestPermission({ ...PERMISSION, sessionId: parent.id });
    await waitFor(() => h.manager.pendingPermissionCount(parent.id) === 1, "the held permission");

    const payload = (await h.link.writeHandoff(parent.id, "manual"))?.payload as HandoffPayload;
    expect(payload.pendingPermissions).toEqual([{ toolCallId: "call_edit", title: "Edit config.json" }]);
    expect(payload.children).toEqual([{ id: child.id, status: "idle" }]);
    expect(payload.text).toContain("## Pending permissions");
    expect(payload.text).toContain(`- ${child.id} "untitled": idle`);
    expect(payload.text.split("\n")[0]).toContain("1 pending permission; 1 child");
    // Listing the handoff is not answering the permission.
    expect(h.manager.pendingPermissionCount(parent.id)).toBe(1);
  });

  test("errors since the last ask are counted in the summary line", async () => {
    const h = harness();
    const s = await h.session();
    h.history(s.id, [
      ["error", { message: "an old failure" }],
      ["prompt", userPrompt(s.id, "try again")],
      ["error", { message: "vendor crashed" }],
    ]);
    const payload = (await h.link.writeHandoff(s.id, "manual"))?.payload as HandoffPayload;
    expect(payload.lastErrors).toEqual(["an old failure", "vendor crashed"]);
    expect(payload.text.split("\n")[0]).toContain("1 error in the last turn");
  });

  test("a planted token never reaches the handoff, its text, or the index", async () => {
    const h = harness();
    const s = await h.session();
    h.history(s.id, [
      ["prompt", userPrompt(s.id, `push with ${PLANTED_TOKEN} please`)],
      ["error", { message: `auth failed for ${PLANTED_TOKEN}` }],
    ]);
    const event = await h.link.writeHandoff(s.id, "manual");
    expect(JSON.stringify(event?.payload)).not.toContain(PLANTED_TOKEN);
    expect((event?.payload as HandoffPayload).text).toContain("[REDACTED:");
    expect(h.link.lastHandoffLine(s.id)).not.toContain(PLANTED_TOKEN);
    expect(h.store.search("push", { kinds: ["handoff"] })).toHaveLength(1);
    expect(h.store.search(PLANTED_TOKEN)).toEqual([]);
  });
});

describe("sessions_list shows the last handoff", () => {
  test("its first line, and only the latest one", async () => {
    const h = harness();
    const reader = await h.session();
    const s = await h.session();
    expect(h.link.list({ kind: "session", id: reader.id }).find((x) => x.id === s.id)?.lastHandoff).toBeUndefined();
    await turn(h, s.id, "first ask");
    await h.link.writeHandoff(s.id, "idle");
    await turn(h, s.id, "second ask");
    const latest = await h.link.writeHandoff(s.id, "manual");
    const listed = h.link.list({ kind: "session", id: reader.id }).find((x) => x.id === s.id);
    const first = (latest?.payload as HandoffPayload).text.split("\n")[0];
    expect(listed?.lastHandoff).toBe(first);
    expect(listed?.lastHandoff).toContain('last asked "second ask"');
  });
});

describe("summaries are never automatic", () => {
  test("idle and close handoffs start no summarizer session and write no summary", async () => {
    const h = harness();
    const s = await h.session();
    scheduler(h, 30).start();
    await turn(h, s.id, "do the work");
    await waitFor(() => handoffs(h, s.id).length === 1, "the idle handoff");
    await h.manager.close(s.id);
    expect(handoffs(h, s.id)).toHaveLength(2);
    // The only sessions are the one the test made: no summarizer was created.
    expect(h.store.list().map((record) => record.id)).toEqual([s.id]);
    expect(h.store.replayKinds(s.id, ["summary"])).toEqual([]);
    expect(existsSync(join(h.dir, "summaries"))).toBe(false);
  });
});
