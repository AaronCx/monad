import { z } from "zod";

/**
 * ACP extension surface monad adds on top of the protocol: _meta keys and
 * one custom notification. ACP reserves _meta for extension metadata and
 * underscore-prefixed method names for extension methods; SDK-based clients
 * silently drop notifications they have no handler for, so editors that do
 * not know monad are unaffected.
 */

/**
 * The HTTP transport gives no cross-stream ordering between a session/load
 * response (connection stream) and the replayed session/update notifications
 * (session stream), so the load response alone cannot mean "replay done".
 * monad's session/load response carries the number of updates it replayed
 * under this key; clients count incoming updates and treat the boundary
 * between replay and live at that count (decision record 0004).
 */
export const REPLAY_COUNT_META_KEY = "monad.sh/replayCount";

/**
 * _meta key on each session/list SessionInfo carrying monad's session status
 * (idle, running, waiting_for_permission, closed).
 */
export const SESSION_STATUS_META_KEY = "monad.sh/status";

/**
 * Extension notification the daemon sends to attached clients when an error
 * event is appended to a session's log (for example a failed vendor context
 * restore after a daemon restart). ACP has no error update kind, and these
 * must never be silent, so they ride their own extension method.
 */
export const ERROR_NOTIFICATION_METHOD = "_monad.sh/error";

export const MonadErrorNotificationSchema = z.looseObject({
  sessionId: z.string(),
  message: z.string(),
});
export type MonadErrorNotification = z.infer<typeof MonadErrorNotificationSchema>;
