/**
 * The monad-sessions MCP tool surface (monad Link, decision record 0012),
 * shared by the server that serves it (packages/link) and the permission
 * policy that recognizes its calls (packages/engine). One list, so the two
 * cannot drift: a name the policy auto-allows is a name the server serves.
 */

/** The MCP server name the vendor sees; tools arrive as mcp__monad-sessions__<tool>. */
export const SESSIONS_MCP_SERVER_NAME = "monad-sessions";

/** Every tool the server serves, in the order tools/list returns them. */
export const LINK_TOOL_NAMES = [
  "sessions_list",
  "sessions_search",
  "sessions_read",
  "sessions_message",
  "sessions_spawn",
  "sessions_wait",
] as const;
export type LinkToolName = (typeof LINK_TOOL_NAMES)[number];

/**
 * The tools a trusted review or fix session is offered: reading history and
 * nothing that reaches another session's turn. Messaging, spawning and
 * waiting on a session are interactive only.
 */
export const LINK_READ_ONLY_TOOL_NAMES: readonly LinkToolName[] = [
  "sessions_list",
  "sessions_search",
  "sessions_read",
];

/**
 * Names reserved for later Link phases (summaries and repo notes). They are
 * NOT served and NOT recognized by the policy until their phase lands; they
 * are listed so nothing else takes them meanwhile.
 */
export const LINK_RESERVED_TOOL_NAMES = [
  "sessions_summarize",
  "notes_read",
  "notes_append",
] as const;
