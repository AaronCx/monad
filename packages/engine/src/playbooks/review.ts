/// <reference path="./md.d.ts" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChangedFile,
  type CheckRunResults,
  diffBetween,
  formatChecksTable,
  loadConfig,
  runChecks,
} from "@aaroncx/checks";
import type {
  EventRecord,
  ReviewFinding,
  ReviewPrInput,
  ReviewReport,
  SessionId,
  UnstructuredReport,
} from "@aaroncx/protocol";
import { ReviewReportSchema } from "@aaroncx/protocol";
import type { SessionClient, SessionManager } from "../session.ts";
import {
  createWorktree,
  fetchPullRequestHead,
  installWorktreeDeps,
  removeWorktree,
  resolveBaseSha,
  type WorktreeReadyPayload,
} from "../worktree.ts";
import defaultPromptTemplate from "./review-prompt.md" with { type: "text" };

/**
 * The review playbook: monad review <pr> after the CLI resolved the PR
 * metadata through the caller's gh. Steps, each an appended event:
 *
 * 1. worktree_ready: fetch the PR head, compute the merge base, create the
 *    detached worktree, apply the install strategy.
 * 2. checks: diff base..head, run the configured checks with the review
 *    profile, store the full CheckRunResults.
 * 3. session_created: vendor session in the worktree, mode review (vendor
 *    plan mode layered by the backend per decision 0007), monad-checks
 *    injected by the daemon's backend factory.
 * 4. prompt: built from review-prompt.md (repo override via review.prompt).
 * 5. review_report: the last fenced json block of the final agent message
 *    parsed against ReviewReport; on parse failure { structured: false, raw }
 *    is stored and no retry happens in M2.
 *
 * The report event lands before turn_ended (the manager's beforeTurnEnded
 * seam), so the log reads worktree_ready, checks, session_created, prompt,
 * update..., review_report, turn_ended. The session is left idle in review
 * mode; monad attach <id> --mode fix is "fix it".
 */

export interface ReviewPlaybookInput {
  /** The caller's repo checkout; worktrees are created from it. */
  repoRoot: string;
  /** PR metadata resolved by the CLI via gh pr view. */
  pr: ReviewPrInput;
  /** Force the full check profile (--full). */
  full?: boolean;
  /** Skip dependency install (--no-install). */
  noInstall?: boolean;
  env?: Record<string, string | undefined>;
  /** Streams every appended event in log order (the ndjson response). */
  onEvent?: (event: EventRecord) => void;
}

export interface ReviewPlaybookResult {
  sessionId: SessionId;
  worktree: string;
  report: ReviewReport | UnstructuredReport;
  structured: boolean;
  /** True when any check had status fail. */
  checksFailed: boolean;
  /** True => monad review exits 1. */
  failed: boolean;
  /** Rendered checks table for printing and for --post. */
  checksTable: string;
  baseSha: string;
  headSha: string;
}

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

/**
 * Caps findings at max, keeping the highest severities; original order is
 * preserved among the kept findings.
 */
export function capFindings(findings: ReviewFinding[], max: number): ReviewFinding[] {
  if (findings.length <= max) {
    return findings;
  }
  const keep = new Set(
    findings
      .map((finding, index) => ({ finding, index }))
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
          a.index - b.index,
      )
      .slice(0, max)
      .map((entry) => entry.index),
  );
  return findings.filter((_, index) => keep.has(index));
}

/**
 * Extracts and validates the LAST fenced json block of the agent's final
 * message. Returns undefined when there is no block or it does not parse
 * against ReviewReport; the caller stores { structured: false, raw }.
 */
export function parseReviewReport(text: string): ReviewReport | undefined {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return undefined;
  }
  const result = ReviewReportSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) {
    return "(the diff is empty)";
  }
  return files
    .map((file) => {
      const { added, removed } = countPatchLines(file.patch ?? "");
      return `- ${file.path} (${file.status}, +${added} -${removed})`;
    })
    .join("\n");
}

interface CheckFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

function formatFailFindings(results: CheckRunResults): string {
  const lines: string[] = [];
  for (const check of results.checks) {
    if (check.status !== "fail") {
      continue;
    }
    const findings = check.details?.findings;
    if (!Array.isArray(findings)) {
      continue;
    }
    for (const finding of findings as CheckFinding[]) {
      lines.push(`- ${finding.file}:${finding.line} [${check.type}/${finding.rule}] ${finding.message}`);
    }
  }
  if (lines.length === 0) {
    return "No check failed.";
  }
  return ["Failing findings:", ...lines].join("\n");
}

const MAX_PR_BODY_CHARS = 4000;

export function buildReviewPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

/** A subscriber that forwards events and accumulates agent message text. */
class PlaybookClient implements SessionClient {
  private readonly forward?: (event: EventRecord) => void;
  agentText = "";

  constructor(forward?: (event: EventRecord) => void) {
    this.forward = forward;
  }

