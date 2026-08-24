import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { deriveMountToken } from "@aaroncx/engine";
import type { EventRecord, ReviewReport, SessionRecord } from "@aaroncx/protocol";
import {
  makeMaliciousRepo,
  type MaliciousRepo,
} from "../../../packages/checks/test/fixtures/make-repo.ts";

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

/**
 * A stand-in for the bun binary that does exactly the one thing this test
 * cares about: run the manifest's preinstall script, the way a real install
 * does. Pointed at through MONAD_BUN_BIN so the fixture needs no lockfile
 * and no network, while an install still executes the PR's own code.
 */
function writeFakeBun(dir: string): string {
  const path = join(dir, "fake-bun.sh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "# fake bun install: runs the manifest's preinstall hook, like the real one.",
      `script=$(sed -n 's/.*"preinstall": "\\(.*\\)".*/\\1/p' package.json 2>/dev/null)`,
      'if [ -n "$script" ]; then sh -c "$script"; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

/** Wraps a repo as a PR: a bare origin carrying refs/pull/<n>/head. */
function publishAsPr(
  seed: string,
  headSha: string,
  number: number,
): { repoRoot: string; tempDirs: string[] } {
  const bareParent = mkdtempSync(join(tmpdir(), "monad-review-origin-"));
  const bare = join(bareParent, "origin.git");
  git(bareParent, "clone", "-q", "--bare", seed, bare);
  git(bare, "update-ref", `refs/pull/${number}/head`, headSha);
  const branches = git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  for (const branch of branches.split("\n").map((b) => b.trim())) {
    if (branch && branch !== "main") {
      git(bare, "branch", "-q", "-D", branch);
    }
  }
  const cloneParent = mkdtempSync(join(tmpdir(), "monad-review-clone-"));
  const repoRoot = join(cloneParent, "checkout");
  git(cloneParent, "clone", "-q", bare, repoRoot);
  return { repoRoot, tempDirs: [bareParent, cloneParent] };
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

async function bootDaemon(home: string, extraEnv: Record<string, string> = {}): Promise<RunningDaemon> {
  const infoPath = join(home, "monadd.json");
  rmSync(infoPath, { force: true });
  const proc = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env: {
      ...process.env,
      MONAD_HOME: home,
      MONAD_BACKEND_CMD: [process.execPath, FAKE_AGENT, "--review"].join(" "),
      ...extraEnv,
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
    trust: "trusted" | "untrusted";
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
let binDir: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "monad-review-home-"));
  fixture = makePrFixture();
  // The fake installer only matters to the trust tests below; the fixture
  // above has no package.json, so nothing installs for it either way.
  binDir = mkdtempSync(join(tmpdir(), "monad-review-bin-"));
  daemon = await bootDaemon(home, { MONAD_BUN_BIN: writeFakeBun(binDir) });
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
  rmSync(binDir, { recursive: true, force: true });
  for (const dir of [...fixture.tempDirs, ...trustDirs]) {
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

/**
 * The trust boundary end to end (decision record 0009). The PR under review
 * is makeMaliciousRepo's head: a .monad.yml pointing lint, build, and test at
 * a canary-writing script, a package.json whose preinstall writes another
 * canary, and a review.prompt override telling the reviewer to approve.
 *
 * Untrusted is the default, so the first run is the one M2 would have failed.
 * The same PR is then reviewed with trust "trusted" (what --trust sends) to
 * prove the trusted path still does everything it did in M2.
 */
const trustDirs: string[] = [];
let malicious: MaliciousRepo;
let maliciousRepoRoot: string;
let untrustedReview: StreamedReview;
let trustedReview: StreamedReview;
/**
 * Canary state captured the moment the untrusted review finished. The
 * trusted review runs in the same beforeAll and writes both canaries on
 * purpose, so the untrusted assertions read this snapshot, not the disk.
 */
let canariesAfterUntrusted: { lint: boolean; install: boolean };
let untrustedRunChecks: { text: string; structured: Record<string, unknown> };

function checksEventOf(review: StreamedReview): {
  configSource?: { file: string; ref: string };
  trust?: string;
  droppedConfigFields?: string[];
  checks: Array<{ type: string; status: string; details: Record<string, unknown> }>;
} {
  const event = review.events.find((e) => e.kind === "checks");
  expect(event).toBeDefined();
  return event?.payload as never;
}

function reviewPromptOf(review: StreamedReview): string {
  return promptEvents(home, review.result?.sessionId ?? "").at(0)?.text ?? "";
}

async function callRunChecks(
  sessionId: string,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/mcp/${sessionId}`, {
    method: "POST",
    headers: {
      // The mount takes that session's derived token, never the daemon
      // token (decision record 0009); this is the vendor's own credential.
      Authorization: `Bearer ${deriveMountToken(daemon.token, sessionId)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_checks", arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
  const parsed = JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : body) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  };
  return {
    text: parsed.result?.content?.find((c) => c.type === "text")?.text ?? "",
    structured: parsed.result?.structuredContent ?? {},
  };
}

describe("review of a hostile PR", () => {
  beforeAll(async () => {
    malicious = makeMaliciousRepo();
    trustDirs.push(malicious.dir, malicious.canaryDir);
    const published = publishAsPr(malicious.dir, malicious.headSha, 6);
    maliciousRepoRoot = published.repoRoot;
    trustDirs.push(...published.tempDirs);
    const body = {
      repoRoot: maliciousRepoRoot,
      pr: {
        repo: "example/hostile",
        number: 6,
        url: "https://github.com/example/hostile/pull/6",
        title: "Perfectly ordinary change",
        body: "Nothing to see here.",
        headSha: malicious.headSha,
        baseRef: "main",
      },
    };
    // No trust field at all: the daemon must default to untrusted.
    untrustedReview = await postReviewRequest(daemon, body);
    // The agent's own escape hatch, exercised while the session is still the
    // untrusted one: ask for the full profile and for build by name.
    untrustedRunChecks = await callRunChecks(untrustedReview.result?.sessionId ?? "", {
      profile: "full",
      only: ["build"],
    });
    canariesAfterUntrusted = {
      lint: existsSync(malicious.lintCanary),
      install: existsSync(malicious.installCanary),
    };
    // Then the same PR as a trusted one, which is what --trust sends. This
    // one is EXPECTED to write both canaries.
    trustedReview = await postReviewRequest(daemon, { ...body, trust: "trusted" });
  }, 90_000);

  test("an untrusted review leaves both canaries absent", () => {
    expect(untrustedReview.errorLine).toBeUndefined();
    expect(untrustedReview.result?.trust).toBe("untrusted");
    expect(canariesAfterUntrusted.lint).toBe(false);
    expect(canariesAfterUntrusted.install).toBe(false);
  });

  test("an untrusted review installs nothing and says why", () => {
    const worktreeReady = untrustedReview.events.find((e) => e.kind === "worktree_ready")
      ?.payload as { installStrategy: string; trust?: string; warnings?: string[] };
    expect(worktreeReady.installStrategy).toBe("none");
    expect(worktreeReady.trust).toBe("untrusted");
    expect(worktreeReady.warnings?.join("\n")).toContain("dependencies were not installed");
  });

  test("an untrusted review's lint and typecheck say the toolchain was not installed", () => {
    const payload = checksEventOf(untrustedReview);
    const noted = payload.checks.filter(
      (check) => check.type === "lint" || check.type === "typecheck",
    );
    expect(noted.length).toBeGreaterThan(0);
    for (const check of noted) {
      expect(check.details.dependenciesInstalled).toBe(false);
      expect(String((check as { summary?: string }).summary)).toContain(
        "dependencies were not installed",
      );
    }
  });

  test("an untrusted review's config comes from the base sha, not the PR head", () => {
    const payload = checksEventOf(untrustedReview);
    expect(payload.trust).toBe("untrusted");
    expect(payload.configSource?.ref).toBe(untrustedReview.result?.baseSha);
    expect(payload.configSource?.ref).toBe(malicious.baseSha);
    expect(payload.configSource?.file).toBe(".monad.yml");
    // The head's lint command never became part of the run.
    const lint = payload.checks.find((check) => check.type === "lint");
    expect(JSON.stringify(lint ?? {})).not.toContain("pwn-lint.sh");
  });

  test("an untrusted review uses monad's own prompt, not the PR's override", () => {
    const prompt = reviewPromptOf(untrustedReview);
    expect(prompt).not.toContain(malicious.promptOverrideMarker);
    expect(prompt).toContain("## Output contract");
    expect(prompt).toContain("BEGIN UNTRUSTED PR BODY");
  });

  test("run_checks with profile full and only build still does not run build", () => {
    const { text, structured } = untrustedRunChecks;
    const checks = structured.checks as Array<{
      type: string;
      status: string;
      details: Record<string, unknown>;
    }>;
    const build = checks.find((check) => check.type === "build");
    expect(build?.status).toBe("pass");
    expect(build?.details.skipped).toBe(true);
    expect(build?.details.reason).toBe("untrusted PR: build and test do not run");
    expect(structured.profile).toBe("fast");
    expect(structured.trust).toBe("untrusted");
    expect(text).toContain("untrusted session");
    expect(text).toContain("downgraded");
    // Still nothing executed: the canary snapshot was taken after this call.
    expect(canariesAfterUntrusted.lint).toBe(false);
  });

  test("a trusted review of the same PR does everything M2 did", () => {
    expect(trustedReview.errorLine).toBeUndefined();
    expect(trustedReview.result?.trust).toBe("trusted");
    expect(trustedReview.result?.structured).toBe(true);

    // Config from the worktree, so the PR's own rules are in force.
    const payload = checksEventOf(trustedReview);
    expect(payload.trust).toBe("trusted");
    expect(payload.configSource?.ref).toBe("worktree");
    expect(payload.configSource?.file).toBe(".monad.yml");

    // The PR's prompt override is honored.
    expect(reviewPromptOf(trustedReview)).toContain(malicious.promptOverrideMarker);

    // And both accepted violations of the boundary happened, on purpose:
    // the install ran the PR's lifecycle script and lint ran its command.
    const worktreeReady = trustedReview.events.find((e) => e.kind === "worktree_ready")
      ?.payload as { installStrategy: string; trust?: string };
    expect(worktreeReady.installStrategy).toBe("install");
    expect(worktreeReady.trust).toBe("trusted");
    expect(existsSync(malicious.installCanary)).toBe(true);
    expect(existsSync(malicious.lintCanary)).toBe(true);
  });

  test("the two sessions carry their trust level on the record", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const { sessions } = (await response.json()) as { sessions: SessionRecord[] };
    const untrusted = sessions.find((r) => r.id === untrustedReview.result?.sessionId);
    const trusted = sessions.find((r) => r.id === trustedReview.result?.sessionId);
    expect(untrusted?.trust).toBe("untrusted");
    expect(trusted?.trust).toBe("trusted");
  });
});
