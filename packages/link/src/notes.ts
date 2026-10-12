import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "@aaroncx/checks";
import { type LinkActor, type RepoNote, RepoNoteSchema } from "@aaroncx/protocol";

/**
 * Repo notes (monad Link phase 3, decision record 0012): the Memory
 * equivalent, done the boring way. A note is a line someone chose to write
 * about a repository, by an explicit notes_append call or by the human at
 * the CLI. monad never infers one, summarizes into one, or writes one in the
 * background: memory that writes itself is memory nobody can audit.
 *
 * Storage is one JSONL file per repository under $MONAD_HOME/notes, named by
 * a hash of the canonical repository root, one JSON object per line:
 * { ts, by, repo, text }. It is NEVER inside the repository or a worktree
 * (decision record 0009): a worktree is attacker-controlled content, and a
 * note planted there would be read back by every later session as if a
 * human had written it. Files are 0600 in a 0700 directory, like the rest of
 * ~/.monad.
 *
 * Text is redacted on the way in AND on the way out: in, so the file never
 * holds a token; out, so a line written by hand (or before a pattern
 * existed) still cannot carry one into a session.
 */

/** The file holding a repository's notes: the first 16 hex of sha256(root). */
export function notesFileName(repoRoot: string): string {
  return `${createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)}.jsonl`;
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

export class NotesStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  fileFor(repoRoot: string): string {
    return join(this.dir, notesFileName(repoRoot));
  }

  /**
   * A repository's notes, oldest first, redacted. Lines that do not parse,
   * or that name a different repository (a hash prefix collision, or a file
   * copied by hand), are skipped rather than shown under the wrong repo.
   */
  read(repoRoot: string): RepoNote[] {
    let raw: string;
    try {
      raw = readFileSync(this.fileFor(repoRoot), "utf8");
    } catch {
      return [];
    }
    const notes: RepoNote[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = RepoNoteSchema.safeParse(value);
      if (!parsed.success || parsed.data.repo !== repoRoot) {
        continue;
      }
      notes.push({ ...parsed.data, text: redact(parsed.data.text) });
    }
    return notes;
  }

  /** Appends one note and returns it as stored (redacted). */
  append(repoRoot: string, by: LinkActor, text: string, now: Date = new Date()): RepoNote {
    const note: RepoNote = { ts: now.toISOString(), by, repo: repoRoot, text: redact(text.trim()) };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const file = this.fileFor(repoRoot);
    appendFileSync(file, `${JSON.stringify(note)}\n`, { mode: 0o600 });
    // appendFileSync's mode only applies when it creates the file; a file
    // that already existed with looser bits is tightened here.
    chmodSync(file, 0o600);
    return note;
  }
}
