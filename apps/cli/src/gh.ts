import { ReviewPrInputSchema } from "@aaroncx/protocol";
import type { ReviewPrInput, TrustLevel } from "@aaroncx/protocol";

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

/**
 * The brief's gh pr view field list, plus the two fields the trust decision
 * needs: isCrossRepository (a fork head) and the author's login.
 */
export const PR_VIEW_FIELDS =
  "number,title,body,url,author,headRefName,headRefOid,baseRefName,baseRefOid,files,isDraft," +
  "isCrossRepository";

interface PrViewJson {
  number: number;
  title: string;
  body?: string;
  url: string;
  headRefOid: string;
  baseRefName: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  author?: { login?: string; is_bot?: boolean } | null;
}

/** Repo permissions that mean "this person can already run code in CI here". */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Decision record 0009: a PR is trusted only when its head is a branch on the
 * repo itself AND its author has write access. Everything else, including any
 * failure to establish either fact, is untrusted. The caller's --trust and
 * --no-trust flags are handled above this and never reach here.
 */
export async function resolveTrust(
  bin: string,
  input: { repo: string; number: number; isCrossRepository?: boolean; authorLogin?: string },
  cwd: string,
): Promise<{ trust: TrustLevel; reason: string }> {
  if (input.isCrossRepository !== false) {
    return { trust: "untrusted", reason: "the PR head is on a fork" };
  }
  const login = input.authorLogin;
  if (!login || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) {
    return { trust: "untrusted", reason: "the PR author could not be identified" };
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) {
    return { trust: "untrusted", reason: "the repo could not be identified" };
  }
  let permission: string;
  try {
    const raw = await runGh(
      bin,
      ["api", `repos/${input.repo}/collaborators/${login}/permission`, "--jq", ".permission"],
      { cwd },
    );
    permission = raw.trim();
  } catch {
    return {
      trust: "untrusted",
      reason: `the author's permission on ${input.repo} could not be read`,
    };
  }
  if (WRITE_PERMISSIONS.has(permission)) {
    return { trust: "trusted", reason: `${login} has ${permission} access to ${input.repo}` };
  }
  return {
    trust: "untrusted",
    reason: `${login} has ${permission || "no"} access to ${input.repo}`,
  };
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
    isCrossRepository: raw.isCrossRepository,
    authorLogin: raw.author?.login,
  });
}
