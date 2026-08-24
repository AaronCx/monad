import { execFile } from "node:child_process";
import { diffBetween } from "@aaroncx/checks";
import { methods } from "@agentclientprotocol/sdk";
import {
  REPLAY_COUNT_META_KEY,
  ReviewStreamLineSchema,
  type EventRecord,
  type ReviewFinding,
  type ReviewReport,
  type ReviewSeverity,
  type ReviewStreamLine,
  type SessionRecord,
  type TrustLevel,
  type UnstructuredReport,
} from "@aaroncx/protocol";
import { connectAcp, InteractiveSession } from "./client.ts";
import { authHeaders, type DaemonHandle, ensureDaemon, setSessionMode } from "./daemon.ts";
import { fetchPrMetadata, ghBin, resolveTrust } from "./gh.ts";
import { postReview } from "./post.ts";
import { Renderer } from "./render.ts";

/**
 * monad review <pr>: the CLI half of the review playbook. The playbook lives
 * in the daemon (worktree, checks, vendor session, policy); the CLI resolves
 * the PR through the caller's gh, streams the daemon's ndjson events, prints
 * the report, decides the exit code, and optionally posts the review.
 */

/** The one user prompt a switch into fix mode sends (ACP has no system channel). */
export const FIX_MODE_PROMPT =
  "Mode switched to fix. You may now edit files inside this worktree to address the " +
  "review findings. Commit when done; do not push.";

export interface ReviewFlags {
  pr: string;
  full: boolean;
  post: boolean;
  fix: boolean;
  noInstall: boolean;
  /**
   * --trust / --no-trust, decision record 0009. Undefined means "work it out
   * from the PR's origin and the author's permission".
   */
  trust?: TrustLevel;
  /** --install: install an untrusted PR's dependencies anyway. */
  install?: boolean;
  /** The protocol value; --backend claude is the only accepted spelling in M2. */
  backend: "claude-acp";
}

/** Throws on anything unparsable; main turns that into monad: <message>. */
export function parseReviewFlags(argv: string[]): ReviewFlags {
  const flags: ReviewFlags = {
    pr: "",
    full: false,
    post: false,
    fix: false,
    noInstall: false,
    backend: "claude-acp",
  };
  let pr: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--full") {
      flags.full = true;
    } else if (arg === "--post") {
      flags.post = true;
    } else if (arg === "--fix") {
      flags.fix = true;
    } else if (arg === "--no-install") {
      flags.noInstall = true;
    } else if (arg === "--install") {
      flags.install = true;
    } else if (arg === "--trust") {
      flags.trust = "trusted";
    } else if (arg === "--no-trust") {
      flags.trust = "untrusted";
    } else if (arg === "--backend") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--backend needs a value (claude is the only one in M2)");
      }
      if (value !== "claude" && value !== "claude-acp") {
        throw new Error(`unknown backend ${value}; M2 ships claude only`);
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    } else if (pr === undefined) {
      pr = arg;
    } else {
      throw new Error(`review takes one PR, got ${pr} and ${arg}`);
    }
  }
  if (pr === undefined) {
    throw new Error("review needs a PR number or URL");
  }
  if (flags.noInstall && flags.install) {
    throw new Error("--install and --no-install are mutually exclusive");
  }
  flags.pr = pr;
  return flags;
}

/** The daemon streams the report as a union; this is the discriminator. */
export function isUnstructured(
  report: ReviewReport | UnstructuredReport,
): report is UnstructuredReport {
  return "structured" in report && report.structured === false;
}

export interface ReviewOutcome {
  structured: boolean;
  report: ReviewReport | UnstructuredReport;
  checksFailed: boolean;
}

/**
 * 0 only when the agent produced a structured report whose verdict is
 * looks_good or comment AND no check failed. An unparsable report is a
 * failure: nobody reviewed anything monad can stand behind.
 */
export function reviewExitCode(outcome: ReviewOutcome): 0 | 1 {
  if (!outcome.structured || isUnstructured(outcome.report) || outcome.checksFailed) {
    return 1;
  }
  const verdict = outcome.report.verdict;
  return verdict === "looks_good" || verdict === "comment" ? 0 : 1;
}

const SEVERITY_ORDER: ReviewSeverity[] = ["critical", "high", "medium", "low", "nit"];

