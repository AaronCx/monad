import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { EventRecord, ReviewReport, SessionRecord } from "@aaroncx/protocol";

/**
 * The review playbook end to end against the real monadd with the fake ACP
 * agent in --review mode, on a fixture repo whose origin is a LOCAL bare
 * repo carrying a hand-made refs/pull/5/head. No gh, no network.
 *
 * Asserts the brief's event sequence (worktree_ready, checks,
 * session_created, prompt, update..., review_report, turn_ended), the
 * parsed canned report, the exit-deciding result fields, the worktree
 * location under MONAD_HOME/worktrees, that the fake agent really called
 * run_checks over the injected MCP entry, and that the session is left
 * idle in review mode. Then flips the session to fix over the control API.
 */

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FAKE_AGENT = new URL(
  "../../../packages/backends/test/fixtures/fake-agent.ts",
  import.meta.url,
).pathname;

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

interface Fixture {
  /** The user's checkout, origin pointing at the bare repo. */
  repoRoot: string;
  bare: string;
  headSha: string;
  /** The exact mkdtemp roots to delete afterwards. */
  tempDirs: string[];
}

/** Base commit on main, a PR branch adding two plain files, refs/pull/5/head. */
function makePrFixture(): Fixture {
  const seed = mkdtempSync(join(tmpdir(), "monad-review-seed-"));
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# fixture\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "chore: base");
  git(seed, "checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "app.notes"), "line one\nline two\n");
  writeFileSync(
    join(seed, "src-app.txt"),
    "plain fixture content\nsecond line under review\n",
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "feat: add reviewed files");
  const headSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");

  const bareParent = mkdtempSync(join(tmpdir(), "monad-review-origin-"));
  const bare = join(bareParent, "origin.git");
  git(bareParent, "clone", "-q", "--bare", seed, bare);
  // The PR ref exists only on the server side, exactly like GitHub's
  // refs/pull/<n>/head; the local branch name is irrelevant.
  git(bare, "update-ref", "refs/pull/5/head", headSha);
  git(bare, "branch", "-q", "-D", "feature");

  const cloneParent = mkdtempSync(join(tmpdir(), "monad-review-clone-"));
  const repoRoot = join(cloneParent, "checkout");
  git(cloneParent, "clone", "-q", bare, repoRoot);
  return { repoRoot, bare, headSha, tempDirs: [seed, bareParent, cloneParent] };
}

interface RunningDaemon {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function bootDaemon(home: string): Promise<RunningDaemon> {
  const infoPath = join(home, "monadd.json");
  rmSync(infoPath, { force: true });
  const proc = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT, "--review"].join(" "),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(infoPath), "monadd.json to appear");
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as { port: number };
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return { proc, port: info.port, token };
}

interface StreamedReview {
  events: EventRecord[];
  result?: {
    sessionId: string;
    worktree: string;
    report: unknown;
    structured: boolean;
    checksFailed: boolean;
    failed: boolean;
    checksTable: string;
    baseSha: string;
    headSha: string;
  };
  errorLine?: { message: string };
}

