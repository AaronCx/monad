import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { deriveTitle, expandHome, type ImportedEventInput, type ImportState, type SessionStore } from "@aaroncx/engine";
import type { ImportSkip, ImportSummary, SessionId, SessionRecord } from "@aaroncx/protocol";
import type { LinkConfig } from "../config.ts";
import { parseClaudeCodeLine } from "./claude-code.ts";
import { parseCodexLine } from "./codex.ts";
import { asRecord, type ImportVendor, type LineContext, type ParsedLine, str, subagentSessionId } from "./common.ts";

/**
 * The importer (monad Link phase 4, decision record 0012): reads Aaron's own
 * local Claude Code and Codex logs, in place and read-only, into monad
 * sessions that can be searched, read and listed like any other, and are
 * never attached, prompted or messaged.
 *
 * Incremental and idempotent. Each file's progress is a row in the store's
 * imports table (byte offset, line count, size, mtime, inode, and a hash of
 * the consumed prefix), written in the SAME transaction as the events read
 * up to that offset, so a crash mid-file loses or repeats nothing. A run
 * reads only what was appended since the last one, only whole lines (a
 * partial trailing line, a vendor mid-write, is left for next time), and a
 * second run with nothing new appends nothing. A file that shrank below its
 * offset, or whose already-read prefix changed, was truncated or replaced:
 * its session's imported events, index rows and repo tags are dropped and
 * it is read again from the start.
 *
 * Nothing here indexes anything. Events go through SessionStore, so the
 * Phase 1 indexer, redaction, repo tagging and titles apply exactly as they
 * do to a live session.
 */

/** Events per store transaction while importing (and between yields to the event loop). */
const IMPORT_BATCH = 1000;

/** Bytes read from a file per read call. */
const READ_CHUNK = 8 * 1024 * 1024;

/** How much of a file's already-read prefix is hashed to recognize a replaced file. */
const HEAD_BYTES = 4096;

/** Directories deeper than this under a root are not walked. */
const MAX_DEPTH = 12;

/** Skipped files listed in a summary (the count covers all of them). */
const MAX_LISTED_SKIPS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** One vendor log file the walk recognized. */
export interface ImportCandidate {
  path: string;
  vendor: ImportVendor;
  /** main: a Claude Code session; subagent: one of its subagents; rollout: a Codex session. */
  kind: "main" | "subagent" | "rollout";
  /** Claude Code main: the file stem. Codex: the id in the file name (session_meta wins). */
  idHint?: string;
  /** Subagent: the parent session's id and the file's path under its subagents directory. */
  parentId?: string;
  relativePath?: string;
}

/**
 * Recognizes a vendor session log by its path, or returns undefined. Claude
 * Code keeps `<sessionId>.jsonl` per session and each subagent's transcript
 * as `agent-*.jsonl` somewhere under `<sessionId>/subagents/` (workflow
 * agents one level deeper); other JSONL there (workflow journals) are not
 * transcripts. Codex keeps `rollout-<time>-<sessionId>.jsonl`.
 */
export function classifyLog(path: string): ImportCandidate | undefined {
  const name = basename(path);
  if (!name.endsWith(".jsonl")) {
    return undefined;
  }
  if (name.startsWith("rollout-")) {
    const idHint = name.match(UUID_SUFFIX)?.[1]?.toLowerCase();
    return { path, vendor: "codex", kind: "rollout", ...(idHint ? { idHint } : {}) };
  }
  const stem = name.slice(0, -".jsonl".length);
  if (UUID.test(stem)) {
    return { path, vendor: "claude-code", kind: "main", idHint: stem.toLowerCase() };
  }
  if (name.startsWith("agent-")) {
    const parts = path.split(sep);
    const at = parts.lastIndexOf("subagents");
    const parentId = at > 0 ? parts[at - 1] : undefined;
    if (parentId !== undefined && UUID.test(parentId)) {
      return {
        path,
        vendor: "claude-code",
        kind: "subagent",
        parentId: parentId.toLowerCase(),
        relativePath: parts.slice(at + 1).join("/"),
      };
    }
  }
  return undefined;
}