function formatFinding(finding: ReviewFinding): string {
  const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
  const lines = [`  - ${finding.title} (${where})`];
  for (const line of finding.body.split("\n")) {
    lines.push(`    ${line}`);
  }
  if (finding.suggestion !== undefined && finding.suggestion.length > 0) {
    lines.push("    suggestion:");
    for (const line of finding.suggestion.replace(/\n+$/, "").split("\n")) {
      lines.push(`      ${line}`);
    }
  }
  return lines.join("\n");
}

/** Summary, verdict, findings grouped by severity, then the checks table. */
export function formatReviewReport(
  report: ReviewReport | UnstructuredReport,
  checksTable: string,
): string {
  if (isUnstructured(report)) {
    return [
      "the agent's final message had no parsable ReviewReport json block; raw text follows",
      "",
      report.raw.trim(),
      "",
      checksTable,
    ].join("\n");
  }
  const sections = [report.summary.trim(), "", `verdict: ${report.verdict}`];
  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) {
      continue;
    }
    sections.push("", `${severity} (${group.length}):`);
    for (const finding of group) {
      sections.push(formatFinding(finding));
    }
  }
  if (report.findings.length === 0) {
    sections.push("", "no findings");
  }
  sections.push("", checksTable);
  return sections.join("\n");
}

