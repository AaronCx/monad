import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { EventRecord } from "@aaroncx/protocol";

/**
 * Repos touched (monad Link, decision record 0012). A session is filed under
 * every git repository its tool calls actually reached, not under the
 * directory it was launched from: the sessions that motivated Link ran with
 * cwd `~` and did all their work in ~/Developer/github/<repo>, so a cwd-only
 * project guess filed them under nothing (or under the wrong thing). The cwd's
 * own repo is recorded too, but only because it IS a repo; a cwd that is not
 * inside one records nothing.
 *
 * This runs inside SessionStore.append, so it must stay cheap: no subprocess
 * (never `git rev-parse` per event), only stat calls, and every directory it
 * walks is cached.
 */

/** Expands a leading `~` or `~/` against the given home directory. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }
  return path;
}

export interface RepoResolverOptions {
  /** Home directory for `~` expansion. Injectable for tests. */
  home?: string;
  /** Directory cache bound (least recently used entries are evicted). */
  maxEntries?: number;
}

function statKind(path: string): "dir" | "file" | undefined {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The repository a `.git` FILE belongs to. A linked worktree's `.git` is a
 * file pointing at `<main>/.git/worktrees/<name>`, whose `commondir` names the
 * main `.git`; folding the worktree into the main repository's root means
 * monad's own review and fix worktrees (and a human's `git worktree add`) are
 * tagged with the repo they are a checkout of, not with a throwaway path.
 * Submodules (`.git` file, no commondir) and worktrees of a bare repository
 * (commondir not named `.git`) keep their own toplevel. Unreadable metadata
 * also keeps the toplevel: a wrong fold would be worse than none.
 */
function rootForGitFile(toplevel: string, gitFile: string): string {
  try {
    const match = readFileSync(gitFile, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match?.[1]) {
      return toplevel;
    }
    const gitdir = resolve(toplevel, match[1]);
    let commondir: string;
    try {
      commondir = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    } catch {
      return toplevel;
    }
    if (basename(commondir) === ".git" && statKind(commondir) === "dir") {
      return dirname(commondir);
    }
    return toplevel;
  } catch {
    return toplevel;
  }
}

/**
 * Maps a path to the root of the git repository containing it. Walks up from
 * the path (or its nearest existing ancestor, since an agent may name a file
 * it is about to create) to the first directory holding `.git`. `/` and the
 * home directory get no special case either way: they are a repo exactly when
 * they contain `.git`, like any other directory.
 *
 * Every directory visited is cached against its answer, positive or negative,
 * so a busy session pays for a few stat calls the first time it touches a
 * directory and a map lookup after that. A directory that becomes a repo
 * after it was cached as "not a repo" is missed until it is evicted; that is
 * the price of never shelling out on the append path, and it only affects a
 * directory that was touched BEFORE its own `git init` (a fresh directory
 * created by the init is not in the cache yet).
 */
export class RepoResolver {
  private readonly home: string;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, string | null>();

  constructor(options: RepoResolverOptions = {}) {
    this.home = options.home ?? homedir();
    this.maxEntries = options.maxEntries ?? 4096;
  }

  /**
   * The canonical (realpath) repository root for `path`, or undefined when
   * the path is in no repository. A relative path resolves against `cwd`;
   * with no cwd it resolves to nothing.
   */
  resolve(path: string, cwd?: string): string | undefined {
    let absolute = expandHome(path.trim(), this.home);
    if (absolute.length === 0) {
      return undefined;
    }
    if (!isAbsolute(absolute)) {
      if (cwd === undefined) {
        return undefined;
      }
      absolute = resolve(expandHome(cwd, this.home), absolute);
    }
    absolute = resolve(absolute);

    let start = absolute;
    let kind = statKind(start);
    while (kind === undefined) {
      const parent = dirname(start);
      if (parent === start) {
        return undefined;
      }
      start = parent;
      kind = statKind(start);
    }
    if (kind === "file") {
      start = dirname(start);
    }
    return this.rootOfDir(start) ?? undefined;
  }

