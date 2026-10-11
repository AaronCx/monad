import { z } from "zod";
import { EventRecordSchema } from "./events.ts";
import { SearchKindSchema } from "./search.ts";
import {
  BackendIdSchema,
  SessionIdSchema,
  SessionModeSchema,
  SessionRecordSchema,
  TimestampSchema,
  TrustLevelSchema,
} from "./session.ts";

/**
 * The control API covers what ACP does not: cross-repo session listing and
 * daemon introspection. In M1 it is plain JSON over HTTP on the same port as
 * the ACP endpoint: GET /v1/sessions and GET /v1/status. ACP traffic is on
 * /acp. Both require the bearer token.
 */

/** Response of GET /v1/sessions. */
export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionRecordSchema),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/** One live vendor backend process owned by the daemon. */
export const ActiveBackendSchema = z.object({
  sessionId: SessionIdSchema,
  backend: BackendIdSchema,
});
export type ActiveBackend = z.infer<typeof ActiveBackendSchema>;

/** Response of GET /v1/status. */
export const DaemonStatusSchema = z.object({
  version: z.string(),
  startedAt: z.iso.datetime(),
  uptimeMs: z.number().int().nonnegative(),
  activeBackends: z.array(ActiveBackendSchema),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/**
 * Contents of ~/.monad/monadd.json, written by the daemon on startup and
 * read by the CLI to discover a running daemon.
 */
export const DaemonInfoSchema = z.object({
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

/**
 * PR metadata the CLI resolves via gh pr view before asking the daemon to
 * review. The daemon never runs gh for metadata; the caller's cwd (and gh
 * auth) resolve the PR, the daemon does the git and session work.
 */
export const ReviewPrInputSchema = z.object({
  /** owner/name, parsed from the PR url. */
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  body: z.string().optional(),
  headSha: z.string(),
  baseRef: z.string(),
  isDraft: z.boolean().optional(),
  /**
   * Trust inputs the CLI reads from gh (decision record 0009). The daemon
   * does not act on them: it takes the resolved level on the request itself,
   * because resolving needs gh auth the daemon deliberately does not have.
   */
  isCrossRepository: z.boolean().optional(),
  authorLogin: z.string().optional(),
});
export type ReviewPrInput = z.infer<typeof ReviewPrInputSchema>;

/** Body of POST /v1/review. */
export const ReviewRequestSchema = z.object({
  /** The caller's repo checkout; worktrees are created from it. */
  repoRoot: z.string(),
  pr: ReviewPrInputSchema,
  /** Force the full profile (--full). */
  full: z.boolean().optional(),
  /** Skip dependency install (--no-install). */
  noInstall: z.boolean().optional(),
  /**
   * Resolved by the CLI from the PR's origin and the author's permission, or
   * forced with --trust / --no-trust (decision record 0009). Absent means
   * untrusted; the daemon never resolves it itself, because the daemon has
   * no gh auth and no human in front of it.
   */
  trust: TrustLevelSchema.optional(),
  /** --install: install an untrusted PR's dependencies anyway. */
  install: z.boolean().optional(),
  /** The only value in M2; the field exists so M4 does not change the API. */
  backend: z.literal("claude-acp").optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/** One severity of a ReviewReport finding, highest first. */
export const ReviewSeveritySchema = z.enum(["critical", "high", "medium", "low", "nit"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  severity: ReviewSeveritySchema,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** The structured contract the review agent's final json block must match. */
export const ReviewReportSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["looks_good", "comment", "needs_changes"]),
  findings: z.array(ReviewFindingSchema),
  checks_acknowledged: z.boolean(),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/** Stored (and streamed) when the final message had no parsable json block. */
export const UnstructuredReportSchema = z.object({
  structured: z.literal(false),
  raw: z.string(),
});
export type UnstructuredReport = z.infer<typeof UnstructuredReportSchema>;

/**
 * Lines of the POST /v1/review ndjson response stream: every appended event
 * as it happens, then exactly one result (or error) line.
 */
export const ReviewStreamLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: EventRecordSchema }),
  z.object({
    type: z.literal("result"),
    sessionId: SessionIdSchema,
    worktree: z.string(),
    report: z.union([ReviewReportSchema, UnstructuredReportSchema]),
    structured: z.boolean(),
    /** True when any check had status fail. */
    checksFailed: z.boolean(),
    /** True => monad review exits 1. */
    failed: z.boolean(),
    /** Rendered checks table for printing and for --post. */
    checksTable: z.string(),
    /** Diff bounds, for --post anchoring. */
    baseSha: z.string(),
    headSha: z.string(),
    /** The level the review actually ran at (decision record 0009). */
    trust: TrustLevelSchema.default("untrusted"),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ReviewStreamLine = z.infer<typeof ReviewStreamLineSchema>;

/** Body of POST /v1/sessions/<id>/mode. */
export const SetModeRequestSchema = z.object({
  mode: SessionModeSchema,
});
export type SetModeRequest = z.infer<typeof SetModeRequestSchema>;

/** Response of POST /v1/sessions/<id>/mode. */
export const SetModeResponseSchema = z.object({
  session: SessionRecordSchema,
});
export type SetModeResponse = z.infer<typeof SetModeResponseSchema>;

/**
 * Longest title accepted over the control API. Derived titles stop at 80
 * characters; a human naming a session gets more room, but not unbounded.
 */
export const MAX_SESSION_TITLE_LENGTH = 200;

/**
 * Body of PATCH /v1/sessions/<id>. A string sets a manual title, which prompt
 * derivation never overwrites. null drops the manual title and re-derives one
 * from the session's first prompt.
 */
export const UpdateSessionRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_SESSION_TITLE_LENGTH).nullable(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

/** Response of PATCH /v1/sessions/<id>. */
export const UpdateSessionResponseSchema = z.object({
  session: SessionRecordSchema,
});
export type UpdateSessionResponse = z.infer<typeof UpdateSessionResponseSchema>;

/**
 * monad Link over the control API (decision record 0012). The CLI, and later
 * the phone, reach sessions through the same LinkService the monad-sessions
 * MCP server uses, with the human as the caller.
 */

/** Longest peer message accepted, from a session or from the CLI. */
export const MAX_PEER_MESSAGE_LENGTH = 32_000;

/** One hit of GET /v1/search. The snippet is redacted. */
export const LinkSearchHitSchema = z.object({
  sessionId: SessionIdSchema,
  title: z.string().optional(),
  kind: SearchKindSchema,
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  ts: TimestampSchema,
  snippet: z.string(),
});
export type LinkSearchHit = z.infer<typeof LinkSearchHitSchema>;

/** Response of GET /v1/search?q=&repo=&since=&limit=. */
export const SearchResponseSchema = z.object({
  hits: z.array(LinkSearchHitSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Response of GET /v1/sessions/<id>/transcript?from=&limit=: one page of the
 * normalized, redacted transcript. nextFromSeq is null at the end of the log.
 */
export const TranscriptResponseSchema = z.object({
  sessionId: SessionIdSchema,
  title: z.string().optional(),
  text: z.string(),
  entries: z.number().int().nonnegative(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative().nullable(),
  nextFromSeq: z.number().int().positive().nullable(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

/** Body of POST /v1/sessions/<id>/messages. */
export const SendMessageRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_PEER_MESSAGE_LENGTH),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/** Response of POST /v1/sessions/<id>/messages. */
export const SendMessageResponseSchema = z.object({
  messageId: z.string(),
  delivery: z.enum(["turn", "queued"]),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
