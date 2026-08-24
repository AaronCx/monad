import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRunResults } from "@aaroncx/checks";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  type OctokitLike,
  SIGNATURE_HEADER,
} from "@aaroncx/github";
import { fakeOctokit, type FakeOctokit } from "../../../../packages/github/test/fixtures/fake-octokit.ts";
import { memoryLogger, type Logger } from "../../src/log.ts";
import { DeliveryQueue } from "../../src/queue.ts";
import { createHookHandler } from "../../src/server.ts";
import { HookWorker } from "../../src/worker.ts";
import { FakeDaemon, reviewResult } from "./fake-daemon.ts";

export const SECRET = "hmac-me";
export const REPO_FULL_NAME = "AaronCx/monad-review-demo";
export const INSTALLATION_ID = 4242;

export function signature(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function deliveryRequest(options: {
  event: string;
  deliveryId: string;
  payload: unknown;
  secret?: string;
  /** Overrides the signature header outright (tampering, truncation). */
  signatureHeader?: string | null;
  url?: string;
}): Request {
  const body = JSON.stringify(options.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [EVENT_HEADER]: options.event,
    [DELIVERY_HEADER]: options.deliveryId,
  };
  const sig =
    options.signatureHeader === undefined
      ? signature(body, options.secret ?? SECRET)
      : options.signatureHeader;
  if (sig !== null) {
    headers[SIGNATURE_HEADER] = sig;
  }
  return new Request(options.url ?? "http://127.0.0.1:7332/webhook", {
    method: "POST",
    headers,
    body,
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

/**
 * A real two-commit repository, because the review post anchors findings
 * against a real base..head diff. Faking that would make every anchoring
 * assertion a test of the fake.
 */
function checkoutFixture(root: string): { baseSha: string; headSha: string } {
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "src/app.ts"), "export const answer = 41;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: base");
  const baseSha = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/app.ts"), "export const answer = 41;\nexport const extra = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feat: add extra");
  const headSha = git(root, "rev-parse", "HEAD");
  return { baseSha, headSha };
}

export interface Harness {
  queue: DeliveryQueue;
  daemon: FakeDaemon;
  worker: HookWorker;
  github: FakeOctokit;
  log: Logger & { lines: string[] };
  handle(request: Request): Promise<Response>;
  dbPath: string;
  /** Repos with a local checkout, as github.json's installations would say. */
  repoRoots: Map<string, string>;
  repoRoot: string;
  baseSha: string;
  headSha: string;
  close(): void;
}

export function harness(
  options: {
    responder?: Parameters<typeof fakeOctokit>[0];
    maxConcurrent?: number;
    maxAttempts?: number;
    backoffMs?: (attempts: number) => number;
    octokitFor?: (installationId: number) => Promise<OctokitLike>;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "monad-hook-test-"));
  const dbPath = join(dir, "monad.db");
  const queue = new DeliveryQueue({ dbPath });
  const daemon = new FakeDaemon();
  const github = fakeOctokit(options.responder);
  const log = memoryLogger();
  const repoRoot = join(dir, "checkout");
  mkdirSync(repoRoot, { recursive: true });
  const { baseSha, headSha } = checkoutFixture(repoRoot);
  const repoRoots = new Map<string, string>([[REPO_FULL_NAME, repoRoot]]);
  // Reviews answer immediately by default, with the fixture's own shas so
  // the review post anchors against a real diff. A test that needs to hold a
  // review open (supersede, concurrency) sets autoReview to undefined.
  daemon.autoReview = (call) => {
    daemon.announce(call, checkResults());
    call.resolve(
      reviewResult({ baseSha, headSha, sessionId: call.sessionId, checksFailed: true, failed: true }),
    );
  };
  const worker = new HookWorker({
    queue,
    daemon,
    octokitFor: options.octokitFor ?? (async () => github.octokit),
    repoRootFor: (fullName) => repoRoots.get(fullName),
    dbPath,
    log,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxAttempts: options.maxAttempts,
    backoffMs: options.backoffMs,
  });
  const handler = createHookHandler({
    webhookSecret: SECRET,
    queue,
    worker,
    log,
    version: "test",
  });
  return {
    queue,
    daemon,
    worker,
    github,
    log,
    dbPath,
    repoRoots,
    repoRoot,
    baseSha,
    headSha,
    handle: (request) => handler(request),
    close: () => {
      queue.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A CheckRunResults with one failing check and two annotations. */
export function checkResults(overrides: Partial<CheckRunResults> = {}): CheckRunResults {
  return {
    checks: [
      {
        type: "secrets",
        status: "pass",
        title: "No secrets found",
        details: {},
      },
      {
        type: "lint",
        status: "fail",
        title: "Lint found problems",
        details: { findings: [{ file: "src/app.ts", line: 2, rule: "noDoubleEquals", message: "use ===" }] },
      },
    ],
    hasFailures: true,
    hasWarnings: false,
    failureCount: 1,
    warningCount: 0,
    summary: "1 check failed",
    annotations: [
      {
        path: "src/app.ts",
        start_line: 2,
        end_line: 2,
        annotation_level: "failure",
        message: "use ===",
        title: "lint",
      },
    ],
    meta: { engineVersion: "test", entropyThreshold: 4.8, inlineIgnore: true },
    ...overrides,
  };
}

/** Waits for a condition the worker reaches asynchronously. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
