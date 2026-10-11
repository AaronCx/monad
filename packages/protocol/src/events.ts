import { z } from "zod";
import { SessionIdSchema, TimestampSchema } from "./session.ts";

/**
 * Every kind of event the daemon appends to a session's log.
 *
 * Payload contract per kind:
 * - session_created: the SessionRecord at creation time
 * - prompt: the ACP session/prompt request params, verbatim
 * - update: the ACP session/update notification params, verbatim. This
 *   includes non-message kinds such as available_commands_update and
 *   usage_update; the log must never assume message or tool updates only.
 * - permission_requested: the ACP session/request_permission params, verbatim
 * - permission_resolved: the ACP session/request_permission response
 *   (outcome) plus resolution metadata: by ("human" or "policy:review" or
 *   "policy:fix"), optionId, toolCallId, and an optional message explaining
 *   a policy rejection. M1 events carried the bare response; readers must
 *   treat the metadata as optional.
 * - worktree_ready: review playbook step 1 (WorktreeReadyPayload)
 * - checks: review playbook step 2, the full CheckRunResults
 * - review_report: the parsed ReviewReport, or { structured: false, raw }
 * - turn_ended: { stopReason }
 * - error: { message, ...context }
 * - closed: null
 * - peer_message (Link): a message another session (or the human at the CLI)
 *   sent this one (PeerMessagePayload). Appended on the TARGET's log when it
 *   arrives; `delivery` says whether it started a turn at once or was queued
 *   for the next turn boundary. The turn that delivers it is an ordinary
 *   prompt event whose _meta["monad.sh/peer"] carries the same messageId.
 * - access (Link): one cross-session read, search, message, spawn or wait
 *   (AccessPayload), appended to the caller's log and to every target's log
 *   so nothing reads a session silently. Not indexed, and does not move the
 *   session's updatedAt.
 */
export const EventKindSchema = z.enum([
  "session_created",
  "prompt",
  "update",
  "permission_requested",
  "permission_resolved",
  "worktree_ready",
  "checks",
  "review_report",
  "turn_ended",
  "error",
  "closed",
  "peer_message",
  "access",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

/**
 * Payloads are stored and returned verbatim (z.unknown()), never reshaped:
 * vendor updates carry fields monad must not strip or reorder.
 */
export const EventRecordSchema = z.object({
  /** Log-wide sequence number, assigned by SQLite, strictly increasing. */
  seq: z.number().int().positive(),
  sessionId: SessionIdSchema,
  ts: TimestampSchema,
  kind: EventKindSchema,
  payload: z.unknown(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

/**
 * Who resolved a permission request. Policies stamp policy:interactive,
 * policy:review or
 * policy:fix; anything a human answered (including forwarded fix-mode
 * executes) is stamped human. A policy never picks allow_always or
 * reject_always; only a human can.
 */
export const PermissionResolvedBySchema = z.enum([
  "human",
  "policy:interactive",
  "policy:review",
  "policy:fix",
]);
export type PermissionResolvedBy = z.infer<typeof PermissionResolvedBySchema>;

/**
 * Metadata merged into the permission_resolved event payload beside the ACP
 * response. Optional fields stay absent when unknown (cancelled outcomes
 * have no optionId; some requests carry no toolCall).
 */
export const PermissionResolutionMetaSchema = z.object({
  by: PermissionResolvedBySchema,
  optionId: z.string().optional(),
  toolCallId: z.string().optional(),
  /** Human-readable reason for a policy rejection, for the transcript. */
  message: z.string().optional(),
});
export type PermissionResolutionMeta = z.infer<typeof PermissionResolutionMetaSchema>;

/** Payload of a turn_ended event. */
export const TurnEndedPayloadSchema = z.object({
  stopReason: z.string(),
});
export type TurnEndedPayload = z.infer<typeof TurnEndedPayloadSchema>;

/** Payload of an error event. */
export const ErrorPayloadSchema = z.looseObject({
  message: z.string(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

/**
 * Who sent a peer message or made a Link access: a monad session, or the
 * human at the monad CLI (the control API's caller). A peer is never more
 * than a prompt source: nothing a peer sends can answer a permission, change
 * a mode or alter a policy (decision record 0012).
 */
export const LinkActorSchema = z.union([SessionIdSchema, z.literal("human")]);
export type LinkActor = z.infer<typeof LinkActorSchema>;

/** Payload of a peer_message event (decision record 0012). */
export const PeerMessagePayloadSchema = z.object({
  messageId: z.string(),
  from: LinkActorSchema,
  /** The sender's title and repo at send time, for the provenance header. */
  fromTitle: z.string().optional(),
  fromRepo: z.string().optional(),
  to: SessionIdSchema,
  text: z.string(),
  /**
   * How many session-to-session hops this message is from a human turn. A
   * human's own message is hop 0 and a message a session sends during a turn
   * of hop h is h + 1; the daemon drops anything past its hop limit.
   */
  hop: z.number().int().nonnegative(),
  /** turn: it started the target's next turn at once. queued: it waits. */
  delivery: z.enum(["turn", "queued"]),
});
export type PeerMessagePayload = z.infer<typeof PeerMessagePayloadSchema>;

/**
 * The Link operations an access event records. Phase 2 serves list, search,
 * read, message, spawn and wait; the rest are reserved for later phases so
 * the event shape does not change under them.
 */
export const AccessOpSchema = z.enum([
  "list",
  "search",
  "read",
  "message",
  "spawn",
  "wait",
  "summarize",
  "notes_read",
  "notes_append",
  "handoff",
]);
export type AccessOp = z.infer<typeof AccessOpSchema>;

/**
 * Payload of an access event. role says which side of the access this log
 * is: the caller that asked, or a target whose history or turn it touched.
 * A refused access is recorded too, with the reason, on the caller's log.
 */
export const AccessPayloadSchema = z.looseObject({
  op: AccessOpSchema,
  by: LinkActorSchema,
  role: z.enum(["caller", "target"]),
  target: SessionIdSchema.optional(),
  /** The other session of a message or spawn exchange. */
  peer: SessionIdSchema.optional(),
  query: z.string().optional(),
  fromSeq: z.number().int().optional(),
  toSeq: z.number().int().optional(),
  refused: z.string().optional(),
});
export type AccessPayload = z.infer<typeof AccessPayloadSchema>;
