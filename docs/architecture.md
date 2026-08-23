# Architecture

monad is a single daemon that runs coding-agent sessions. A session is a working directory
plus an agent backend plus a playbook. Interactive sessions are opened by a human from the
CLI (later desktop, web, phone). Review sessions are opened by a GitHub PR event, run
diff-scoped checks, and post results back to GitHub. Both are the same session type, stored
the same way, and any client can attach to either. "Fix it" on a failing review is attaching
to that session, not a separate feature.

## The protocol decision

The daemon speaks the Agent Client Protocol (ACP) on both sides.

- Toward vendor agents it is an ACP **client**, spawning `claude-agent-acp`, `codex-acp`, or
  Gemini CLI per session over stdio. Auth lives inside their binaries; monad never holds a
  vendor token.
- Toward monad's own clients (CLI now, others later) it is an ACP **agent** served over the
  SDK's Streamable HTTP transport. Any existing ACP client (Zed, JetBrains, the VS Code ACP
  extension) can therefore drive monad with a stdio bridge, for free.
- What ACP does not cover (cross-repo session listing, webhook-triggered sessions, check
  results) goes in a small control API beside it, not in a new protocol.

## Persistence

Sessions persist as an append-only event log in SQLite (one file under `~/.monad`, WAL mode).
Attaching to a session is a replay of its log plus a live subscription to new events. The
event log is monad's own source of truth: the ACP HTTP transport does not replay messages a
disconnected client missed, so the daemon does.

## Layout

- `apps/daemon` (`@aaroncx/monadd`, binary `monadd`): owns sessions, the event log, the
  permission policy, the ACP HTTP server, and the control API.
- `apps/cli` (`@aaroncx/monad`, binary `monad`): thin ACP client over HTTP; also provides
  `monad acp-stdio`, the bridge editors spawn.
- `packages/protocol` (`@aaroncx/protocol`): shared zod schemas, session and event types,
  control API types.
- `packages/engine` (`@aaroncx/engine`): sessions, event log, policy, transport adapter. The
  transport module is the only place allowed to import the SDK's experimental exports.
- `packages/backends` (`@aaroncx/backends`): ACP client adapter (M1); native AI SDK loop (M2+).
- `packages/checks` (`@aaroncx/checks`): placeholder in M1. The LastGate check engine port
  lands here in M2.
- `packages/github` (`@aaroncx/github`): placeholder in M1. The LastGate GitHub App port lands
  here in M3.

## Wire surface (M1)

One HTTP server on 127.0.0.1 (default port 7331), bearer token from `~/.monad/token` on
every request:

- `/acp`: the ACP agent side over the SDK's Streamable HTTP transport. Methods served:
  `initialize` (advertises `loadSession` and `sessionCapabilities.list`), `session/new`,
  `session/load`, `session/list`, `session/prompt`, `session/cancel`.
- `/v1/sessions`, `/v1/status`: the control API, plain JSON.

Attach semantics: `session/load` replays the log to the calling connection in seq order
(`update` events verbatim, `prompt` events as `user_message_chunk` updates), then the
connection is live-subscribed. The transport gives no cross-stream ordering between the load
response and the replayed notifications, so the response carries the replayed update count in
`_meta["monad.sh/replayCount"]` and clients count updates to find the replay/live boundary
(decision record 0004). A pending permission request is re-delivered to the attaching
connection; the first answer wins.

monad extensions on top of ACP, all under the `monad.sh` prefix: the `_meta` keys
`monad.sh/replayCount` (session/load response) and `monad.sh/status` (session/list entries),
plus the `_monad.sh/error` notification carrying appended error events (for example a failed
vendor context restore) to live clients. Unknown notifications are dropped by SDK-based
clients, so non-monad editors are unaffected.

Environment overrides: `MONAD_HOME` moves the state directory, `MONAD_BACKEND_CMD` swaps the
vendor agent command (integration tests run a fake ACP agent), `MONAD_DAEMON_BIN` tells the
CLI what to spawn for `monad daemon start`.

This document grows as code lands. Decision records live in `docs/decisions/`.
