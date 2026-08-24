import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Tiny unified glob matcher. Supports:
 *   *   — any sequence of non-slash chars
 *   **  — any sequence including slashes
 *   ?   — a single non-slash char
 *   /   — literal path separator (anchored if at pattern end)
 *
 * `**` collapses optional path segments so `**\/fixtures/**` (rendered without
 * the escape: ** /fixtures/**) matches both `fixtures/seeds.json` and `a/b/fixtures/c.ts`.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === ".") {
      regex += "\\.";
      i++;
    } else if (ch === "/" && i === pattern.length - 1) {
      regex += "/.*";
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

function matchesPath(filepath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    return filepath.startsWith(pattern) || filepath === pattern.slice(0, -1);
  }
  if (!pattern.includes("/")) {
    const basename = filepath.split("/").pop() ?? filepath;
    if (globToRegex(pattern).test(basename)) return true;
  }
  return globToRegex(pattern).test(filepath);
}

/** True iff any glob matches the path. Empty/missing globs → false. */
export function isPathAllowed(filepath: string, allowGlobs: string[] | undefined): boolean {
  if (!allowGlobs || allowGlobs.length === 0) return false;
  return allowGlobs.some((g) => matchesPath(filepath, g));
}

// Both marker spellings are honored: monad-ignore is the native one, and
// lastgate-ignore keeps ported repos' existing suppressions working.
const INLINE_IGNORE = /(?:\/\/|#|--)\s*(?:monad|lastgate)-ignore(?!-next-line)/;
const NEXT_LINE_IGNORE = /(?:\/\/|#|--)\s*(?:monad|lastgate)-ignore-next-line/;

/**
 * Honor inline opt-outs:
 *   - `// lastgate-ignore` / `# lastgate-ignore` on the same line → ignore that line
 *   - `// lastgate-ignore-next-line` on the previous line → ignore the following line
 *
 * `contentLines` is the post-change file content split by \n. Pass [] if unavailable —
 * inline ignores then resolve only against the immediate same-line text (less useful).
 */
export function isLineIgnored(lineNo: number, contentLines: string[], sameLineText?: string): boolean {
  const sameLine = contentLines[lineNo - 1] ?? sameLineText ?? "";
  if (INLINE_IGNORE.test(sameLine)) return true;
  const prevLine = contentLines[lineNo - 2] ?? "";
  if (NEXT_LINE_IGNORE.test(prevLine)) return true;
  return false;
}

export interface FingerprintInput {
  check: string;
  file: string;
  rule: string;
  redactedMatch?: string;
}

/** Stable hash for a finding. NEVER feeds the raw secret in — uses the already-redacted match. */
export function fingerprint(input: FingerprintInput): string {
  const h = createHash("sha256");
  h.update(`${input.check}|${input.file}|${input.rule}|${input.redactedMatch ?? ""}`);
  return h.digest("hex").slice(0, 16);
}

export interface BaselineFile {
  version: 1;
  fingerprints: string[];
}

export const DEFAULT_BASELINE_PATH = ".monad-baseline.json";
export const LEGACY_BASELINE_PATH = ".lastgate-baseline.json";

function resolvePath(path: string, cwd?: string): string {
  if (!cwd || isAbsolute(path)) return path;
  return join(cwd, path);
}

async function readBaselineFile(path: string): Promise<Set<string> | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.fingerprints ?? []);
  } catch {
    return undefined;
  }
}

/**
 * Load a baseline file's fingerprints into a Set. Missing file resolves to an
 * empty Set. When asked for the default path, a legacy .lastgate-baseline.json
 * is honored as a fallback with a rename notice on stderr.
 */
export async function loadBaseline(path: string, cwd?: string): Promise<Set<string>> {
  const primary = await readBaselineFile(resolvePath(path, cwd));
  if (primary) return primary;
  if (path === DEFAULT_BASELINE_PATH) {
    const legacy = await readBaselineFile(resolvePath(LEGACY_BASELINE_PATH, cwd));
    if (legacy) {
      console.error(
        `reading ${LEGACY_BASELINE_PATH}; rename it to ${DEFAULT_BASELINE_PATH}`,
      );
      return legacy;
    }
  }
  return new Set();
}

/** Write a baseline file. */
export async function writeBaseline(path: string, fingerprints: string[]): Promise<void> {
  const data: BaselineFile = { version: 1, fingerprints: [...fingerprints].sort() };
  await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
