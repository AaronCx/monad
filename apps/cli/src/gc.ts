import { gcWorktrees } from "@aaroncx/engine";
import { ensureDaemon, fetchSessions } from "./daemon.ts";

/**
 * monad gc: removes worktrees of closed sessions older than the cutoff.
 * Event logs are never deleted, and a session the daemon still knows as
 * open keeps its worktree no matter how old it is.
 */

const DEFAULT_OLDER_THAN = "7d";

/** Parses 7d, 12h, 30m (and a bare number of days) into days. */
export function parseOlderThanDays(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([dhm]?)$/);
  if (!match?.[1]) {
    throw new Error(`cannot parse ${value} as a duration; use 7d, 12h, or 30m`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "h":
      return amount / 24;
    case "m":
      return amount / (24 * 60);
    default:
      return amount;
  }
}

export interface GcFlags {
  olderThanDays: number;
}

export function parseGcFlags(argv: string[]): GcFlags {
  let olderThan = DEFAULT_OLDER_THAN;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--older-than") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--older-than needs a duration (for example 7d)");
      }
      olderThan = value;
    } else if (arg !== undefined) {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return { olderThanDays: parseOlderThanDays(olderThan) };
}

export async function cmdGc(argv: string[]): Promise<void> {
  const flags = parseGcFlags(argv);
  const handle = await ensureDaemon();
  const sessions = await fetchSessions(handle);
  const closed = new Set(
    sessions.filter((session) => session.status === "closed").map((session) => session.id),
  );
  const { removed } = await gcWorktrees({
    olderThanDays: flags.olderThanDays,
    isSessionClosed: (sessionId) => closed.has(sessionId),
  });
  if (removed.length === 0) {
    console.log("no worktrees to remove");
    return;
  }
  for (const path of removed) {
    console.log(`removed ${path}`);
  }
}