/** Every recognized log under a root (a directory, or a single file). Symlinks are not followed. */
export function findLogs(root: string): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  let kind: "dir" | "file" | undefined;
  try {
    const stat = lstatSync(root);
    kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
  } catch {
    return out;
  }
  if (kind === "file") {
    const candidate = classifyLog(root);
    return candidate ? [candidate] : out;
  }
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name !== "node_modules" && entry.name !== ".git") {
          walk(path, depth + 1);
        }
      } else if (entry.isFile()) {
        const candidate = classifyLog(path);
        if (candidate) {
          out.push(candidate);
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export interface ImporterOptions {
  store: SessionStore;
  /** link.json's import switches. */
  config: LinkConfig["import"];
  /** Home directory for the default roots and `~` in paths. */
  home?: string;
}

/** Thrown when link.json says import.enabled: false. */
export class ImportDisabledError extends Error {
  constructor() {
    super("importing is disabled in link.json (import.enabled is false)");
    this.name = "ImportDisabledError";
  }
}

interface RunTotals {
  filesScanned: number;
  filesUnchanged: number;
  created: Set<SessionId>;
  updated: Set<SessionId>;
  reset: Set<SessionId>;
  eventsAppended: number;
  linesMalformed: number;
  skipped: ImportSkip[];
  skippedCount: number;
}

function hashPrefix(prefix: Buffer, length: number): string {
  return createHash("sha256")
    .update(prefix.subarray(0, Math.min(length, HEAD_BYTES)))
    .digest("hex");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The subagent's own description, from the `<agent>.meta.json` Claude Code writes beside it. */
function subagentDescription(path: string): string | undefined {
  try {
    const meta = asRecord(JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")));
    return str(meta?.description);
  } catch {
    return undefined;
  }
}

export class Importer {
  private readonly store: SessionStore;
  private readonly config: LinkConfig["import"];
  private readonly home: string;
  /** Runs are serialized: a second request waits for the first, then scans again. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ImporterOptions) {
    this.store = options.store;
    this.config = options.config;
    this.home = options.home ?? homedir();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The configured roots: Claude Code's and Codex's own, then link.json import.roots. */
  roots(): string[] {
    const roots = [join(this.home, ".claude", "projects"), join(this.home, ".codex", "sessions"), ...this.config.roots];
    return [...new Set(roots.map((root) => resolvePath(expandHome(root, this.home))))];
  }

  /**
   * One import run over `paths` (files or directories), or over the
   * configured roots when none are given. Runs never overlap.
   */
  run(paths?: string[]): Promise<ImportSummary> {
    if (!this.config.enabled) {
      return Promise.reject(new ImportDisabledError());
    }
    const next = this.queue.then(() => this.runOnce(paths));
    this.queue = next.catch(() => {});
    return next;
  }

  private async runOnce(paths: string[] | undefined): Promise<ImportSummary> {
    const started = performance.now();
    const roots =
      paths === undefined || paths.length === 0
        ? this.roots()
        : [...new Set(paths.map((path) => resolvePath(expandHome(path, this.home))))];
    const totals: RunTotals = {
      filesScanned: 0,
      filesUnchanged: 0,
      created: new Set(),
      updated: new Set(),
      reset: new Set(),
      eventsAppended: 0,
      linesMalformed: 0,
      skipped: [],
      skippedCount: 0,
    };
    const seen = new Set<string>();
    const candidates: ImportCandidate[] = [];
    for (const root of roots) {
      for (const candidate of findLogs(root)) {
        if (!seen.has(candidate.path)) {
          seen.add(candidate.path);
          candidates.push(candidate);
        }
      }
    }
    // Parents before their subagents, so a child's parentId names a session
    // that exists by the time anyone lists it.
    candidates.sort((a, b) => Number(a.kind === "subagent") - Number(b.kind === "subagent"));
    const monadRan = this.store.agentSessionIds();
    for (const candidate of candidates) {
      try {
        await this.importFile(candidate, monadRan, totals);
      } catch (error) {
        this.skip(totals, candidate.path, `unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      await yieldToEventLoop();
    }
    return {
      roots,
      filesScanned: totals.filesScanned,
      filesUnchanged: totals.filesUnchanged,
      sessionsCreated: totals.created.size,
      sessionsUpdated: [...totals.updated].filter((id) => !totals.created.has(id)).length,
      sessionsReset: totals.reset.size,
      eventsAppended: totals.eventsAppended,
      linesMalformed: totals.linesMalformed,
      skipped: totals.skipped,
      skippedCount: totals.skippedCount,
      durationMs: Math.round(performance.now() - started),
    };
  }

  private skip(totals: RunTotals, path: string, reason: string): void {
    totals.skippedCount += 1;
    if (totals.skipped.length < MAX_LISTED_SKIPS) {
      totals.skipped.push({ path, reason });
    }
  }

  private async importFile(candidate: ImportCandidate, monadRan: Set<string>, totals: RunTotals): Promise<void> {
    const fd = openSync(candidate.path, "r");
    try {
      await this.importOpenFile(fd, candidate, monadRan, totals);
    } finally {
      closeSync(fd);
    }
  }

  private async importOpenFile(
    fd: number,
    candidate: ImportCandidate,
    monadRan: Set<string>,
    totals: RunTotals,
  ): Promise<void> {
    const { path } = candidate;
    const stat = fstatSync(fd);
    const size = stat.size;
    totals.filesScanned += 1;
    let state = this.store.importState(path);
    if (state && state.size === size && state.mtimeMs === stat.mtimeMs && state.ino === stat.ino) {
      totals.filesUnchanged += 1;
      return;
    }
    const prefix = Buffer.alloc(Math.min(HEAD_BYTES, size));
    if (prefix.length > 0) {
      readSync(fd, prefix, 0, prefix.length, 0);
    }

    // Which session this file is.
    let sessionId: SessionId | undefined = state?.sessionId;
    if (sessionId === undefined) {
      if (candidate.kind === "main") {
        sessionId = candidate.idHint;
      } else if (candidate.kind === "subagent" && candidate.parentId && candidate.relativePath) {
        sessionId = subagentSessionId(candidate.parentId, candidate.relativePath);
      } else {
        sessionId = codexSessionId(fd, size) ?? candidate.idHint;
      }
    }
    if (sessionId === undefined) {
      this.skip(totals, path, "no session id (the file has no session_meta line yet)");
      return;
    }
    // A session monad ran is filed under monad's own log; the vendor's copy
    // of it (and its subagents) would be the same work twice. Measured for
    // Claude Code (claude-agent-acp's session id is its log's file stem);
    // applied to Codex too, where codex-acp's id is unmeasured (record 0012)
    // but a match can only mean the same session.
    if (monadRan.has(sessionId) || (candidate.parentId !== undefined && monadRan.has(candidate.parentId))) {
      this.skip(totals, path, "monad ran this session; its own log is the canonical one");
      return;
    }
    const existing = this.store.get(sessionId);
    if (existing && existing.status !== "imported") {
      this.skip(totals, path, `session id ${sessionId} belongs to a session monad ran`);
      return;
    }

    if (!state) {
      // A file never read before whose session another file already holds:
      // the same log in two places (a copy, or a backup next to the
      // original). One source owns a session. A copy takes over only when
      // the owner is gone and the copy starts with exactly what was read
      // from it, and then it continues from where the owner left off.
      const owner = this.store.importStateForSession(sessionId);
      if (owner) {
        if (existsSync(owner.sourcePath)) {
          this.skip(totals, path, `already imported from ${owner.sourcePath}`);
          return;
        }
        if (size >= owner.offset && hashPrefix(prefix, owner.offset) === owner.head) {
          state = { ...owner, sourcePath: path };
          this.store.moveImportState(owner.sourcePath, state);
        } else {
          this.skip(
            totals,
            path,
            `already imported from ${owner.sourcePath} (now gone), and this file differs from it`,
          );
          return;
        }
      } else if (existing) {
        // Imported events with no import state (a reset interrupted between
        // its two steps): start the session over rather than append twice.
        this.store.resetImported(sessionId);
        totals.reset.add(sessionId);
      }
    } else if (size < state.offset || hashPrefix(prefix, state.offset) !== state.head) {
      // Truncated, or replaced: what was read is no longer what the file says.
      this.store.resetImported(sessionId);
      totals.reset.add(sessionId);
      state = undefined;
    }

    const file = { size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    await this.readFrom(fd, candidate, sessionId, state, file, prefix, totals);
  }

  /** Reads whole lines from the state's offset (or 0) to the end of the file, appending in batches. */
  private async readFrom(
    fd: number,
    candidate: ImportCandidate,
    sessionId: SessionId,
    state: ImportState | undefined,
    file: { size: number; mtimeMs: number; ino: number },
    prefix: Buffer,
    totals: RunTotals,
  ): Promise<void> {
    const parse = candidate.vendor === "codex" ? parseCodexLine : parseClaudeCodeLine;
    let record = this.store.get(sessionId);
    let titled = record?.titleSource === "import" || record?.titleSource === "manual";
    // A subagent is named by the description its parent gave it (redacted
    // and cut like any derived title), which says more than its prompt's
    // first line.
    const description = candidate.kind === "subagent" && !record ? subagentDescription(candidate.path) : undefined;
    const subagentTitle =
      description === undefined ? undefined : deriveTitle({ prompt: [{ type: "text", text: description }] });
    // A session's log starts with session_created, as a live one does (it
    // tags the cwd's repository when the cwd is in one). A reset removed it,
    // so it is written again before the first event read back.
    let announce = !record || this.store.lastEventOfKind(sessionId, "session_created") === undefined;
    let pendingTitle: string | undefined;
    let firstCwd: string | undefined = record?.cwd;
    let firstTs: string | undefined = record?.createdAt;
    const ctx: LineContext = {
      sessionId,
      vendor: candidate.vendor,
      source: candidate.path,
      line: state?.line ?? 0,
      sessionCwd: record?.cwd,
      subagent: candidate.kind === "subagent",
      lastTs: record?.updatedAt ?? new Date(file.mtimeMs).toISOString(),
    };
    let offset = state?.offset ?? 0;
    let lineCount = state?.line ?? 0;
    let batch: ImportedEventInput[] = [];

    const flush = () => {
      const save: ImportState = {
        sourcePath: candidate.path,
        sessionId,
        vendor: candidate.vendor,
        offset,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ino: file.ino,
        line: lineCount,
        head: hashPrefix(prefix, offset),
      };
      let create: SessionRecord | undefined;
      if (!record && batch.length > 0) {
        const createdAt = firstTs ?? ctx.lastTs;
        create = {
          id: sessionId,
          cwd: firstCwd ?? this.home,
          backend: candidate.vendor === "codex" ? "import:codex" : "import:claude-code",
          // An imported session is trusted (these are Aaron's own logs) but
          // that only decides who may READ it: it is terminal, and the
          // manager refuses anything that would drive it.
          mode: "interactive",
          status: "imported",
          trust: "trusted",
          ...(subagentTitle ? { title: subagentTitle, titleSource: "import" as const } : {}),
          ...(candidate.kind === "subagent" && candidate.parentId
            ? { parentId: candidate.parentId, spawnDepth: 1 }
            : {}),
          createdAt,
          updatedAt: createdAt,
        };
        if (subagentTitle) {
          titled = true;
          pendingTitle = undefined;
        }
      }
      const current = create ?? record;
      if (announce && current && batch.length > 0) {
        batch.unshift({ kind: "session_created", payload: current, ts: current.createdAt });
        announce = false;
      }
      const appended = this.store.appendImported({
        sessionId,
        ...(create ? { create } : {}),
        ...(pendingTitle !== undefined && (record || create) ? { title: pendingTitle } : {}),
        events: batch,
        state: save,
      });
      if (pendingTitle !== undefined && (record || create)) {
        titled = true;
        pendingTitle = undefined;
      }
      if (create) {
        totals.created.add(sessionId);
        record = this.store.get(sessionId);
      }
      if (appended.length > 0) {
        totals.updated.add(sessionId);
        totals.eventsAppended += appended.length;
      }
      batch = [];
    };

    const consume = (bytes: Buffer, end: number) => {
      lineCount += 1;
      ctx.line = lineCount;
      offset = end;
      const text = bytes.toString("utf8").trim();
      if (text.length === 0) {
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        totals.linesMalformed += 1;
        return;
      }
      const parsed: ParsedLine = parse(raw, ctx);
      if (parsed.ts !== undefined) {
        ctx.lastTs = parsed.ts;
        firstTs ??= parsed.meta?.startedAt ?? parsed.ts;
      }
      if (parsed.cwd !== undefined && firstCwd === undefined) {
        firstCwd = parsed.cwd;
        ctx.sessionCwd = parsed.cwd;
      }
      if (parsed.ask !== undefined && !titled && pendingTitle === undefined) {
        pendingTitle = deriveTitle({ prompt: [{ type: "text", text: parsed.ask }] });
      }
      for (const event of parsed.events) {
        batch.push(event);
      }
    };

    // Whole lines only: bytes after the last newline are a line the vendor
    // is still writing, and stay unread until a later run.
    let position = offset;
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(Math.min(READ_CHUNK, Math.max(1, file.size - offset)));
    while (position < file.size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, file.size - position), position);
      if (read <= 0) {
        break;
      }
      // Copied out of `chunk`, which the next read overwrites.
      const data =
        carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : Buffer.from(chunk.subarray(0, read));
      const dataStart = position - carry.length;
      position += read;
      let start = 0;
      for (let newline = data.indexOf(10, start); newline !== -1; newline = data.indexOf(10, start)) {
        consume(data.subarray(start, newline), dataStart + newline + 1);
        start = newline + 1;
        if (batch.length >= IMPORT_BATCH) {
          flush();
          await yieldToEventLoop();
        }
      }
      carry = Buffer.from(data.subarray(start));
    }
    // Saved even when no whole line was added (the file only grew by part of
    // a line): the new size and mtime let the next run skip it with one stat
    // until the vendor writes again.
    const moved =
      state === undefined ||
      offset !== state.offset ||
      state.size !== file.size ||
      state.mtimeMs !== file.mtimeMs ||
      state.ino !== file.ino;
    if (batch.length > 0 || moved) {
      flush();
    }
  }
}

/** A Codex session's id from its session_meta line (the first line). */
function codexSessionId(fd: number, size: number): string | undefined {
  const head = Buffer.alloc(Math.min(size, 256 * 1024));
  if (head.length === 0) {
    return undefined;
  }
  readSync(fd, head, 0, head.length, 0);
  const newline = head.indexOf(10);
  if (newline === -1) {
    return undefined;
  }
  try {
    const line = asRecord(JSON.parse(head.subarray(0, newline).toString("utf8")));
    if (line?.type !== "session_meta") {
      return undefined;
    }
    const id = str(asRecord(line.payload)?.id);
    return id !== undefined && UUID.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
