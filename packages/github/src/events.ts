import type { EmitterWebhookEventName } from "@octokit/webhooks";
import { ReviewPrInputSchema, type ReviewPrInput } from "@aaroncx/protocol";
import { z } from "zod";

/**
 * Webhook payload narrowing: what monad reads out of a delivery, and nothing
 * else.
 *
 * Every schema here is a zod object, so unknown keys are stripped rather
 * than carried. What survives is a small, named shape that the rest of the
 * package and apps/hook can rely on, and a payload that does not match is
 * refused instead of being coerced. GitHub adds fields constantly; monad
 * reading only the ones it named means a new field cannot change behavior.
 *
 * The trigger set is deliberately short (decision record 0010). Anything
 * outside it is acknowledged with 200 and dropped, because a webhook
 * receiver that errors on events it did not ask for gets its deliveries
 * disabled by GitHub.
 */

/** Events monad subscribes to. Everything else is dropped on arrival. */
export const MONAD_EVENTS = [
  "pull_request",
  "issue_comment",
  "check_run",
  "installation",
  "installation_repositories",
] as const;

export type MonadEvent = (typeof MONAD_EVENTS)[number];

/** pull_request actions that open a review. */
export const REVIEW_PR_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
] as const;

/** The comment prefix that addresses monad. */
export const COMMAND_PREFIX = "@monad";

type Assert<T extends true> = T;

/**
 * Compile-time check that monad's trigger set names real webhook events.
 * This is the whole reason @octokit/webhooks is a dependency: its event
 * union, not its verifier and not its emitter.
 */
export type MonadEventsAreRealWebhookEvents = Assert<
  MonadEvent extends EmitterWebhookEventName ? true : false
>;

const RepositorySchema = z.object({
  full_name: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

const InstallationRefSchema = z.object({ id: z.number().int().positive() });

const UserSchema = z.object({ login: z.string().min(1) }).nullish();

/**
 * A PR head whose fork has been deleted arrives with repo: null. That is not
 * an error and it is not the base repo either, so it reads as a fork, which
 * is the safe answer.
 */
const HeadSchema = z.object({
  sha: z.string().min(1),
  ref: z.string().min(1),
  repo: z.object({ full_name: z.string().min(1) }).nullish(),
});

const BaseSchema = z.object({
  sha: z.string().min(1).optional(),
  ref: z.string().min(1),
  repo: z.object({ full_name: z.string().min(1) }),
});

const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().default(""),
  body: z.string().nullish(),
  html_url: z.string().default(""),
  draft: z.boolean().default(false),
  author_association: z.string().default("NONE"),
  user: UserSchema,
  head: HeadSchema,
  base: BaseSchema,
});

/** The PR as monad reads it: the fields trust and the review session need. */
export type NarrowedPullRequest = z.infer<typeof PullRequestSchema>;

const CommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().default(""),
  author_association: z.string().default("NONE"),
  user: UserSchema,
});

export type NarrowedComment = z.infer<typeof CommentSchema>;

const PullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: PullRequestSchema,
  repository: RepositorySchema,
  installation: InstallationRefSchema,
});

const IssueCommentEventSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    /** Present only on issues that are pull requests. */
    pull_request: z.object({}).nullish(),
    draft: z.boolean().nullish(),
  }),
  comment: CommentSchema,
  repository: RepositorySchema,
  installation: InstallationRefSchema,
});

const CheckRunEventSchema = z.object({
  action: z.string(),
  check_run: z.object({
    id: z.number().int().positive(),
    name: z.string().default(""),
    head_sha: z.string().min(1),
    pull_requests: z
      .array(z.object({ number: z.number().int().positive() }))
      .default([]),
  }),
  repository: RepositorySchema,
  installation: InstallationRefSchema,
});

const InstallationEventSchema = z.object({
  action: z.string(),
  installation: InstallationRefSchema,
  repositories: z.array(z.object({ full_name: z.string() })).nullish(),
  repositories_added: z.array(z.object({ full_name: z.string() })).nullish(),
  repositories_removed: z.array(z.object({ full_name: z.string() })).nullish(),
});

export interface RepoRef {
  owner: string;
  name: string;
  /** owner/name. */
  fullName: string;
}

/**
 * Everything about a delivery that is safe to write down. The brief's rule
 * is delivery id, event, action, repo, and PR number; this type is that rule
 * expressed so a log line structurally cannot carry a body or a token.
 */
export interface DeliveryMeta {
  id: string;
  event: string;
  action: string;
  repo?: string;
  number?: number;
}

/** One log-safe line. There is no variant of this that takes the payload. */
export function describeDelivery(meta: DeliveryMeta): string {
  const parts = [`delivery=${meta.id}`, `event=${meta.event}`, `action=${meta.action}`];
  if (meta.repo !== undefined) {
    parts.push(`repo=${meta.repo}`);
  }
  if (meta.number !== undefined) {
    parts.push(`pr=${meta.number}`);
  }
  return parts.join(" ");
}

