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
 * - permission_resolved: the ACP session/request_permission response (outcome)
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
