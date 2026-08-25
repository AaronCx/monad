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

The GitHub App is a third boundary, and the thinnest one on purpose. After M3 the trigger is a
stranger's push rather than a command Aaron typed, which is what makes everything above
load-bearing rather than a safety net. The App is a trigger and a renderer: it verifies an HMAC
signature over the raw body, narrows the payload to a named zod shape and refuses anything else,
reads `trusted` or `untrusted` out of the fields GitHub signed, and turns a finished
`CheckRunResults` and `ReviewReport` into GitHub's API shapes. It runs no check, holds no policy,
and never decides what a session may execute. `packages/github` does not import from `apps/`, and
a check or a policy added to it is in the wrong package.

Trust for a webhook-triggered review is untrusted unless the signed payload proves otherwise, and
the proof is two facts that must both hold: the head is a branch on the base repository itself,
and the author's `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`. There is no
fallback lookup that could widen the answer. Two deliveries carry no pull request at all (a
`check_run` rerequest and an `@monad review` comment); for those the App reads the pull request
back through the installation token and resolves again, as an explicit second step in
`apps/hook`, not as a fallback hidden inside the resolver. The daemon is told the level; it never
re-derives it, because it holds no GitHub credentials and has no reason to.

The App's permission set is the other half of that boundary. Checks read and write, Pull requests
read and write, Contents READ, Metadata read, Issues read and write, and nothing else: no
Contents write, no Workflows, no Administration, no Secrets. `@monad fix` runs unattended, and
the M2 policy forwards a command it cannot decide (`git push` above all) to the attached human.
`monad-hook` answers no permission request at all, so that request is held rather than answered
by a program, and the token it holds could not push even if it were. Decision records 0010 and
0011 have the rest.

The vendor agent is a second boundary. It runs monad's prompt but it is a process monad does not
control, and whatever monad puts in its `mcpServers` config is exposed by construction: the
Agent SDK passes that config to the `claude` binary as a command line argument, so it sits in
the process table. The vendor therefore never holds the daemon token. Each session's checks
mount takes a token derived for that session alone, so reading it buys running that session's
own checks and nothing else. Decision record 0009 has the derivation and the measurements.

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
- `packages/checks` (`@aaroncx/checks`): the LastGate check engine port (M2). Also owns
  `resolveTool`, the one place that decides where a check's binary comes from per trust level.
- `packages/github` (`@aaroncx/github`): the GitHub side (M3). Signature verification, App auth
  with a per-installation token cache, zod narrowing of webhook payloads, payload-derived trust,
  Check Runs with annotation paging, and the shared review-post code the CLI and the App both
  call. It must not import from `apps/`.
- `apps/hook` (`@aaroncx/monad-hook`, binary `monad-hook`): the webhook receiver (M3). Separate
  from the daemon because it is long running and network facing and a crash here must not take
  live sessions down. It owns the `hook_deliveries` table in the daemon's database and nothing
  else in it.

## Wire surface (M1)

One HTTP server on 127.0.0.1 (default port 7331), bearer token from `~/.monad/token` on
every request:

- `/acp`: the ACP agent side over the SDK's Streamable HTTP transport. Methods served:
  `initialize` (advertises `loadSession` and `sessionCapabilities.list`), `session/new`,
  `session/load`, `session/list`, `session/prompt`, `session/cancel`.
- `/v1/sessions`, `/v1/status`: the control API, plain JSON.
- `/v1/review`, `/v1/sessions/<id>/mode`, `/v1/sessions/<id>/cancel` (POST): opening a review,
  switching a session's mode, and cancelling an in-flight turn. `cancel` exists for the App:
  when a new commit supersedes a running review, the App cancels that session, and it has no ACP
  connection with the session loaded to do it over.
- `/mcp/<sessionId>` (M2): that session's monad-checks tools over Streamable HTTP. This is the
  one route the daemon token does NOT open. It takes only that session's derived mount token,
  `HMAC-SHA256(daemonToken, "mcp-mount:" + sessionId)`, because the credential is handed to the
  vendor agent and must not be monad's master one (decision record 0009).

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
`monad.sh/replayCount` (session/load response) and `monad.sh/status` (session/list entries),
plus the `_monad.sh/error` notification carrying appended error events (for example a failed
vendor context restore) to live clients. Unknown notifications are dropped by SDK-based
clients, so non-monad editors are unaffected.

`monad-hook` is a second server, on 127.0.0.1 port 7332 by default, with two routes:
`POST /webhook` and `GET /healthz`. It has no bearer token, because its authentication is the
HMAC signature GitHub puts on the raw body, and whatever exposes it to the internet (a smee
channel, a Tailscale funnel, a Cloudflare tunnel) terminates TLS somewhere that is not monad.
That signature is the only thing between the internet and a review run. See `docs/github-app.md`.

Environment overrides: `MONAD_HOME` moves the state directory, `MONAD_BACKEND_CMD` swaps the
vendor agent command (integration tests run a fake ACP agent), `MONAD_DAEMON_BIN` tells the
CLI what to spawn for `monad daemon start`. `monad-hook` reads `MONAD_GITHUB_APP_ID`,
`MONAD_GITHUB_PRIVATE_KEY_PATH`, and `MONAD_WEBHOOK_SECRET` as overrides for
`~/.monad/github.json`.

This document grows as code lands. Decision records live in `docs/decisions/`.