async function postReviewRequest(
  daemon: RunningDaemon,
  body: unknown,
): Promise<StreamedReview> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/review`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const out: StreamedReview = { events: [] };
  for (const line of text.split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as { type: string } & Record<string, unknown>;
    if (parsed.type === "event") {
      out.events.push(parsed.event as EventRecord);
    } else if (parsed.type === "result") {
      out.result = parsed as unknown as StreamedReview["result"];
    } else if (parsed.type === "error") {
      out.errorLine = parsed as unknown as { message: string };
    }
  }
  return out;
}

const CLI_MAIN = new URL("../../cli/src/main.ts", import.meta.url).pathname;

function promptEvents(home: string, sessionId: string): Array<{ text: string }> {
  // The daemon owns the live DB, so read it read-only rather than opening a
  // second writer against the same WAL.
  const db = new Database(join(home, "monad.db"), { readonly: true });
  try {
    const rows = db
      .query("select payload from events where session_id = ? and kind = 'prompt' order by seq")
      .all(sessionId) as Array<{ payload: string }>;
    return rows.map((row) => {
      const parsed = JSON.parse(row.payload) as { prompt?: Array<{ text?: string }> };
      return { text: parsed.prompt?.[0]?.text ?? "" };
    });
  } finally {
    db.close();
  }
}

let home: string;
let fixture: Fixture;
let daemon: RunningDaemon;
let streamed: StreamedReview;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-review-home-"));
  fixture = makePrFixture();
  daemon = await bootDaemon(home);
  streamed = await postReviewRequest(daemon, {
    repoRoot: fixture.repoRoot,
    pr: {
      repo: "example/fixture",
      number: 5,
      url: "https://github.com/example/fixture/pull/5",
      title: "Add reviewed files",
      body: "Adds two plain files for the review fixture.",
      headSha: fixture.headSha,
      baseRef: "main",
    },
  });
}, 30_000);

afterAll(async () => {
  daemon.proc.kill();
  await daemon.proc.exited;
  rmSync(home, { recursive: true, force: true });
  for (const dir of fixture.tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /v1/review", () => {
  test("streams the playbook event sequence in log order", () => {
    expect(streamed.errorLine).toBeUndefined();
    const kinds = streamed.events.map((event) => event.kind);
    expect(kinds.slice(0, 3)).toEqual(["worktree_ready", "checks", "session_created"]);
    const promptIndex = kinds.indexOf("prompt");
    expect(promptIndex).toBeGreaterThan(2);
    expect(kinds.at(-1)).toBe("turn_ended");
    expect(kinds.at(-2)).toBe("review_report");
    const updatesBetween = kinds.slice(promptIndex + 1, -2).filter((kind) => kind === "update");
    expect(updatesBetween.length).toBeGreaterThan(0);
  });

  test("the fake agent called run_checks through the injected MCP entry", () => {
    const agentText = streamed.events
      .filter((event) => event.kind === "update")
      .map((event) => {
        const update = (event.payload as { update?: { sessionUpdate?: string; content?: unknown } })
          .update;
        if (update?.sessionUpdate !== "agent_message_chunk") {
          return "";
        }
        const content = update.content as { type?: string; text?: string };
        return content?.type === "text" ? (content.text ?? "") : "";
      })
      .join("");
    expect(agentText).toContain("run_checks ok: hasFailures=false");
  });

  test("the result carries the parsed canned report and a passing verdict", () => {
    const result = streamed.result;
    expect(result).toBeDefined();
    expect(result?.structured).toBe(true);
    expect(result?.checksFailed).toBe(false);
    expect(result?.failed).toBe(false);
    expect(result?.headSha).toBe(fixture.headSha);
    expect(result?.checksTable).toContain("| check | status | findings |");
    const report = result?.report as ReviewReport;
    expect(report.verdict).toBe("comment");
    expect(report.summary).toContain("Canned fake review");
    expect(report.findings).toHaveLength(2);
    expect(report.checks_acknowledged).toBe(true);
  });

  test("the checks event stored full CheckRunResults for the PR diff", () => {
    const checksEvent = streamed.events.find((event) => event.kind === "checks");
    const payload = checksEvent?.payload as {
      checks: Array<{ type: string }>;
      hasFailures: boolean;
      summary: string;
      meta: unknown;
    };
    expect(payload.hasFailures).toBe(false);
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.meta).toBeDefined();
  });

  test("the worktree lives under MONAD_HOME/worktrees and is a detached checkout of the head", () => {
    const result = streamed.result;
    expect(result?.worktree.startsWith(join(home, "worktrees"))).toBe(true);
    expect(git(result?.worktree ?? "", "rev-parse", "HEAD")).toBe(fixture.headSha);
    const worktreeReady = streamed.events[0]?.payload as {
      path: string;
      installStrategy: string;
      installMs: number;
    };
    expect(worktreeReady.path).toBe(result?.worktree ?? "");
    // The fixture repo has no package.json, so none is implied.
    expect(worktreeReady.installStrategy).toBe("none");
  });

  test("the session is left idle in review mode with the PR pinned", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const { sessions } = (await response.json()) as { sessions: SessionRecord[] };
    const session = sessions.find((record) => record.id === streamed.result?.sessionId);
    expect(session?.status).toBe("idle");
    expect(session?.mode).toBe("review");
    expect(session?.pr?.number).toBe(5);
    expect(session?.pr?.headSha).toBe(fixture.headSha);
    expect(session?.pr?.repo).toBe("example/fixture");
    expect(session?.base).toBe(streamed.result?.baseSha ?? "");
  });
});

describe("POST /v1/sessions/<id>/mode", () => {
  test("switches the stored mode to fix", async () => {
    const sessionId = streamed.result?.sessionId ?? "";
    const response = await fetch(
      `http://127.0.0.1:${daemon.port}/v1/sessions/${sessionId}/mode`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "fix" }),
      },
    );
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: SessionRecord };
    expect(session.mode).toBe("fix");
  });

  test("an unknown session id gets 404", async () => {
    const response = await fetch(
      `http://127.0.0.1:${daemon.port}/v1/sessions/00000000-0000-7000-8000-000000000000/mode`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "review" }),
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("monad attach -p", () => {
  test("sends exactly one prompt to the session and exits without a stdin loop", async () => {
    // Regression: cmdAttach parsed -p and then dropped it, always falling
    // through to the interactive stdin loop. With no tty the loop saw EOF
    // and the process exited 0 having sent nothing, so a scripted attach
    // looked successful while the agent was never prompted.
    const sessionId = streamed.result?.sessionId ?? "";
    expect(sessionId).not.toBe("");
    const before = promptEvents(home, sessionId).length;

    const cli = Bun.spawnSync(
      [process.execPath, CLI_MAIN, "attach", sessionId, "-p", "one scripted prompt"],
      {
        cwd: fixture.repoRoot,
        env: { ...process.env, MONAD_HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(cli.exitCode).toBe(0);
    const after = promptEvents(home, sessionId);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.text).toBe("one scripted prompt");
  }, 30_000);
});