export type MonadCommand =
  | { name: "review" }
  | { name: "fix"; instruction: string }
  | { name: "status" }
  | { name: "unknown"; verb: string };

/**
 * Parses an @monad comment. Returns undefined when the comment does not
 * address monad at all, which is most of them.
 *
 * There is no guessing here on purpose: an unrecognized verb, or fix with no
 * instruction, resolves to "unknown" so the caller reacts confused and does
 * nothing. A parser that tries to work out what was meant is a parser that
 * eventually runs fix mode because someone wrote the word "fix" in a
 * sentence.
 */
export function parseMonadCommand(body: string): MonadCommand | undefined {
  const trimmed = body.trimStart();
  if (trimmed.slice(0, COMMAND_PREFIX.length).toLowerCase() !== COMMAND_PREFIX) {
    return undefined;
  }
  const rest = trimmed.slice(COMMAND_PREFIX.length);
  if (rest.length > 0 && /[^\s]/.test(rest.charAt(0))) {
    // "@monadic thoughts" is not addressed to monad.
    return undefined;
  }
  const words = rest.trim();
  const verb = (words.split(/\s+/, 1)[0] ?? "").toLowerCase();
  const instruction = words.slice(verb.length).trim();
  if (verb === "review" && instruction.length === 0) {
    return { name: "review" };
  }
  if (verb === "status" && instruction.length === 0) {
    return { name: "status" };
  }
  if (verb === "fix" && instruction.length > 0) {
    return { name: "fix", instruction };
  }
  return { name: "unknown", verb };
}

export interface ReviewIntent {
  kind: "review";
  delivery: DeliveryMeta;
  trigger: "pull_request" | "issue_comment" | "check_run";
  installationId: number;
  repo: RepoRef;
  number: number;
  /** Present when the signed payload carried one. */
  headSha?: string;
  /**
   * Present only on pull_request deliveries. Trust is resolved from this and
   * nothing else; when it is absent the answer is untrusted until the caller
   * fetches the PR and resolves again.
   */
  pullRequest?: NarrowedPullRequest;
  /** Present when an @monad review comment triggered this. */
  comment?: NarrowedComment;
  /** Why this delivery became a review. Goes in the log and the summary. */
  reason: string;
}

export interface CommandIntent {
  kind: "command";
  delivery: DeliveryMeta;
  installationId: number;
  repo: RepoRef;
  number: number;
  command: Exclude<MonadCommand, { name: "review" }>;
  comment: NarrowedComment;
}

export interface RecordIntent {
  kind: "record";
  delivery: DeliveryMeta;
  installationId: number;
  /** owner/name of every repository the delivery named. */
  repositories: string[];
}

export interface IgnoredIntent {
  kind: "ignored";
  delivery: DeliveryMeta;
  reason: string;
  /** The payload did not match the schema monad expects for that event. */
  malformed?: boolean;
}

export type WebhookIntent = ReviewIntent | CommandIntent | RecordIntent | IgnoredIntent;

export interface DeliveryInput {
  /** X-GitHub-Event. */
  event: string;
  /** X-GitHub-Delivery, the idempotency key. */
  deliveryId: string;
  /** The parsed body. Parse only after the signature verified. */
  payload: unknown;
}

function repoRef(repository: z.infer<typeof RepositorySchema>): RepoRef {
  return {
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
  };
}

function actionOf(payload: unknown): string {
  const action = (payload as { action?: unknown } | null)?.action;
  return typeof action === "string" ? action : "";
}

function ignored(delivery: DeliveryMeta, reason: string, malformed = false): IgnoredIntent {
  return malformed ? { kind: "ignored", delivery, reason, malformed } : { kind: "ignored", delivery, reason };
}

/**
 * Resolves a verified delivery to what monad should do with it. Never
 * throws: an unparsable payload is an ignored intent carrying malformed, so
 * the receiver still answers 200 and the reason lands in the log.
 */
export function resolveWebhookIntent(input: DeliveryInput): WebhookIntent {
  const base: DeliveryMeta = {
    id: input.deliveryId,
    event: input.event,
    action: actionOf(input.payload),
  };

  if (!(MONAD_EVENTS as readonly string[]).includes(input.event)) {
    return ignored(base, `monad does not subscribe to ${input.event}`);
  }

  if (input.event === "pull_request") {
    return pullRequestIntent(base, input.payload);
  }
  if (input.event === "issue_comment") {
    return issueCommentIntent(base, input.payload);
  }
  if (input.event === "check_run") {
    return checkRunIntent(base, input.payload);
  }
  return installationIntent(base, input.payload);
}

