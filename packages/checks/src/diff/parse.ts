export interface AddedLine {
  lineNo: number;
  text: string;
}

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * Parse a unified-diff patch and return every line that was *added* (`+` prefix
 * inside a hunk body), tagged with its real new-file line number.
 *
 * Skips:
 *   - File-metadata lines (`diff --git`, `index ...`, `+++ b/...`, `--- a/...`).
 *   - Context lines (` ` prefix). They advance the new-file line counter but are not emitted.
 *   - Removed lines (`-` prefix). They neither advance the counter nor emit.
 *   - The `\ No newline at end of file` sentinel.
 *
 * Reads each hunk's `@@ -a,b +c,d @@` header to set the starting new-file line.
 */
export function parseAddedLines(patch: string): AddedLine[] {
  if (!patch) return [];
  const out: AddedLine[] = [];
  const lines = patch.split("\n");

  let inHunk = false;
  let newLineNo = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER_RE.exec(line);
      if (m) {
        newLineNo = Number(m[1]);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }

    // A new file's `diff --git` header always terminates the previous file's
    // hunk body (git-generated diffs — the only kind LastGate consumes — always
    // emit it). The subsequent `index`/`--- a/`/`+++ b/` metadata then arrives
    // while we are NOT in a hunk and is skipped below.
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }

    // Between hunks/files: skip everything (file headers, mode lines, the
    // `index`/`--- `/`+++ ` metadata). CRITICAL: only do this when NOT inside a
    // hunk body. Real `+++ `/`--- ` file metadata never appears inside a hunk,
    // so once inHunk we must classify by the content prefix below — otherwise an
    // added line whose content begins with `++ ` (raw `+++ ...`) would be
    // mistaken for metadata and silently truncate the rest of the hunk from the
    // scanners (a craftable detection bypass).
    if (!inHunk) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" sentinel — neither advances counter nor emits.
      continue;
    }

    const prefix = line[0];
    if (prefix === "+") {
      out.push({ lineNo: newLineNo, text: line.slice(1) });
      newLineNo++;
    } else if (prefix === "-") {
      // removed; do not advance new-file counter
    } else if (prefix === " " || line === "") {
      // context line (note: a fully-empty line in a hunk body represents a blank line — still advances)
      newLineNo++;
    } else {
      // Unknown prefix — leave hunk state defensively. The next @@ resumes parsing.
      inHunk = false;
    }
  }

  return out;
}
