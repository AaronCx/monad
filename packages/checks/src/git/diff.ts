import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAddedLines } from "../diff/parse";
import type { ChangedFile, CommitInfo } from "../types";

// node child_process (works under both node and bun): a published CLI may run
// under node, where Bun.spawn does not exist.
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim()}`));
      else resolve(stdout);
    });
  });
}

async function tryRunGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await runGit(args, cwd);
  } catch {
    return undefined;
  }
}

function parseNameStatus(output: string): { status: string; path: string }[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...pathParts] = line.split("\t");
      return { status: status.trim(), path: pathParts.join("\t").trim() };
    });
}

function statusFromCode(code: string): ChangedFile["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

export function splitPatchByFile(diffOutput: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = diffOutput.split(/^diff --git /m).filter((c) => c.length > 0);
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/m);
    if (headerMatch) {
      const filePath = headerMatch[2];
      map.set(filePath, `diff --git ${chunk}`);
    }
  }
  return map;
}

/**
 * Build the ChangedFile list for a given diff. `readContent` resolves the real
 * post-change file content for a path.
 */
async function buildChangedFiles(
  nameStatusEntries: { status: string; path: string }[],
  patches: Map<string, string>,
  readContent: (path: string) => Promise<string>,
): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const entry of nameStatusEntries) {
    const status = statusFromCode(entry.status);
    const patch = patches.get(entry.path) ?? "";
    const content = status === "removed" ? "" : await readContent(entry.path);
    const addedLines = patch ? parseAddedLines(patch) : undefined;
    out.push({
      path: entry.path,
      status,
      content,
      patch,
      addedLines,
    });
  }
  return out;
}

export async function getStagedDiff(cwd: string): Promise<ChangedFile[]> {
  const [nameStatusOutput, diffOutput] = await Promise.all([
    runGit(["diff", "--cached", "--name-status"], cwd),
    runGit(["diff", "--cached"], cwd),
  ]);

  const entries = parseNameStatus(nameStatusOutput);
  if (entries.length === 0) return [];

  const patches = splitPatchByFile(diffOutput);
  return buildChangedFiles(entries, patches, async (path) => {
    // For staged content, prefer the staged blob (`git show :path`). Falls back to the
    // working-tree file if the blob isn't readable (rare — e.g., partial stage on a new file).
    const staged = await tryRunGit(["show", `:${path}`], cwd);
    if (staged !== undefined) return staged;
    try {
      return await readFile(join(cwd, path), "utf8");
    } catch {
      return "";
    }
  });
}

/**
 * Changed files between two commits. The caller computes the merge base when
 * base-branch semantics are wanted; this function diffs exactly baseSha..headSha.
 * Post-change content comes from the head commit's blobs, so the result is
 * independent of the working tree.
 */
export async function diffBetween(
  baseSha: string,
  headSha: string,
  cwd: string,
): Promise<ChangedFile[]> {
  const [nameStatusOutput, diffOutput] = await Promise.all([
    runGit(["diff", "--name-status", baseSha, headSha], cwd),
    runGit(["diff", baseSha, headSha], cwd),
  ]);

  const entries = parseNameStatus(nameStatusOutput);
  if (entries.length === 0) return [];

  const patches = splitPatchByFile(diffOutput);
  return buildChangedFiles(entries, patches, async (path) => {
    const head = await tryRunGit(["show", `${headSha}:${path}`], cwd);
    return head ?? "";
  });
}

/** Diff of HEAD against the merge base with `branch`. Thin wrapper over diffBetween. */
export async function getBranchDiff(branch: string, cwd: string): Promise<ChangedFile[]> {
  const mergeBase = (await runGit(["merge-base", branch, "HEAD"], cwd)).trim();
  return diffBetween(mergeBase, "HEAD", cwd);
}

/**
 * Commits in baseSha..headSha, oldest first. Feeds the agent_patterns check;
 * uses NUL-separated fields so commit subjects with any printable characters
 * survive parsing.
 */
export async function commitsBetween(
  baseSha: string,
  headSha: string,
  cwd: string,
): Promise<CommitInfo[]> {
  const output = await runGit(
    ["log", "--reverse", "--format=%H%x00%s%x00%an%x00%cI", `${baseSha}..${headSha}`],
    cwd,
  );
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, message, author, timestamp] = line.split("\u0000");
      return { sha: sha ?? "", message: message ?? "", author: author ?? "", timestamp: timestamp ?? "" };
    });
}

/**
 * Best-effort default branch for "diff against the repo's default branch"
 * flows (interactive run_checks with no explicit base/head). Prefers the
 * origin HEAD symref, then local main, then master. Returns undefined when
 * none resolves (fresh repo with no commits, detached oddities); callers
 * treat that as an empty diff.
 */
export async function detectDefaultBranch(cwd: string): Promise<string | undefined> {
  const originHead = await tryRunGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (originHead !== undefined && originHead.trim().length > 0) {
    return originHead.trim();
  }
  for (const candidate of ["main", "master"]) {
    const sha = await tryRunGit(["rev-parse", "--verify", "--quiet", candidate], cwd);
    if (sha !== undefined && sha.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}
