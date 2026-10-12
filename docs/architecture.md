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

## Trust boundaries

The worktree is untrusted. Everything in it (source, `.monad.yml`, `package.json`, lockfiles,
prompt templates) is attacker-controlled content in exactly the case monad exists to serve:
reviewing a pull request written by someone else, or by an agent. Content from the worktree may
be read, diffed, scanned, and shown to a model. It may never decide what monad executes, what
monad's own prompt says, or what a policy permits. Anything that decides comes from a trusted
source: the base commit, `~/.monad`, or the human running the command.

Two things violate this by nature and are handled explicitly rather than pretended away:
installing dependencies runs the PR's lifecycle scripts, and running lint, typecheck, build, or
test runs the PR's toolchain. Both are opt-in per trust level, never the default for a PR from
outside the repo.

"What monad executes" includes how it DECIDES what to execute. Stripping the config's `command`
fields is not sufficient on its own, because `lint` and `typecheck` also detect their tool by
reading the worktree, and a detected `bun run typecheck` runs whatever the PR put in
`scripts.typecheck`. An untrusted run therefore uses only detections where monad wrote the
command line and the tool's configuration format cannot carry code. Decision record 0009 has
the table.

Every session therefore carries a trust level, `trusted` or `untrusted`, resolved by the caller
and stored on the session record. An absent or unrecognized value is `untrusted`. Decision
record 0009 has the resolution rules and what each level allows.

The same rule governs the fix policy's execute allowlist. It is derived from `package.json`,
which lives in the worktree the fix session is editing, so it is computed once when the session
enters fix mode, read from the PR base commit, and frozen on the session record. Nothing
recomputes it from the worktree afterwards, and once the session has been granted an edit to
`package.json` or a lockfile every execute forwards to a human whatever the frozen list says.
Decision record 0009 has the reasoning.

The vendor agent is a second boundary. It runs monad's prompt but it is a process monad does not
control, and whatever monad puts in its `mcpServers` config is exposed by construction: the
Agent SDK passes that config to the `claude` binary as a command line argument, so it sits in
the process table. The vendor therefore never holds the daemon token. Each session's checks
mount takes a token derived for that session alone, so reading it buys running that session's
own checks and nothing else. Decision record 0009 has the derivation and the measurements.

monad Link makes sessions readers of each other, so prompt injection would become an
exfiltration path if the boundary were left to prompts. It is the daemon's: only a trusted
session is handed the monad-sessions mount (an untrusted one has no entry at all), review and
fix sessions get read-only tools, everything returned is redacted and fenced as quoted history,
a peer message is only ever a prompt (it can never answer a permission or change a mode), and
every cross-session access is an event on both sessions' logs. The on-demand summary is written
by a separate session that is untrusted (so it has no Link mount) and read-only, and Link never
returns that summarizer session to another session. Decision record
0012 has the trust table and the peer rules.

## Persistence

Sessions persist as an append-only event log in SQLite (one file under `~/.monad`, WAL mode).
Attaching to a session is a replay of its log plus a live subscription to new events. The
event log is monad's own source of truth: the ACP HTTP transport does not replay messages a
disconnected client missed, so the daemon does.

