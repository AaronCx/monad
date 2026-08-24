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
