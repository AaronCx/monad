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

## MONAD_VENDOR_HOME: an untrusted session gets a minimal home, and auth survives it

Added 2026-08-24 as M3 pre-flight B, measured on the Mac Mini against adapter
`claude-agent-acp` 0.70.0.

The spike above proved HOME alone is enough, with HOME being the real user home. Record 0006
fact 8 draws the consequence: the vendor session inherits the whole of `~/.claude`, which is
plugins, agents, skills, and MCP servers, some of them holding write credentials to other
systems. Under `monad review` that was your machine reviewing a PR you picked. Under M3 the
trigger is a stranger's push, so an untrusted session should not be offered any of it.

`resolveVendorHome(trust)` in `packages/backends/src/claude.ts` now decides the child's HOME.
Trusted sessions keep the user home, unchanged. An untrusted session runs under
`$MONAD_VENDOR_HOME`, default `<state dir>/vendor-home`, which holds exactly one thing: a
SYMLINK at `.claude/.credentials.json` pointing at the real one. Linked and never copied, for
two reasons: a copy is monad storing a vendor auth token, which the repo rule forbids, and a copy
goes stale the moment the vendor refreshes it.

Measured, both through monad's own `SessionManager` plus `createClaudeBackend` (not a probe
harness), one real prompt each ("Reply with the single word: pong"):

| | HOME | reply | advertised commands |
|---|---|---|---|
| trusted | `/Users/acx` | `pong` | 91 |
| untrusted | `/Users/acx/.monad/vendor-home` | `pong` | 47 |

So authentication survives the minimal home: the adapter picked up the Max login through the
linked credential file with no `authenticate` round trip, exactly as it does under the real home.
The 44 commands that disappear are this machine's plugins and skills (browserhitch, hookify,
vercel, and the rest); what remains is Claude Code's own built-in set. The vendor also writes its
transcripts and caches into that home, so an untrusted review no longer lands in the user's own
`~/.claude/projects`.

Authentication outranks this hardening, which is an M1 rule, so two cases keep the user home and
say why rather than failing:

- there is no `~/.claude/.credentials.json` to link at all. The login may live in the macOS
  Keychain, where a different HOME is unproven, and every CI runner looks like this. Expected,
  not an error event; the reason is recorded on the session's `vendor_tools` event.
- something replaced the link with a real file. That file is a credential copy monad must
  neither own nor delete, so the session falls back and an error event says so, once, with the
  path. This is the case to watch: if the vendor ever refreshes its token by writing a new file
  over the link rather than through it, the link is gone and the refreshed token is stranded in
  the vendor home while the user home keeps the old one. Not observed in the runs above, and the
  fallback is what makes it visible rather than silent.

Honest limitation: a minimal home is not a sandbox. The vendor process still runs as the same
user with the same filesystem access; what changed is which configuration it is handed. The
containment for what it may DO is still the policy layer.