/** The repo root of the caller's cwd; worktrees are created from it. */
export function repoRootOf(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd }, (error, stdout) => {
      if (error) {
        reject(new Error(`${cwd} is not inside a git repository`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

type ResultLine = Extract<ReviewStreamLine, { type: "result" }>;

/**
 * Streams POST /v1/review, handing every event to onEvent as it arrives and
 * returning the single result line. An error line becomes a thrown error.
 */
export async function streamReview(
  handle: DaemonHandle,
  body: unknown,
  onEvent: (event: EventRecord) => void,
): Promise<ResultLine> {
  const response = await fetch(`${handle.url}/v1/review`, {
    method: "POST",
    headers: { ...authHeaders(handle.token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    throw new Error(`POST /v1/review failed with ${response.status}`);
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let result: ResultLine | undefined;
  const consume = (line: string): void => {
    if (line.trim().length === 0) {
      return;
    }
    const parsed = ReviewStreamLineSchema.parse(JSON.parse(line));
    if (parsed.type === "event") {
      onEvent(parsed.event);
    } else if (parsed.type === "result") {
      result = parsed;
    } else {
      throw new Error(parsed.message);
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffered);
  if (result === undefined) {
    throw new Error("the daemon closed the review stream without a result");
  }
  return result;
}

/** Prints the playbook's non-update events; updates go through the renderer. */
function renderEvent(event: EventRecord, renderer: Renderer): void {
  switch (event.kind) {
    case "worktree_ready": {
      const payload = event.payload as {
        path: string;
        installStrategy: string;
        installMs: number;
        warnings?: string[];
      };
      renderer.line(
        renderer.dim(
          `worktree: ${payload.path} (install ${payload.installStrategy}, ${payload.installMs}ms)`,
        ),
      );
      for (const warning of payload.warnings ?? []) {
        renderer.line(renderer.dim(`worktree: ${warning}`));
      }
      return;
    }
    case "checks": {
      const payload = event.payload as {
        summary?: string;
        configSource?: { file: string; ref: string };
      };
      renderer.line(renderer.dim(`checks: ${payload.summary ?? "done"}`));
      if (payload.configSource) {
        renderer.line(
          renderer.dim(
            `checks: config from ${payload.configSource.file} at ${payload.configSource.ref}`,
          ),
        );
      }
      return;
    }
    case "session_created":
      renderer.line(renderer.dim("review session created"));
      return;
    case "prompt":
      renderer.line(renderer.dim("prompt sent; the agent is reviewing"));
      return;
    case "update":
      renderer.onUpdate(event.payload as Parameters<Renderer["onUpdate"]>[0]);
      return;
    case "error": {
      const payload = event.payload as { message?: string };
      renderer.line(`error: ${payload.message ?? "unknown"}`);
      return;
    }
    default:
      // review_report and turn_ended are rendered from the result line.
      return;
  }
}

/**
 * Loads a session on a fresh ACP connection, sends the fix-mode prompt, and
 * hands stdin to the interactive loop. Shared by review --fix and
 * attach --mode fix.
 */
export async function enterFixLoop(
  handle: DaemonHandle,
  record: SessionRecord,
  options: { prompt?: string } = {},
): Promise<void> {
  const renderer = new Renderer({ divider: true });
  const interactive = new InteractiveSession(renderer);
  const session = await connectAcp(handle, renderer, interactive);
  const loaded = await session.connection.agent.request(methods.agent.session.load, {
    sessionId: record.id,
    cwd: record.cwd,
    mcpServers: [],
  });
  const rawCount = loaded?._meta?.[REPLAY_COUNT_META_KEY];
  renderer.beginLive(typeof rawCount === "number" && rawCount >= 0 ? rawCount : 0);
  interactive.bind(session, record.id);
  await interactive.sendPrompt(FIX_MODE_PROMPT);
  if (options.prompt !== undefined) {
    await interactive.sendPrompt(options.prompt);
    session.connection.close();
    return;
  }
  await interactive.runLoop();
  session.connection.close();
}

export async function cmdReview(argv: string[]): Promise<void> {
  const flags = parseReviewFlags(argv);
  const repoRoot = await repoRootOf(process.cwd());
  const pr = await fetchPrMetadata(ghBin(), flags.pr, repoRoot);
  const handle = await ensureDaemon();

  // Decision record 0009. The flags are a human saying so and win outright;
  // otherwise one gh api call decides, and any doubt lands on untrusted.
  const resolved =
    flags.trust !== undefined
      ? { trust: flags.trust, reason: flags.trust === "trusted" ? "--trust" : "--no-trust" }
      : await resolveTrust(
          ghBin(),
          {
            repo: pr.repo,
            number: pr.number,
            isCrossRepository: pr.isCrossRepository,
            authorLogin: pr.authorLogin,
          },
          repoRoot,
        );

  const renderer = new Renderer({ divider: false });
  renderer.beginLive(0);
  renderer.line(renderer.dim(`reviewing ${pr.repo}#${pr.number}: ${pr.title}`));
  renderer.line(renderer.dim(`trust: ${resolved.trust} (${resolved.reason})`));
  if (resolved.trust === "untrusted") {
    renderer.line(
      renderer.dim(
        flags.install
          ? "untrusted: build and test will not run; --install will run this PR's lifecycle scripts"
          : "untrusted: no dependency install, and build and test will not run",
      ),
    );
  }
  const result = await streamReview(
    handle,
    {
      repoRoot,
      pr,
      full: flags.full,
      noInstall: flags.noInstall,
      trust: resolved.trust,
      install: flags.install,
      backend: flags.backend,
    },
    (event) => {
      renderEvent(event, renderer);
    },
  );

  renderer.ensureLine();
  console.log("");
  console.log(formatReviewReport(result.report, result.checksTable));
  console.log("");
  console.log(`session: ${result.sessionId}`);

  if (flags.post) {
    await postFromResult(repoRoot, pr.repo, pr.number, result);
  }

  if (flags.fix) {
    const record = await setSessionMode(handle, result.sessionId, "fix");
    console.log(`mode: fix (worktree ${record.cwd})`);
    await enterFixLoop(handle, record);
    process.exit(0);
  }
  process.exit(
    reviewExitCode({
      structured: result.structured,
      report: result.report,
      checksFailed: result.checksFailed,
    }),
  );
}

/**
 * --post: anchors findings against the same base..head diff the playbook
 * reviewed. The refs are already in the caller's repo (the playbook fetched
 * refs/monad/pr/<n> and the base ref into it), so this needs no network.
 */
async function postFromResult(
  repoRoot: string,
  repo: string,
  number: number,
  result: ResultLine,
): Promise<void> {
  if (!result.structured) {
    console.log("not posting: the review report was not structured");
    return;
  }
  const files = await diffBetween(result.baseSha, result.headSha, repoRoot);
  const outcome = await postReview({
    bin: ghBin(),
    repo,
    number,
    headSha: result.headSha,
    report: result.report as ReviewReport,
    files,
    checksTable: result.checksTable,
    cwd: repoRoot,
  });
  if (!outcome.posted) {
    console.log(`not posting: ${outcome.reason ?? "nothing to post"}`);
    return;
  }
  console.log(
    `posted a COMMENT review on ${repo}#${number}: ${outcome.comments} inline comment(s), ` +
      `${outcome.unanchored} finding(s) in the body`,
  );
}
