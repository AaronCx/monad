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
  "sessions_summarize",
  "notes_read",
  "notes_append",
] as const;
export type LinkToolName = (typeof LINK_TOOL_NAMES)[number];

/**
 * The tools a trusted review or fix session is offered: reading history and
 * repo notes, and nothing that reaches another session's turn, spends vendor
 * tokens or writes anything. Messaging, spawning, waiting, summarizing and
 * appending a note are interactive only.
 */
export const LINK_READ_ONLY_TOOL_NAMES: readonly LinkToolName[] = [
  "sessions_list",
  "sessions_search",
  "sessions_read",
  "notes_read",
];
