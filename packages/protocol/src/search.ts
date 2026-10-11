import { z } from "zod";
import { SessionIdSchema, TimestampSchema } from "./session.ts";

/**
 * monad Link's index over session logs (decision record 0012). The rows are
 * derived from the event log and can always be rebuilt from it; the log stays
 * the source of truth.
 */

/**
 * What an indexed row was made from. prompt: a user prompt's text blocks.
 * agent: agent message text, coalesced per turn. tool: a tool call's title
 * and the paths it touched (never its output). error: an error event's
 * message. Later Link phases add their own kinds here.
 */
export const SearchKindSchema = z.enum(["prompt", "agent", "tool", "error"]);
export type SearchKind = z.infer<typeof SearchKindSchema>;

/**
 * One full-text hit. firstSeq..lastSeq is the inclusive range of the session's
 * log the row was built from, so a reader can replay exactly that span. The
 * snippet is drawn from the index, which only ever holds redacted text.
 */
export const SearchHitSchema = z.object({
  sessionId: SessionIdSchema,
  kind: SearchKindSchema,
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  ts: TimestampSchema,
  snippet: z.string(),
  /** FTS5 bm25 score: lower is a better match. */
  rank: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * A repository a session touched: the git toplevel of a path one of its tool
 * calls carried (or of its cwd, when the cwd is inside a repo), with the seq
 * span over which it was touched. Linked worktrees fold into their main
 * repository's root.
 */
export const SessionRepoSchema = z.object({
  repoRoot: z.string(),
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
});
export type SessionRepo = z.infer<typeof SessionRepoSchema>;
