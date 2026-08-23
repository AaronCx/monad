# 0005: claude-agent-acp runs under the daemon's environment

Status: accepted. Spike 0b, run 2026-08-22 on the Mac Mini. Kept separate from 0004 on the spike's own suggestion: 0004 is about the SDK's HTTP transport under Bun, this one pins the vendor adapter invocation contract for packages/backends.

## Question

Does `@agentclientprotocol/claude-agent-acp` start, authenticate, and answer a prompt when spawned the way `monadd` will spawn it: pinned local bin, no TTY, minimal env (HOME and PATH only), stdio pipes?

## Result: yes, end to end in 7.9 seconds

Probe: `Bun.spawn(["node_modules/.bin/claude-agent-acp"], { cwd: <throwaway git repo>, env: { HOME, PATH: "/opt/homebrew/bin:/usr/bin:/bin" }, stdio: ["pipe", "pipe", "inherit"] })`, wrapped in `ndJsonStream` plus `ClientSideConnection` from `@agentclientprotocol/sdk` 1.4.0. Adapter version 0.70.0.

- `initialize` answered in 0.4s with `protocolVersion: 1`, `loadSession: true`, and `sessionCapabilities: { list, resume, fork, close, delete, additionalDirectories }`. The M1 restore-on-restart design (call vendor `session/load` with the stored `agentSessionId`) is viable.
- `session/new { cwd, mcpServers: [] }` returned a session id in about 4s (Claude Code subprocess startup; keep timeouts generous).
- One prompt ("Reply with the single word: pong") streamed exactly one `agent_message_chunk` containing `pong`. The turn ended with `stopReason: "end_turn"`. No permission requests.
- The existing Claude Code Max login was picked up with no `authenticate` round-trip. HOME alone (pointing at the real user home) is enough; credentials live under `~/.claude/`.
- `proc.kill()` after the turn exited the child cleanly (exit code 0, no zombie).

## Auth: how it actually behaves (read from dist/acp-agent.js, confirmed by the run)

- `authMethods` in the initialize response is not an auth-state signal. Our probe got `authMethods: []` while fully logged in. Terminal login methods appear only if the client advertises `clientCapabilities.auth.terminal` or `_meta["terminal-auth"]`; gateway methods only with `auth._meta.gateway`.
- Missing credentials do not fail `initialize` or `session/new`. They surface during `session/prompt` as an `auth_required` error.
- Every login method the adapter offers is `type: "terminal"`: it re-runs its own binary with `--cli auth login --claudeai` (subscription) or `--cli auth login --console` (API billing), which delegates to the wrapped Claude CLI. The adapter's own `authenticate` method throws "Method not implemented" for anything except the gateway methods.
- Consequence for monad: the CLI must catch `auth_required` and print the exact command for the user to run in their own terminal, for example `<repo>/node_modules/.bin/claude-agent-acp --cli auth login --claudeai`. monad never proxies the flow and never holds a token, matching the repo rule.

## Facts the backend code must honor

1. The bin is `dist/index.js` with shebang `#!/usr/bin/env node`, engines node >= 22. The child PATH must contain such a node; a launchd default PATH does not (node v25.8.0 is at /opt/homebrew/bin on this Mac). `monadd` should resolve node explicitly or extend the child PATH deliberately.
2. `Bun.spawn` gives a `FileSink` for stdin, not a `WritableStream`; wrap it (write plus flush, close maps to end) before `ndJsonStream(outputWritable, inputReadable)`. stdout is already a web `ReadableStream`.
3. Non-message update kinds arrive and must be stored verbatim: `available_commands_update` fires right after `session/new`, `usage_update` fires during turns.
4. Version skew is tolerated: the adapter embeds SDK 1.3.0 agent-side, our client used 1.4.0, negotiation settled on protocol version 1. Note `ClientSideConnection` is marked deprecated in 1.4.0 in favor of the `client()` builder; fine today, plan for the migration.
5. The adapter redirects all console output to stderr; stdout is pure ACP. Optional `CLAUDE_AGENT_LOGS=<dir>` makes it append to `<dir>/agent.log`, useful for daemon debugging.
6. Billing stays the vendor's business (see the brief's billing section); nothing in this spike required or touched a token.

Throwaway probe code lived in the scratchpad and is not kept; this record is the artifact.
