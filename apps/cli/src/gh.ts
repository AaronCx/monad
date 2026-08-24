import { ReviewPrInputSchema } from "@aaroncx/protocol";
import type { ReviewPrInput } from "@aaroncx/protocol";

/**
 * gh invocation for monad review: PR metadata resolution and --post. The
 * daemon never runs gh; the CLI does, with the caller's auth and cwd.
 * MONAD_GH_BIN overrides the binary so tests can point it at a recording
 * script.
 */

export const MONAD_GH_BIN_ENV = "MONAD_GH_BIN";

export function ghBin(env: Record<string, string | undefined> = process.env): string {
  return env[MONAD_GH_BIN_ENV]?.trim() || "gh";
}

export interface GhRunOptions {
  cwd?: string;
  stdin?: string;
  /** Overrides the child environment; omitted means inherit this process's. */
  env?: Record<string, string | undefined>;
}

/** Runs gh once; throws with stderr on a non-zero exit. */
export async function runGh(bin: string, args: string[], options: GhRunOptions = {}): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** monad review <pr>: a bare number in the current repo, or a full PR URL. */
export function parsePrArg(arg: string): { number: number; repo?: string } {
  const urlMatch = arg.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (urlMatch?.[1] && urlMatch[2]) {
    return { number: Number(urlMatch[2]), repo: urlMatch[1] };
  }
  const number = Number(arg);
  if (Number.isInteger(number) && number > 0) {
    return { number };
  }
  throw new Error(`cannot parse ${arg} as a PR number or GitHub PR URL`);
}

/** The brief's exact gh pr view field list. */
export const PR_VIEW_FIELDS =
  "number,title,body,url,author,headRefName,headRefOid,baseRefName,baseRefOid,files,isDraft";

interface PrViewJson {
  number: number;
  title: string;
  body?: string;
  url: string;
  headRefOid: string;
  baseRefName: string;
  isDraft?: boolean;
}

/**
 * Resolves PR metadata via gh pr view --json in the caller's repo. The
 * owner/name repo comes from the returned canonical URL, so a bare number
 * works from any checkout with a GitHub origin.
 */
export async function fetchPrMetadata(
  bin: string,
  prArg: string,
  cwd: string,
): Promise<ReviewPrInput> {
  const { number, repo } = parsePrArg(prArg);
  const args = ["pr", "view", String(number), "--json", PR_VIEW_FIELDS];
  if (repo) {
    args.push("--repo", repo);
  }
  const raw = JSON.parse(await runGh(bin, args, { cwd })) as PrViewJson;
  const urlRepo = raw.url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
  return ReviewPrInputSchema.parse({
    repo: repo ?? urlRepo ?? "",
    number: raw.number,
    url: raw.url,
    title: raw.title,
    body: raw.body,
    headSha: raw.headRefOid,
    baseRef: raw.baseRefName,
    isDraft: raw.isDraft,
  });
}
