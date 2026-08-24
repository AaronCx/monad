/**
 * Daemon discovery and lifecycle for the CLI.
 *
 * The implementation lives in @aaroncx/engine (src/client.ts): apps/hook
 * drives the same daemon over the same authenticated HTTP, and two copies of
 * "is monadd running, and how do I start it" drift. What is left here is the
 * name the CLI has always imported.
 */

export {
  authHeaders,
  cancelSession,
  DAEMON_BIN_ENV,
  ensureDaemon,
  fetchSessions,
  fetchStatus,
  findRunningDaemon,
  pidAlive,
  readDaemonInfo,
  readToken,
  resolveDaemonCommand,
  setSessionMode,
  startDaemon,
  stopDaemon,
  streamReview,
} from "@aaroncx/engine";
export type { DaemonHandle } from "@aaroncx/engine";
