/**
 * ACP extension metadata keys monad attaches under _meta.
 *
 * The HTTP transport gives no cross-stream ordering between a session/load
 * response (connection stream) and the replayed session/update notifications
 * (session stream), so the load response alone cannot mean "replay done".
 * monad's session/load response carries the number of updates it replayed
 * under this key; clients count incoming updates and treat the boundary
 * between replay and live at that count (decision record 0004).
 */
export const REPLAY_COUNT_META_KEY = "monad.sh/replayCount";