function pullRequestIntent(base: DeliveryMeta, payload: unknown): WebhookIntent {
  const parsed = PullRequestEventSchema.safeParse(payload);
  if (!parsed.success) {
    return ignored(base, "the pull_request payload did not match monad's schema", true);
  }
  const { action, pull_request: pr, repository, installation } = parsed.data;
  const delivery: DeliveryMeta = {
    ...base,
    repo: repository.full_name,
    number: pr.number,
  };
  if (!(REVIEW_PR_ACTIONS as readonly string[]).includes(action)) {
    return ignored(delivery, `pull_request ${action} does not open a review`);
  }
  if (pr.draft && action !== "ready_for_review") {
    return ignored(delivery, "the pull request is a draft; comment @monad review to review it anyway");
  }
  return {
    kind: "review",
    delivery,
    trigger: "pull_request",
    installationId: installation.id,
    repo: repoRef(repository),
    number: pr.number,
    headSha: pr.head.sha,
    pullRequest: pr,
    reason: `pull_request ${action}`,
  };
}

function issueCommentIntent(base: DeliveryMeta, payload: unknown): WebhookIntent {
  const parsed = IssueCommentEventSchema.safeParse(payload);
  if (!parsed.success) {
    return ignored(base, "the issue_comment payload did not match monad's schema", true);
  }
  const { action, issue, comment, repository, installation } = parsed.data;
  const delivery: DeliveryMeta = {
    ...base,
    repo: repository.full_name,
    number: issue.number,
  };
  if (action !== "created") {
    return ignored(delivery, `issue_comment ${action} is not a new comment`);
  }
  if (issue.pull_request === undefined || issue.pull_request === null) {
    return ignored(delivery, "the comment is on an issue, not a pull request");
  }
  const command = parseMonadCommand(comment.body);
  if (command === undefined) {
    return ignored(delivery, `the comment does not start with ${COMMAND_PREFIX}`);
  }
  if (command.name === "review") {
    return {
      kind: "review",
      delivery,
      trigger: "issue_comment",
      installationId: installation.id,
      repo: repoRef(repository),
      number: issue.number,
      comment,
      // No head sha and no pull_request in this payload: the caller reads the
      // PR through the API, and trust stays untrusted until it does.
      reason: `${COMMAND_PREFIX} review`,
    };
  }
  return {
    kind: "command",
    delivery,
    installationId: installation.id,
    repo: repoRef(repository),
    number: issue.number,
    command,
    comment,
  };
}

function checkRunIntent(base: DeliveryMeta, payload: unknown): WebhookIntent {
  const parsed = CheckRunEventSchema.safeParse(payload);
  if (!parsed.success) {
    return ignored(base, "the check_run payload did not match monad's schema", true);
  }
  const { action, check_run: run, repository, installation } = parsed.data;
  const delivery: DeliveryMeta = { ...base, repo: repository.full_name };
  if (action !== "rerequested") {
    return ignored(delivery, `check_run ${action} does not open a review`);
  }
  // GitHub delivers rerequested only to the App that created the check run,
  // so there is no need to check the name; a run monad did not create never
  // reaches here.
  const first = run.pull_requests[0];
  if (first === undefined) {
    return ignored(delivery, "the rerequested check run names no pull request");
  }
  return {
    kind: "review",
    delivery: { ...delivery, number: first.number },
    trigger: "check_run",
    installationId: installation.id,
    repo: repoRef(repository),
    number: first.number,
    headSha: run.head_sha,
    reason: "check_run rerequested",
  };
}

function installationIntent(base: DeliveryMeta, payload: unknown): WebhookIntent {
  const parsed = InstallationEventSchema.safeParse(payload);
  if (!parsed.success) {
    return ignored(base, `the ${base.event} payload did not match monad's schema`, true);
  }
  const named = [
    ...(parsed.data.repositories ?? []),
    ...(parsed.data.repositories_added ?? []),
    ...(parsed.data.repositories_removed ?? []),
  ];
  return {
    kind: "record",
    delivery: base,
    installationId: parsed.data.installation.id,
    repositories: named.map((repo) => repo.full_name),
  };
}

/**
 * The PR metadata a review session needs, built from the signed payload
 * instead of from gh. isCrossRepository and authorLogin are the two trust
 * inputs decision record 0009 names, and both arrive here for free, which is
 * the whole reason the App does not shell out.
 */
export function reviewPrInputFromPayload(
  repo: RepoRef,
  pr: NarrowedPullRequest,
): ReviewPrInput {
  const headRepo = pr.head.repo?.full_name;
  return ReviewPrInputSchema.parse({
    repo: repo.fullName,
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? undefined,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    isDraft: pr.draft,
    isCrossRepository: headRepo !== pr.base.repo.full_name,
    authorLogin: pr.user?.login,
  });
}
