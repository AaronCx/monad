import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPaths, expandHome, RepoResolver, toolCallPaths } from "../src/repos.ts";

/**
 * Repo tagging's path-to-repository resolution on real temp directories and
 * real git metadata (git init and git worktree add), so the linked-worktree
 * fold is tested against what git actually writes, not a hand-made `.git`.
 */

let dirs: string[] = [];

function tempDir(prefix: string): string {
  // realpath: macOS tmpdir() is behind the /var -> /private/var symlink, and
  // the resolver returns canonical roots.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("RepoResolver", () => {
  test("a file, a directory, and a not-yet-created file all map to the repo root", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const resolver = new RepoResolver();
    expect(resolver.resolve(join(repo, "src", "a.ts"))).toBe(repo);
    expect(resolver.resolve(join(repo, "src"))).toBe(repo);
    expect(resolver.resolve(join(repo, "src", "new", "deep", "file.ts"))).toBe(repo);
    expect(resolver.resolve(repo)).toBe(repo);
  });

  test("a directory that is not in any repo resolves to nothing", () => {
    const home = tempDir("monad-home-");
    const resolver = new RepoResolver({ home });
    expect(resolver.resolve(home)).toBeUndefined();
    expect(resolver.resolve("~")).toBeUndefined();
    expect(resolver.resolve(join(home, "notes.txt"))).toBeUndefined();
  });

  test("relative paths resolve against the cwd, and need one", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const resolver = new RepoResolver();
    expect(resolver.resolve("src/a.ts", repo)).toBe(repo);
    expect(resolver.resolve("alpha/src", parent)).toBe(repo);
    expect(resolver.resolve("src/a.ts")).toBeUndefined();
  });

  test("~ expands against the configured home", () => {
    const home = tempDir("monad-home-");
    const repo = makeRepo(home, "proj");
    const resolver = new RepoResolver({ home });
    expect(resolver.resolve("~/proj/src/a.ts")).toBe(repo);
    expect(resolver.resolve("src", "~/proj")).toBe(repo);
    expect(expandHome("~/x", "/h")).toBe("/h/x");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/abs/~/x", "/h")).toBe("/abs/~/x");
  });

  test("a nested repo wins over the repo around it", () => {
    const parent = tempDir("monad-repos-");
    const outer = makeRepo(parent, "outer");
    const inner = makeRepo(outer, "vendor-inner");
    const resolver = new RepoResolver();
    expect(resolver.resolve(join(inner, "src", "a.ts"))).toBe(inner);
    expect(resolver.resolve(join(outer, "src", "a.ts"))).toBe(outer);
  });

  test("a linked worktree folds into its main repository", () => {
    const parent = tempDir("monad-repos-");
    const main = makeRepo(parent, "main-repo");
    const worktrees = tempDir("monad-worktrees-");
    const worktree = join(worktrees, "review-1");
    git(main, "worktree", "add", "-q", "--detach", worktree, "HEAD");
    const resolver = new RepoResolver();
    expect(resolver.resolve(join(worktree, "src", "a.ts"))).toBe(main);
  });

  test("a .git file with no commondir (a submodule checkout) keeps its own toplevel", () => {
    const parent = tempDir("monad-repos-");
    const modules = join(parent, "super", ".git", "modules", "sub");
    mkdirSync(modules, { recursive: true });
    const sub = join(parent, "super", "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    const resolver = new RepoResolver();
    expect(resolver.resolve(join(sub, "file.c"))).toBe(sub);
  });

  test("answers are cached per directory: no stat walk the second time", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const resolver = new RepoResolver();
    expect(resolver.resolve(join(repo, "src", "a.ts"))).toBe(repo);
    // Hide the .git directory: a resolver that walked again would now answer
    // nothing; the cached answer stands.
    renameSync(join(repo, ".git"), join(repo, "git-hidden"));
    expect(resolver.resolve(join(repo, "src", "a.ts"))).toBe(repo);
    expect(new RepoResolver().resolve(join(repo, "src", "a.ts"))).toBeUndefined();
  });

  test("the cache is bounded", () => {
    const parent = tempDir("monad-repos-");
    const repo = makeRepo(parent, "alpha");
    const resolver = new RepoResolver({ maxEntries: 2 });
    for (let i = 0; i < 10; i += 1) {
      mkdirSync(join(repo, `d${i}`));
      expect(resolver.resolve(join(repo, `d${i}`))).toBe(repo);
    }
    const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});

describe("path extraction", () => {
  test("commandPaths: absolute and ~ tokens, cd / pushd / git -C targets, --flag=/path", () => {
    expect(
      commandPaths(
        'cd ~/Developer/github/meshyy && git -C ../monad status; cat "/etc/hosts" | grep x --file=/tmp/f',
      ),
    ).toEqual(["~/Developer/github/meshyy", "../monad", "/etc/hosts", "/tmp/f"]);
    expect(commandPaths("pushd sub && ls -la")).toEqual(["sub"]);
    expect(commandPaths("echo hello world")).toEqual([]);
    expect(commandPaths("cd -")).toEqual([]);
  });

  test("toolCallPaths reads only vendor-set structured fields", () => {
    expect(
      toolCallPaths({
        sessionUpdate: "tool_call",
        title: "/title/is/not/a/path",
        locations: [{ path: "/a/one.ts", line: 3 }, { line: 4 }],
        content: [
          { type: "diff", path: "/a/two.ts", oldText: null, newText: "x" },
          { type: "content", content: { type: "text", text: "/output/is/ignored" } },
        ],
        rawInput: {
          file_path: "/a/three.ts",
          path: "rel/dir",
          notebook_path: "/a/nb.ipynb",
          cwd: "/a",
          paths: ["/b/x", 7],
          command: "ls /c",
        },
      }),
    ).toEqual(["/a/one.ts", "/a/two.ts", "/a/three.ts", "rel/dir", "/a/nb.ipynb", "/a", "/b/x", "/c"]);
  });
});
