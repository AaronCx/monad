import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notesFileName } from "../src/notes.ts";
import { LinkError } from "../src/service.ts";
import { accessEvents, type Harness, makeHarness, PLANTED_TOKEN } from "./helpers.ts";

/**
 * Repo notes (monad Link phase 3, decision record 0012): explicit,
 * provenance-stamped lines kept under $MONAD_HOME/notes, never in a
 * repository or worktree, scoped like the rest of Link, and redacted both
 * ways.
 */

let harnesses: Harness[] = [];
let extraDirs: string[] = [];

afterEach(() => {
  for (const harness of harnesses) {
    harness.close();
  }
  harnesses = [];
  for (const dir of extraDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  extraDirs = [];
});

function harness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  harnesses.push(h);
  return h;
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extraDirs.push(dir);
  return dir;
}

function tempRepo(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function expectRefused(call: () => unknown, code: string, text: string): Promise<void> {
  let caught: unknown;
  try {
    await call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LinkError);
  expect((caught as LinkError).code).toBe(code as LinkError["code"]);
  expect((caught as LinkError).message).toContain(text);
}

describe("where notes live", () => {
  test("under MONAD_HOME/notes, 0600 in a 0700 dir, never under the session's cwd or the repo", async () => {
    const h = harness();
    const repo = tempRepo("monad-notes-repo-");
    const session = await h.session(repo);
    const caller = { kind: "session" as const, id: session.id };
    const repoBefore = readdirSync(repo).sort();

    const first = h.link.notesAppend(caller, join(repo, "src"), "bun only; never npm");
    const second = h.link.notesAppend({ kind: "human" }, repo, "release on Fridays");

    expect(first.repo).toBe(repo);
    const file = join(h.dir, "notes", notesFileName(repo));
    expect(mode(join(h.dir, "notes"))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(repo).sort()).toEqual(repoBefore);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { ts: first.note.ts, by: session.id, repo, text: "bun only; never npm" },
      { ts: second.note.ts, by: "human", repo, text: "release on Fridays" },
    ]);
    for (const line of lines) {
      expect(Date.parse(line.ts)).not.toBeNaN();
    }

    expect(h.link.notesRead(caller, repo).notes.map((note) => note.text)).toEqual([
      "bun only; never npm",
      "release on Fridays",
    ]);
    expect(accessEvents(h.store, session.id).map((access) => [access.op, access.repo])).toEqual([
      ["notes_append", repo],
      ["notes_read", repo],
    ]);
  });

  test("an existing notes file with loose permissions is tightened on the next append", () => {
    const h = harness();
    const repo = tempRepo("monad-notes-loose-");
    mkdirSync(join(h.dir, "notes"), { recursive: true });
    const file = join(h.dir, "notes", notesFileName(repo));
    writeFileSync(file, "", { mode: 0o644 });
    h.link.notesAppend({ kind: "human" }, repo, "tighten me");
    expect(mode(file)).toBe(0o600);
  });

  test("a linked worktree's notes are its main repository's", async () => {
    const h = harness();
    const main = tempDir("monad-notes-main-");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "f",
          GIT_AUTHOR_EMAIL: "f@example.invalid",
          GIT_COMMITTER_NAME: "f",
          GIT_COMMITTER_EMAIL: "f@example.invalid",
        },
      });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "init");
    const worktree = join(tempDir("monad-notes-wt-"), "wt");
    git(main, "worktree", "add", "-q", "--detach", worktree);
    const result = h.link.notesAppend({ kind: "human" }, worktree, "noted from a worktree");
    expect(result.repo).toBe(main);
    expect(readdirSync(worktree)).not.toContain("notes");
    expect(h.link.notesRead({ kind: "human" }, main).notes.map((note) => note.text)).toEqual(["noted from a worktree"]);
  });
});

describe("what notes refuse", () => {
  test("a path outside any git repository, a relative path, and empty or oversized text", async () => {
    const h = harness();
    const session = await h.session();
    const caller = { kind: "session" as const, id: session.id };
    const plain = tempDir("monad-notes-plain-");
    await expectRefused(() => h.link.notesRead(caller, plain), "invalid", "is not inside a git repository");
    await expectRefused(() => h.link.notesAppend(caller, plain, "x"), "invalid", "is not inside a git repository");
    await expectRefused(() => h.link.notesRead(caller, "src"), "invalid", "must be an absolute path");
    const repo = tempRepo("monad-notes-ok-");
    await expectRefused(() => h.link.notesAppend(caller, repo, "   "), "invalid", "non-empty");
    await expectRefused(() => h.link.notesAppend(caller, repo, "x".repeat(8_001)), "invalid", "longer than");
    expect(accessEvents(h.store, session.id).every((access) => typeof access.refused === "string")).toBe(true);
    expect(readdirSync(h.dir)).not.toContain("notes");
  });

  test("a repository outside link.json's scope, for a session; the human is not scoped", async () => {
    const allowed = tempRepo("monad-notes-allowed-");
    const other = tempRepo("monad-notes-other-");
    const h = harness({ config: { repos: [allowed] } });
    const session = await h.session(allowed);
    const caller = { kind: "session" as const, id: session.id };
    expect(h.link.notesAppend(caller, allowed, "in scope").repo).toBe(allowed);
    await expectRefused(() => h.link.notesRead(caller, other), "forbidden", "outside the repos link.json allows");
    await expectRefused(() => h.link.notesAppend(caller, other, "x"), "forbidden", "outside the repos link.json allows");
    expect(h.link.notesAppend({ kind: "human" }, other, "the human may").repo).toBe(other);
  });

  test("notes_append is not offered to review or fix sessions; notes_read is", async () => {
    const h = harness();
    const repo = tempRepo("monad-notes-review-");
    for (const mode of ["review", "fix"] as const) {
      const record = h.manager.createRecord({ cwd: repo, mode, trust: "trusted" });
      expect(h.link.toolsFor(record.id)).toContain("notes_read");
      expect(h.link.toolsFor(record.id)).not.toContain("notes_append");
      const caller = { kind: "session" as const, id: record.id };
      await expectRefused(() => h.link.notesAppend(caller, repo, "x"), "forbidden", `not available to a ${mode} session`);
      expect(h.link.notesRead(caller, repo).notes).toEqual([]);
    }
    // Untrusted sessions have neither.
    const untrusted = h.manager.createRecord({ cwd: repo, mode: "review", trust: "untrusted" });
    await expectRefused(
      () => h.link.notesRead({ kind: "session", id: untrusted.id }, repo),
      "forbidden",
      "no monad-sessions access",
    );
  });
});

describe("notes are redacted both ways", () => {
  test("a planted token never reaches the file, and one already in the file never reaches a reader", () => {
    const h = harness();
    const repo = tempRepo("monad-notes-token-");
    h.link.notesAppend({ kind: "human" }, repo, `deploy key ${PLANTED_TOKEN}`);
    const file = join(h.dir, "notes", notesFileName(repo));
    expect(readFileSync(file, "utf8")).not.toContain(PLANTED_TOKEN);
    // A line written by hand (or before a pattern existed) with the token in it.
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${JSON.stringify({ ts: new Date().toISOString(), by: "human", repo, text: `old ${PLANTED_TOKEN}` })}\nnot json\n`,
    );
    const notes = h.link.notesRead({ kind: "human" }, repo).notes;
    expect(notes).toHaveLength(2);
    expect(JSON.stringify(notes)).not.toContain(PLANTED_TOKEN);
    expect(notes[1]?.text).toContain("[REDACTED:");
  });
});