monad Link derives three things from the log, in the same transaction as every append: an
SQLite FTS5 full-text index (prompts, agent text coalesced per turn, tool call titles and paths,
errors; every row carries its session id and seq range, and all text is passed through the
secrets redactor before it is written), the repositories each session touched (resolved from
tool call paths to their git toplevel, never guessed from the launch directory alone), and the
session title (the first prompt's first line, or one set by hand). All three are rebuildable
from the log: `index_state` records how far each session is indexed, and a database that is
behind (or older than the index generation in `PRAGMA user_version`) is caught up at open
through the same code path.

Sessions also leave a `handoff` event behind (Link phase 3): a deterministic, model-free account
of where the session stands (last asks, files and repos touched with their git state, held
permissions, errors, spawned children), written ten minutes into every idle stretch, just before
close, and on request; the daemon catches up missed ones at start. A `summary` event, written by
a model, exists only when someone asks for one. Repo notes are JSONL files under
`~/.monad/notes`, one per repository, never in a worktree. Decision record 0012 has the rules.

Link phase 4 imports history monad did not run: Aaron's own Claude Code logs
(`~/.claude/projects`, subagents as child sessions) and Codex logs (`~/.codex/sessions`), read in
place, never written, into sessions with backend `import:claude-code` or `import:codex` and status
`imported`. Their events are what a live session would have logged, keep the log's timestamps, and
go through the same append path, so the index, repo tags and titles treat them like any other
session. The `imports` table records how far each file has been read (byte offset, lines, size,
mtime, inode, a hash of the read prefix) in the same transaction as the events, so re-import is
incremental and idempotent, and a truncated or replaced file is read again from the start. An
imported session is read-only: it is searched, read and listed, never attached, prompted, switched,
cancelled, closed or messaged. Decision record 0012 has the details.

## Layout

- `apps/daemon` (`@aaroncx/monadd`, binary `monadd`): owns sessions, the event log, the
  permission policy, the ACP HTTP server, and the control API.
- `apps/cli` (`@aaroncx/monad`, binary `monad`): thin ACP client over HTTP; also provides
  `monad acp-stdio`, the bridge editors spawn.
- `packages/protocol` (`@aaroncx/protocol`): shared zod schemas, session and event types,
  control API types.
- `packages/engine` (`@aaroncx/engine`): sessions, event log, policy, transport adapter. The
  transport module is the only place allowed to import the SDK's experimental exports.
- `packages/backends` (`@aaroncx/backends`): ACP client adapter for claude-agent-acp and
  codex-acp, and the one builder of the mcpServers array each vendor session is handed.
- `packages/link` (`@aaroncx/link`): monad Link. LinkService (list, search, read, message, spawn,
  wait, summarize, repo notes, handoffs), the handoff builder and its idle/close scheduler, the
  notes store, the normalized transcript, quoting and redaction of results, the link.json loader,
  the monad-sessions MCP server, and the Claude Code and Codex log importers with their opt-in
  watcher (decision record 0012).
- `packages/checks` (`@aaroncx/checks`): placeholder in M1. The LastGate check engine port
  lands here in M2.
- `packages/github` (`@aaroncx/github`): placeholder in M1. The LastGate GitHub App port lands
  here in M3.

## Wire surface

One HTTP server on 127.0.0.1 (default port 7331), bearer token from `~/.monad/token` on
every request:

- `/acp`: the ACP agent side over the SDK's Streamable HTTP transport. Methods served:
  `initialize` (advertises `loadSession` and `sessionCapabilities.list`), `session/new`,
  `session/load`, `session/list`, `session/prompt`, `session/cancel`. `session/list` omits
  imported sessions, and `session/load` and `session/prompt` refuse one (Link phase 4).
- `/v1/sessions`, `/v1/status`: the control API, plain JSON.
- `PATCH /v1/sessions/<id>` (Link): `{ "title": "..." }` sets a manual title that prompt
  derivation never overwrites; `{ "title": null }` re-derives it from the first prompt.
  `session/list` over ACP carries the title in `SessionInfo.title`.
- `/mcp/<sessionId>` (M2): that session's monad-checks tools over Streamable HTTP. The daemon
  token does NOT open it. It takes only that session's derived mount token,
  `HMAC-SHA256(daemonToken, "mcp-mount:" + sessionId)`, because the credential is handed to the
  vendor agent and must not be monad's master one (decision record 0009).
- `/mcp-sessions/<sessionId>` (Link): that session's monad-sessions tools (sessions_list,
  sessions_search, sessions_read, sessions_message, sessions_spawn, sessions_wait,
  sessions_summarize, notes_read, notes_append) over Streamable HTTP, offered per the trust table
  in decision record 0012. Its own derived token,
  `HMAC-SHA256(daemonToken, "sessions-mount:" + sessionId)`: the daemon token, the checks mount
  token and other sessions' tokens are all 401. A session Link may not reach (untrusted, Link
  disabled, out of link.json's scope) is 403 even with the right token; a closed or imported one
  is 404.
