import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Environment variable overriding the monad state directory. Tests and
 * side-by-side daemons point it at a scratch directory; everything that
 * lives under ~/.monad (database, token, daemon info) follows it.
 */
export const MONAD_HOME_ENV = "MONAD_HOME";

/** The monad state directory: $MONAD_HOME if set, else ~/.monad. */
export function monadStateDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[MONAD_HOME_ENV]?.trim();
  return override ? override : join(homedir(), ".monad");
}

/** Path of the daemon discovery file monadd writes ({ port, pid, startedAt }). */
export function daemonInfoPath(env: Record<string, string | undefined> = process.env): string {
  return join(monadStateDir(env), "monadd.json");
}

/** Path of the daemon pid file. */
export function daemonPidPath(env: Record<string, string | undefined> = process.env): string {
  return join(monadStateDir(env), "monadd.pid");
}
