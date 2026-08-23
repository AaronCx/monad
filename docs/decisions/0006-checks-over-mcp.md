# 0006: monad checks reach the review session over HTTP MCP

Status: accepted. Spike 0a, run 2026-08-23 on the Mac Mini. Numbered 0006 because M1 already
used 0005 for the adapter invocation contract; the brief's reference to 0005 for this record is
superseded.

## Question

Does an `mcpServers` entry of `type: "http"` with a bearer `Authorization` header, passed
through ACP `session/new` to `claude-agent-acp`, reach Claude with the header intact and expose
a callable tool? This decides whether `monad checks` can be served from the daemon's own HTTP
server at `/mcp/test` style endpoints instead of a stdio sidecar per session.

## What was probed

Throwaway spike in the scratchpad, not in the repo. `@modelcontextprotocol/sdk` 1.30.0,
`@agentclientprotocol/sdk` 1.4.0, zod 4.4.3, Bun 1.3.10, adapter `claude-agent-acp` 0.70.0 from
`~/.monad/vendor/node_modules`. A minimal MCP server (one tool, `ping_check`, returning a fixed
JSON string with a nonce) over the MCP SDK's Streamable HTTP transport in stateless mode
(`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, fresh transport plus
`McpServer` per POST), mounted on `node:http` at `127.0.0.1:<random port>/mcp/test`, returning
401 unless the exact `Authorization: Bearer <random token>` header is present. The adapter was
spawned per decision 0005 (HOME plus PATH only, FileSink stdin wrapper, `ndJsonStream`,
`ClientSideConnection`), then `session/new` with:

    mcpServers: [{ type: "http", name: "monad-checks", url: "http://127.0.0.1:<port>/mcp/test",
                   headers: [{ name: "Authorization", value: "Bearer <token>" }] }]

and one prompt: "Call the ping_check tool from monad-checks and tell me its output."

## Result: yes, end to end in 9.8 seconds

- The ACP schema (1.4.0 `types.gen.d.ts`) confirms the shape: `McpServer` is a union of
  `(McpServerHttp & { type: "http" })`, `(McpServerSse & { type: "sse" })`,
  `(McpServerAcp & { type: "acp" })`, and `McpServerStdio` (no discriminator). `McpServerHttp`
  is `{ name, url, headers: Array<HttpHeader> }` with `HttpHeader = { name, value }`, and
  `headers` is required (pass an empty array when none).
- The adapter forwards it: `acp-agent.js` maps http and sse entries to Claude Agent SDK server
  configs, converting the headers array to a record via `Object.fromEntries`.
- Every HTTP request the vendor made to the MCP server carried the bearer header and matched
  the token: a `server/discover` pre-flight POST (nonstandard, sent with an `mcp-method`
  request header), `initialize`, `notifications/initialized`, a standalone GET SSE attempt
  (answered 405, tolerated), `tools/list`, and `tools/call`. Six requests, zero drops.
- The tool executed and its output reached the reply verbatim: the completed
  `tool_call_update` carried the exact JSON string in `content[0].content.text` and
  `rawOutput`, and the agent message quoted the nonce. `stopReason: end_turn`.
- Tool identity as seen over ACP: `tool_call` arrived with `title` and
  `_meta.claudeCode.toolName` both equal to `mcp__monad-checks__ping_check`, `kind: "other"`,
  `toolCallId` being the Anthropic `toolu_` id. This `mcp__<serverName>__<toolName>` string is
  the stable key for monad's event log and any permission policy.

## Decision

M2 serves the checks tools from the daemon's existing HTTP server as a Streamable HTTP MCP
endpoint with a per-session bearer token, injected into each review session through the
`session/new` `mcpServers` array as `type: "http"`. No stdio sidecar process per session. The
stdio fallback (`monad checks-mcp --session <id>`) is not needed and is not built.

## Facts the implementation must honor

1. `headers` is required on `McpServerHttp` and duplicate header names collapse (last wins)
   when the adapter folds the array into a record.
2. Stdio trap for any future fallback: the adapter only treats an entry as stdio when the
   `type` field is ABSENT (`!("type" in server)`). An explicit `type: "stdio"` entry is
   silently dropped, as is `type: "acp"`. A stdio entry must be
   `{ name, command, args, env: [{ name, value }] }` with no `type` key.
3. The whole `mcpServers` value, token included, is part of the adapter's session fingerprint
   (`computeSessionFingerprint`: cwd plus name-sorted mcpServers). Passing a different token on
   resume or load recreates the underlying Claude Code subprocess. Keep the per-session token
   stable for the session's lifetime.
4. MCP tools arrive as deferred tools: Claude ran ToolSearch
   (`select:mcp__monad-checks__ping_check`) before calling. Prompts should name the server
   (for example "the monad-checks tools") so discovery is one step.
5. In `default` mode the first call to each MCP tool raises `session/request_permission`
   (reject_once, allow_once, allow_always). monad's client must answer it. Prefer allow_once
   or pre-approval through its own policy: choosing allow_always persists
   `{"permissions":{"allow":["mcp__monad-checks__ping_check"]}}` into
   `<cwd>/.claude/settings.local.json`, which dirties a review worktree.
6. The endpoint must tolerate three non-tool requests: the `server/discover` POST, the
   standalone GET SSE stream (405 is fine), and `notifications/initialized`. Stateless
   per-request transports are sufficient; no MCP session state is required.
7. `initialize` advertises `mcpCapabilities: { http: true, sse: true }`; gate injection on
   that flag rather than assuming it.
8. The vendor session inherits the user's global `~/.claude` configuration (plugins, agents,
   deferred tool roster) because HOME is the real user home per decision 0005. Do not assume a
   clean tool namespace.
9. Bind the MCP endpoint to loopback and treat the bearer check as the only auth layer, same
   placement as the ACP transport's token check from decision 0004 (in front of the handler in
   the `node:http` request callback).

## Revisit when

The adapter's `mcpServers` mapping changes on a vendor bump (watch the stdio type-absence
quirk), or when checks tools need streaming progress (the SSE server type or stateful
Streamable HTTP sessions would then be worth probing).
