# 0001: The daemon speaks ACP on both sides

Status: accepted, 2026-08-22

## Context

monad sits between vendor coding agents (Claude Code, Codex, Gemini CLI) and its own clients
(CLI, editors, later desktop and phone). Both edges need a wire protocol. Inventing one means
writing and maintaining clients for every editor; adopting one only toward vendors still
leaves the client edge bespoke.

The Agent Client Protocol (ACP) already standardizes exactly this shape: agents expose
sessions, prompts, streamed updates, and permission requests; clients drive them. Vendors ship
ACP adapters (`claude-agent-acp`, `codex-acp`, Gemini CLI speaks it natively), and editors
ship ACP clients (Zed, JetBrains, a VS Code extension).

## Decision

The daemon is an ACP client toward vendor agents (spawned per session over stdio) and an ACP
agent toward its own clients (served over the SDK's Streamable HTTP transport). Anything ACP
does not cover (cross-repo session listing, webhook-triggered sessions, check results) goes in
a small control API beside it (`/v1/*`), not in protocol extensions.

## Consequences

- Any existing ACP client can drive monad through a dumb stdio bridge (`monad acp-stdio`).
  Editor support costs nothing beyond the bridge.
- Vendor auth stays inside vendor binaries. monad never holds a vendor token.
- The SDK's HTTP server and client are experimental exports in 1.4.0, so every such import is
  wrapped in one module (`packages/engine/src/transport`) to contain churn.
- Multi-client attach to one session is a monad extension of ACP's one-connection-per-session
  model; the daemon's event log, not the transport, is what makes replay possible.