  onEvent(event: EventRecord): void {
    if (event.kind === "update") {
      const update = (event.payload as { update?: { sessionUpdate?: string; content?: unknown } })
        .update;
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          this.agentText += content.text;
        }
      }
    }
    this.forward?.(event);
  }

  requestPermission(): Promise<never> {
    // The review policy decides every request itself and never forwards;
    // reaching this would be a policy bug, and rejecting keeps it loud.
    return Promise.reject(new Error("the review playbook client cannot answer permissions"));
  }
}

/**
 * Runs the whole review playbook against a SessionManager. Throws on
 * infrastructure failures (fetch, worktree, install, checks); the vendor
 * turn's own failure surfaces through the manager's error event and rethrow.
 */
export async function runReviewPlaybook(
  manager: SessionManager,
  input: ReviewPlaybookInput,
): Promise<ReviewPlaybookResult> {
  const { repoRoot, pr } = input;
  const { headSha } = await fetchPullRequestHead({ repoRoot, number: pr.number });
  const { baseSha } = await resolveBaseSha({ repoRoot, baseRef: pr.baseRef, headSha });

  const sessionId = Bun.randomUUIDv7();
  const { path: worktree } = await createWorktree({
    repoRoot,
    sha: headSha,
    sessionId,
    env: input.env,
  });

  let results: CheckRunResults;
  let install: WorktreeReadyPayload;
  let promptText: string;
  let client: PlaybookClient;
  let maxFindings: number;
  try {
    const loaded = await loadConfig(worktree);
    const installResult = await installWorktreeDeps({
      path: worktree,
      strategy: input.noInstall ? "none" : (loaded.config.review?.install ?? "auto"),
      env: input.env,
    });
    install = {
      path: worktree,
      installStrategy: installResult.installStrategy,
      installMs: installResult.installMs,
    };

    manager.createRecord({
      id: sessionId,
      cwd: worktree,
      mode: "review",
      base: baseSha,
      head: headSha,
      pr: {
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        headSha,
        baseRef: pr.baseRef,
        baseSha,
        title: pr.title,
      },
    });
    client = new PlaybookClient(input.onEvent);
    manager.attach(sessionId, client);
    manager.appendEvent(sessionId, "worktree_ready", install);

    const files = await diffBetween(baseSha, headSha, worktree);
    const profile = input.full ? "full" : (loaded.config.review?.profile ?? "fast");
    results = await runChecks({
      cwd: worktree,
      files,
      base: baseSha,
      head: headSha,
      config: loaded.config,
      profile,
    });
    manager.appendEvent(sessionId, "checks", results);

    maxFindings = loaded.config.review?.max_findings ?? 25;
    let template = defaultPromptTemplate;
    const overridePath = loaded.config.review?.prompt;
    if (overridePath) {
      try {
        template = await readFile(join(worktree, overridePath), "utf8");
      } catch {
        // A missing override falls back to the default template; the
        // config warning channel is the place to surface it later.
      }
    }
    const body = pr.body ?? "(no description)";
    promptText = buildReviewPrompt(template, {
      PR_NUMBER: String(pr.number),
      PR_TITLE: pr.title,
      PR_URL: pr.url,
      PR_BODY:
        body.length > MAX_PR_BODY_CHARS ? `${body.slice(0, MAX_PR_BODY_CHARS)}\n(truncated)` : body,
      CHANGED_FILES: formatChangedFiles(files),
      CHECKS_TABLE: formatChecksTable(results),
      CHECK_FINDINGS: formatFailFindings(results),
      MAX_FINDINGS: String(maxFindings),
    });
  } catch (error) {
    // Nothing beyond the worktree exists yet on the earliest failures; on
    // later ones the session record survives for debugging, but a worktree
    // without a session must not linger.
    if (manager.get(sessionId) === undefined) {
      await removeWorktree({ repoRoot, path: worktree }).catch(() => {});
    }
    throw error;
  }

  let report: ReviewReport | UnstructuredReport | undefined;
  try {
    await manager.activate(sessionId);
    await manager.prompt(
      sessionId,
      { sessionId, prompt: [{ type: "text", text: promptText }] },
      client,
      {
        beforeTurnEnded: () => {
          const parsed = parseReviewReport(client.agentText);
          report = parsed
            ? { ...parsed, findings: capFindings(parsed.findings, maxFindings) }
            : { structured: false as const, raw: client.agentText };
          manager.appendEvent(sessionId, "review_report", report);
        },
      },
    );
  } finally {
    manager.detach(sessionId, client);
  }
  if (report === undefined) {
    // beforeTurnEnded always ran if the prompt resolved; this is the
    // defensive branch for an exception path that still resolved.
    report = { structured: false, raw: client.agentText };
  }

  const structured = !("structured" in report && report.structured === false);
  const checksFailed = results.checks.some((check) => check.status === "fail");
  const failed =
    !structured ||
    ("verdict" in report && report.verdict === "needs_changes") ||
    checksFailed;
  return {
    sessionId,
    worktree,
    report,
    structured,
    checksFailed,
    failed,
    checksTable: formatChecksTable(results),
    baseSha,
    headSha,
  };
}
