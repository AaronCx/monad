/// <reference path="./md.d.ts" />
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  type ChangedFile,
  type CheckRunResults,
  describeDroppedConfigFields,
  describeFinding,
  diffBetween,
  formatChecksTable,
  loadConfig,
  loadConfigAtRef,
  runChecks,
  sanitizeUntrustedConfig,
} from "@aaroncx/checks";
import type {
  EventRecord,
  ReviewFinding,
  ReviewPrInput,
  ReviewReport,
  SessionId,
  TrustLevel,
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
 *    detached worktree, apply the install strategy. An untrusted PR
 *    (decision record 0009) installs nothing unless --install says so.
 * 2. checks: diff base..head, run the configured checks with the review
 *    profile, store the full CheckRunResults. An untrusted PR's config is
 *    read from the base sha and stripped of every executing field, and its
 *    build and test never run; the checks event records which it was.
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
  /**
   * Whose code this PR is (decision record 0009), resolved by the caller
   * from the PR's origin and the author's repo permission, or forced with
   * --trust / --no-trust. Absent means untrusted: default deny.
   */
  trust?: TrustLevel;
  /** --install: install an untrusted PR's dependencies anyway, knowingly. */
  install?: boolean;
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
  /** The level this review actually ran at. */
  trust: TrustLevel;
}

/** Where a review's check rules came from, recorded on the checks event. */
export interface ConfigSourceRecord {
  /** ".monad.yml", ".lastgate.yml", or "defaults". */
  file: string;
  /** The base sha the config was read at, or "worktree" for a trusted read. */
  ref: string;
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
  const blocks = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)];
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

/**
 * The honest half of decision record 0009's install trade: an untrusted PR
 * gets no `bun install`, so `lint` and `typecheck` ran against a tree with no
 * node_modules. They still run, because a detected linter whose command line
 * monad chose can still say something useful, but whatever they said has to
 * carry the caveat rather than read like a verdict on the PR's code.
 */
export const NO_DEPS_NOTE =
  "dependencies were not installed for this untrusted PR, so this result may reflect the " +
  "missing toolchain rather than the code";

function noteUninstalledToolchain(results: CheckRunResults): void {
  for (const check of results.checks) {
    if (check.type !== "lint" && check.type !== "typecheck") {
      continue;
    }
    check.summary = check.summary ? `${check.summary} (${NO_DEPS_NOTE})` : NO_DEPS_NOTE;
    check.details = { ...check.details, dependenciesInstalled: false };
  }
}

/** Caps one untrusted string, naming the truncation so the model sees it. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n(truncated)` : text;
}

function formatChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) {
    return "(the diff is empty)";
  }
  return files
    .map((file) => {
      const { added, removed } = countPatchLines(file.patch ?? "");
      // A path is attacker-controlled text too: capped per entry, the same
      // way the PR body is capped, so no single entry can flood the prompt.
      return cap(`- ${file.path} (${file.status}, +${added} -${removed})`, MAX_PR_BODY_CHARS);
    })
    .join("\n");
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
    // Finding shapes differ per check; describeFinding normalizes them.
    for (const finding of findings as Array<Record<string, unknown>>) {
      lines.push(`- ${describeFinding(check.type, finding)}`);
    }
  }
  if (lines.length === 0) {
    return "No check failed.";
  }
  return ["Failing findings:", ...lines].join("\n");
}

// Kept where it was for the PR body; also applied per changed-file entry.
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
  // Default deny: a caller that did not resolve a trust level gets the
  // strict one (decision record 0009).
  const trust: TrustLevel = input.trust ?? "untrusted";
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
    // Decision record 0009. A trusted review reads the worktree, as M2 did.
    // An untrusted review reads the PR BASE, which is the last state a repo
    // maintainer approved, and then drops every field that decides what runs
    // so lint and typecheck fall back to the detected toolchain.
    const loaded =
      trust === "trusted"
        ? await loadConfig(worktree)
        : await loadConfigAtRef(worktree, baseSha);
    const sanitized =
      trust === "trusted"
        ? { config: loaded.config, dropped: [] as string[] }
        : sanitizeUntrustedConfig(loaded.config);
    const config = sanitized.config;
    const configSource: ConfigSourceRecord = {
      file: loaded.source,
      ref: trust === "trusted" ? "worktree" : baseSha,
    };
    const installResult = await installWorktreeDeps({
      path: worktree,
      strategy: input.noInstall ? "none" : (config.review?.install ?? "auto"),
      env: input.env,
      trust,
      force: input.install,
    });
    const droppedNote = describeDroppedConfigFields(sanitized.dropped);
    install = {
      path: worktree,
      installStrategy: installResult.installStrategy,
      installMs: installResult.installMs,
      trust,
      warnings: droppedNote ? [...installResult.warnings, droppedNote] : installResult.warnings,
    };

    manager.createRecord({
      id: sessionId,
      cwd: worktree,
      mode: "review",
      trust,
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
    const profile = input.full ? "full" : (config.review?.profile ?? "fast");
    results = await runChecks({
      cwd: worktree,
      files,
      base: baseSha,
      head: headSha,
      config,
      profile,
      trust,
    });
    if (
      trust === "untrusted" &&
      install.installStrategy === "none" &&
      existsSync(join(worktree, "package.json"))
    ) {
      noteUninstalledToolchain(results);
    }
    // configSource is on the event, not inside CheckRunResults, so the
    // transcript says which rules judged this PR and where they came from.
    manager.appendEvent(sessionId, "checks", {
      ...results,
      configSource,
      trust,
      droppedConfigFields: sanitized.dropped,
    });

    maxFindings = config.review?.max_findings ?? 25;
    let template = defaultPromptTemplate;
    // review.prompt is stripped from an untrusted config, so this can only
    // be a path a trusted source put there. Containment is still enforced:
    // an override that escapes the worktree is refused, not read.
    const overridePath = config.review?.prompt;
    if (overridePath) {
      const resolved = resolve(worktree, overridePath);
      const inside = resolved === worktree || resolved.startsWith(`${worktree}${sep}`);
      if (inside) {
        try {
          template = await readFile(resolved, "utf8");
        } catch {
          // A missing override falls back to the default template; the
          // config warning channel is the place to surface it later.
        }
      }
    }
    const body = pr.body ?? "(no description)";
    promptText = buildReviewPrompt(template, {
      PR_NUMBER: String(pr.number),
      PR_TITLE: cap(pr.title, MAX_PR_BODY_CHARS),
      PR_URL: pr.url,
      PR_BODY: cap(body, MAX_PR_BODY_CHARS),
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
    trust,
  };
}
