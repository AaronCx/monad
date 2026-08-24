/**
 * @aaroncx/github: the GitHub side of monad, and nothing else.
 *
 * This package is a trigger and a renderer (decision record 0010). It reads
 * signed webhook payloads, resolves them to an intent, decides trust from
 * what GitHub signed, and renders a review the engine already produced into
 * GitHub's API shapes. It runs no checks, holds no policy, and never decides
 * what a session may execute; that lives in @aaroncx/engine and
 * @aaroncx/checks. It must not import from apps/.
 */
export {};