- `GET /v1/sessions?repo=&status=&since=&limit=&imported=` (Link): with any of these filters,
  the sessions that match, most recently active first, plus the repos each touched; with none,
  every session oldest first as before. Either way `handoffs` maps each session to its last
  handoff's first line.
- `GET /v1/search?q=&repo=&since=&limit=` (Link): full-text hits with session id, seq range and
  a redacted snippet.
- `GET /v1/sessions/<id>/transcript?from=&limit=` (Link): one page of the normalized, redacted
  transcript and where the next page starts.
- `POST /v1/sessions/<id>/messages` (Link): `{ "text": "..." }` sends a peer message from the
  human; it starts the session's next turn, or is queued for its next turn boundary.
- `POST /v1/sessions/<id>/handoff` (Link): `{}` writes a deterministic handoff now and returns
  it; `{ "summarize": true }` also runs the model-written summary and waits for it.
- `GET /v1/notes?repo=P`, `POST /v1/notes { "repo": P, "text": "..." }` (Link): a repository's
  notes, oldest first, or one more, written as the human.
- `POST /v1/import { "paths"?: [P, ...] }` (Link phase 4): one import run over the configured
  roots (`~/.claude/projects`, `~/.codex/sessions`, link.json `import.roots`), or over the given
  files and directories only. Answers with the run's summary (files scanned and unchanged,
  sessions created, updated and re-read from the start, events appended, malformed lines, and
  each skipped file with the reason); 409 when link.json has `import.enabled: false`. The mode
  route (`POST /v1/sessions/<id>/mode`) and peer messages answer 409 for an imported session.

  The Link routes run the same LinkService the MCP server does, with the human as the caller,
  and every read they make is an access event on the session read.

Attach semantics: `session/load` replays the log to the calling connection in seq order
(`update` events verbatim, `prompt` events as `user_message_chunk` updates), then the
connection is live-subscribed. The transport gives no cross-stream ordering between the load
response and the replayed notifications, so the response carries the replayed update count in
`_meta["monad.sh/replayCount"]` and clients count updates to find the replay/live boundary
(decision record 0004). Every pending permission request is re-delivered to the attaching
connection, oldest first, and the CLI asks them one at a time; the first answer wins per
request. A session holds many at once, keyed by tool call id, because the agent issues tool
calls in parallel: two forwarded permissions inside one turn is normal, and the session stays
`waiting_for_permission` until the last of them is answered. A request that arrives without a
tool call id is held under a synthetic one rather than dropped, and that id is what its
resolution carries in the log.

monad extensions on top of ACP, all under the `monad.sh` prefix: the `_meta` keys
`monad.sh/replayCount` (session/load response), `monad.sh/status` (session/list entries) and
`monad.sh/peer` (on a prompt a peer message delivered: `{ messageId, from, hop }`), plus three
notifications to live clients: `_monad.sh/error` carrying appended error events (for example a
failed vendor context restore), and `_monad.sh/peer_message` and `_monad.sh/access` carrying
Link's peer_message and access events (decision record 0012). All three are sent on replay too
and none counts toward the replay divider. Unknown notifications are dropped by SDK-based
clients, so non-monad editors are unaffected.

Environment overrides: `MONAD_HOME` moves the state directory, `MONAD_BACKEND_CMD` swaps the
vendor agent command (integration tests run a fake ACP agent), `MONAD_CODEX_CMD` names the
codex-acp command line for Link spawns that ask for it, `MONAD_DAEMON_BIN` tells the CLI what
to spawn for `monad daemon start`, `MONAD_HANDOFF_IDLE_MS` replaces the ten-minute idle window
before a session's handoff (tests). `~/.monad/link.json` scopes Link (enabled, a repo allowlist,
limits) and the importer (`import.enabled`, `import.watch` for the watcher in monadd, extra
`import.roots`); absent means every trusted session on this daemon, imports on demand only. The
importer's default roots are under the daemon's `HOME`.

This document grows as code lands. Decision records live in `docs/decisions/`.