  private rootOfDir(start: string): string | null {
    const visited: string[] = [];
    let dir = start;
    let found: string | null = null;
    for (;;) {
      const cached = this.lookup(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(dir);
      const gitPath = join(dir, ".git");
      const gitKind = statKind(gitPath);
      if (gitKind === "dir") {
        found = canonical(dir);
        break;
      }
      if (gitKind === "file") {
        found = canonical(rootForGitFile(dir, gitPath));
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    for (const seen of visited) {
      this.store(seen, found);
    }
    return found;
  }

  private lookup(dir: string): string | null | undefined {
    if (!this.cache.has(dir)) {
      return undefined;
    }
    const value = this.cache.get(dir) ?? null;
    // Refresh recency: Map iteration order is insertion order.
    this.cache.delete(dir);
    this.cache.set(dir, value);
    return value;
  }

  private store(dir: string, root: string | null): void {
    this.cache.set(dir, root);
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}

/** Longest command prefix scanned for path tokens. */
const MAX_COMMAND_SCAN = 8192;

/** Flags whose next token is a directory the command operates in. */
const DIRECTORY_FLAGS = new Set(["cd", "pushd", "-C", "--git-dir", "--work-tree"]);

function stripQuotes(token: string): string {
  return token.replace(/^["']+|["']+$/g, "");
}

/**
 * Path-like tokens in a shell command: absolute and `~/` paths anywhere
 * (including `--flag=/path`), plus the directory argument of `cd`, `pushd`
 * and `git -C`, which may be relative to the session cwd. Everything else in
 * the command (relative file arguments, words, urls) is ignored: a relative
 * argument means the session cwd, which is recorded on its own merit.
 */
export function commandPaths(command: string): string[] {
  const tokens = command
    .slice(0, MAX_COMMAND_SCAN)
    .split(/[\s;&|()<>`]+/)
    .map(stripQuotes)
    .filter((token) => token.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const next = tokens[i + 1];
    if (DIRECTORY_FLAGS.has(token) && next !== undefined && !next.startsWith("-")) {
      paths.push(next);
      i += 1;
      continue;
    }
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (value.startsWith("/") || value.startsWith("~/") || value === "~") {
      paths.push(value);
    }
  }
  return paths;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pushString(out: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    out.push(value);
  }
}

/** rawInput keys that name a file or directory directly. */
const RAW_INPUT_PATH_KEYS = ["file_path", "path", "notebook_path", "cwd"] as const;

/**
 * The paths an ACP tool_call or tool_call_update update carries, as written
 * (unexpanded, possibly relative). Sources, all vendor-set structured fields:
 * `locations[].path`, `content[]` diff items' `path`, and `rawInput`'s
 * file_path / path / notebook_path / cwd / paths[] plus the path tokens of
 * rawInput.command. Tool OUTPUT is never read for paths.
 */
export function toolCallPaths(update: Record<string, unknown>): string[] {
  const out: string[] = [];
  const locations = update.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      pushString(out, asRecord(location)?.path);
    }
  }
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const record = asRecord(item);
      if (record?.type === "diff") {
        pushString(out, record.path);
      }
    }
  }
  const rawInput = asRecord(update.rawInput);
  if (rawInput) {
    for (const key of RAW_INPUT_PATH_KEYS) {
      pushString(out, rawInput[key]);
    }
    if (Array.isArray(rawInput.paths)) {
      for (const path of rawInput.paths) {
        pushString(out, path);
      }
    }
    if (typeof rawInput.command === "string") {
      out.push(...commandPaths(rawInput.command));
    }
  }
  return out;
}

/** The ACP update object inside an `update` event payload, if it is a tool call. */
export function toolCallUpdate(event: EventRecord): Record<string, unknown> | undefined {
  if (event.kind !== "update") {
    return undefined;
  }
  const update = asRecord(asRecord(event.payload)?.update);
  const kind = update?.sessionUpdate;
  return kind === "tool_call" || kind === "tool_call_update" ? update : undefined;
}

/**
 * Every path an event contributes to repo tagging, as written. A
 * session_created event contributes the session cwd; tool calls contribute
 * their structured paths; nothing else contributes anything (prompts and
 * agent prose mention paths without touching them).
 */
export function eventPaths(event: EventRecord, cwd: string): string[] {
  if (event.kind === "session_created") {
    return [cwd];
  }
  const update = toolCallUpdate(event);
  return update ? toolCallPaths(update) : [];
}
