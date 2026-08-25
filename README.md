# monad

One daemon for agentic coding and PR review.

monad runs coding-agent sessions that outlive the client that started them. Open a session
from the CLI, an editor, or (later) a phone; attach to it from anywhere else. Review sessions
open from GitHub pull requests, run diff-scoped checks, and are the same sessions you talk to
when something fails.

**Status: pre-alpha. Milestones 1, 2, and 3 landed.** M1: `monadd` + `monad` (run, attach, ls,
acp-stdio), Claude via `claude-agent-acp`, sessions persisted in SQLite. M2: the deterministic
check engine in `packages/checks`, served to every session as the `monad-checks` MCP server;
git worktrees; `monad review <pr>` and `monad checks`. M3: `packages/github` and `monad-hook`,
the GitHub App trigger. The App exists and is tested end to end against a real daemon; it is not
deployed anywhere, and registering one is a manual step documented in `docs/github-app.md`.
Interfaces and storage are still unstable, there are no packaged releases yet (build from source
with `bun run build`), and everything past M3 on the roadmap does not exist. See
`docs/architecture.md`.

## How it works

- The daemon (`monadd`) speaks the [Agent Client Protocol](https://agentclientprotocol.com) on
  both sides. Toward vendor agents it is an ACP client, spawning one agent process per session
  (`claude-agent-acp` today; `codex-acp` and Gemini CLI are M4). Toward its own clients it is
  an ACP agent over HTTP.
- Sessions are an append-only event log in SQLite. Attaching is a replay plus a live subscription.
- Vendor auth stays inside the vendor binaries. monad never stores or forwards an API token for
  subscription-backed agents. API keys and self-hosted models go through a native loop (M4).
- Local-first: one SQLite file under `~/.monad`, loopback only, zero telemetry, MIT.

## Reviewing a pull request

```
monad review <pr> [--full] [--post] [--fix] [--no-install]
```

`monad review` fetches the PR head into the namespaced ref `refs/monad/pr/<n>`, checks it out
as a detached `git worktree` under `~/.monad/worktrees`, installs the worktree's dependencies
when the PR is trusted, and runs the checks scoped to the `base..head` diff. It then opens a
review session in that worktree with the `monad-checks` tools injected, and parses the agent's
final report into a structured `ReviewReport` (summary, verdict, findings with `path:line` and
severity). The exit code follows the verdict: 0 when the verdict is `looks_good` or `comment`
and no check failed, 1 otherwise.

### Trusted and untrusted PRs

The worktree is untrusted (decision record 0009). A PR is trusted only when its head is a
branch on the repo itself and its author has write access; `--trust` and `--no-trust` decide it
by hand. Everything else, including any doubt, is untrusted, and an untrusted review:

- reads `.monad.yml` from the PR base, not the PR head, so the PR cannot change the rules that
  judge it, and drops the config fields that decide what runs (`command` on every check,
  `checks.secrets.custom_patterns`, `review.prompt`, `extends`);
- installs nothing, because installing runs the PR's own lifecycle scripts. `--install` does it
  anyway, knowingly, and says so;
- never runs `build` or `test`, whatever the profile or the agent asks for, and pins the agent's
  `run_checks` calls to the fast profile;
- still runs `secrets`, `file_patterns`, `dependencies`, `agent_patterns`, and the detected
  `lint` and `typecheck`, which report honestly when there were no dependencies to work with.
  Detection is bounded the same way: an untrusted run will not use a checker the PR could point
  at its own code, so no `bun run typecheck`, no `mypy`, and no `eslint`.

A trusted review behaves exactly as it did before: the head's config, a real install, and the
head's toolchain.

Your own checkout is never modified. Everything the review does happens in the worktree; the
only writes to the main repo are the `refs/monad/pr/*` refs, git's own worktree bookkeeping,
and the remote-tracking ref the base-branch fetch updates.

The session stays open in `review` mode, which is read-only: the vendor runs in plan mode and
monad's own policy rejects edits and shell commands on top of it. `monad attach <id> --mode fix`
switches it to `fix`, where edits are allowed inside the worktree, commits land on a
`monad/fix/pr-<n>-<sha>` branch created on the first edit, and anything else (`git push`
included) is forwarded to you as a permission prompt. No policy ever grants a permission
permanently; only a human can.

`monad ls` shows each session's mode and PR number. `monad gc [--older-than 7d]` removes the
worktrees of closed sessions; event logs are never deleted.

### Posting a review

`--post` is opt-in and posts exactly one `COMMENT` review through your own `gh` auth. Findings
that anchor to an added or context line of the diff become inline comments; the rest go in the
review body next to the summary and the checks table. Re-running against the same head sha
posts nothing. monad never posts `APPROVE` or `REQUEST_CHANGES`. The anchoring, the body, the
payload, and the same-head check all live in `packages/github`, shared with the App; the only
difference is the transport, `gh` here and an installation token there.

## The GitHub App

M3 makes the review fire by itself. A GitHub App receives pull request webhooks, `monad-hook`
verifies and queues each delivery, `monadd` runs the same review session `monad review` runs,
and the result comes back as a Check Run named `monad` with annotations plus one `COMMENT`
review with inline comments. Replying `@monad fix <instruction>` on the pull request is how you
reach fix mode. Full setup, exposure choices, and troubleshooting are in `docs/github-app.md`.

The App is a trigger and a renderer. It reads the payload GitHub signed, resolves trust from it,
and renders a report the engine already produced. Every decision about what runs and what is
permitted stays in `packages/engine` and `packages/checks` (decision records 0009, 0010, 0011).

### The permission set

Repository permissions: **Checks** read and write, **Pull requests** read and write,
**Contents** READ, **Metadata** read, **Issues** read and write. Subscribed events: **Pull
request**, **Issue comment**, **Check run**.

Not requested: **Contents write, Workflows, Administration, Secrets.** Write access to code is
the permission the product does not need and must not hold. Everything monad produces is
commentary. `@monad fix` writes into a detached worktree on the machine running the daemon and
commits there; it never pushes, and it cannot: the token has no scope for it, and `monad-hook`
answers no permission request, so the fix policy's forwarded `git push` is held for whoever runs
`monad attach <id>`.

```
monad-hook --smee https://smee.io/<channel>     # no inbound port, the default
monad-hook --port 7332                          # behind a Tailscale funnel or a Cloudflare tunnel
```

Whatever exposes it terminates TLS somewhere that is not monad. The HMAC signature over the raw
body is the only thing between the internet and a review run.

## Checks

```
monad checks [--staged | --base <ref>] [--only a,b] [--full] [--json]
```

`monad checks` runs the same engine in the current repo with no session and no daemon, and
exits 1 on any failing check. It is the LastGate CLI replacement and the pre-commit hook entry
point. Config is `.monad.yml`, falling back to `.lastgate.yml` with a rename notice; unknown
and removed keys warn by name rather than being silently dropped. See `docs/checks.md` for the
hook recipe, what non-JS repos get, and the extension points for new linters and type checkers.

The same functions reach the agent as the `monad-checks` MCP server, injected into every
session (interactive ones too), so "run the checks" is a tool call rather than a shell command.

## Honest limitations

- monad's review reads attacker-controlled text: the diff, the PR title, and the PR body all
  reach the model, because that is the product. A sufficiently clever PR can therefore influence
  what the review SAYS. The prompt fences those regions and tells the model they are data under
  review rather than instructions, but that is a speed bump, not a defense. What stops a PR from
  making monad DO anything is the policy layer plus the trust boundary above: an untrusted PR
  cannot supply a command, a prompt, or an install.
- Review quality is the agent's. monad scopes the diff, runs the deterministic checks, shapes
  the prompt, and enforces policy; the judgment in the report is the model's, and the report is
  only structured when the agent ends its message with the contracted json block. Parse failures
  are printed, not hidden, and are not retried.
- `lint`, `typecheck`, `build`, and `test` need the repo's dependencies installed. Without them
  the underlying command fails, and a failing command is a failing check, not a skipped one.
  An untrusted PR is reviewed without an install on purpose, so its `lint` and `typecheck` are
  worth less than a trusted PR's. That is the deliberate trade: no type check is cheaper than
  executing a stranger's code to get one.
- A trusted review still executes the head's toolchain, which is correct for your own repo and
  your collaborators, and means a compromised collaborator account is a code-execution path.
- Every review worktree gets its own real `bun install --frozen-lockfile` (about 0.1 s with a
  warm cache, and clonefile-backed on APFS). Sharing the main checkout's `node_modules` by
  symlink is never done: it breaks bun's isolated linker and can make the worktree resolve the
  main checkout's sources instead of the code under review. Decision record 0008 has the
  numbers. The cost is a real install per worktree, and a cold cache is slower.
- Checks that read the diff itself (`secrets`, `file_patterns`, `dependencies`,
  `agent_patterns`) work in any repo. The tool-driven ones cover what is detected: `lint` covers
  biome, eslint, ruff, and swiftlint; `typecheck` covers a package script, `tsc`, pyright, and
  mypy. A Swift repo gets secrets, file patterns, dependency review, agent patterns, and
  swiftlint, and nothing else.
- `--post` ties a review to your own GitHub identity. That is right for a local tool and wrong
  for a shared one; the App posts as the bot instead. Both are kept: `--post` works without the
  App installed and it is the phone path.
- The Mac Mini is the App's deployment. A tunnel plus a laptop-class machine reviewing public
  pull requests is fine for your own repos and is not a hosted product; nothing here is
  multi-tenant.
- Reviews cost vendor tokens and every fork pull request is someone else spending them. There is
  no rate limit in M3 beyond the concurrency cap of 2, and `@monad review` from a stranger is a
  valid trigger. A per-repository daily cap is the fix the first time it matters.
- Untrusted lint and typecheck resolve their binary from `PATH` only, never from the worktree,
  because a pull request can commit `node_modules/.bin/biome`. On this machine none of `biome`,
  `tsc`, `ruff`, `swiftlint`, or `pyright` is on `PATH` (they are all repo-local
  devDependencies), so today an untrusted review here skips lint and typecheck entirely and says
  so. A monad-owned toolchain directory on the daemon's `PATH` turns them back on.
- Check Run annotations cap at 50 per request; monad pages them and stops at 200, saying so in
  the summary. A very noisy diff is truncated.
- Prompt injection through the diff is unchanged from M2. The App widens who can attempt it from
  "pull requests you chose to review" to "anyone who can open a pull request". The containment is
  the policy layer and the untrusted default, which is why the hardening in decision record 0009
  had to land first.

## Roadmap

1. M1 (landed): daemon, CLI (`run`, `attach`, `ls`), Claude via `claude-agent-acp`, stdio bridge for Zed
2. M2 (landed): checks as tools (secrets, file patterns, lint, typecheck, dependencies, agent
   patterns, build, test), worktrees, `monad review <pr>` and `monad checks` run locally, opt-in
   `--post` COMMENT reviews
3. M3 (landed, not deployed): GitHub App trigger. `monad-hook` verifies deliveries, queues them
   in SQLite with the delivery id as the idempotency key, supersedes in-flight reviews per PR,
   and drives `monadd`; results come back as a Check Run with annotations plus one `COMMENT`
   review with inline comments, with `@monad review`/`fix`/`status` gated on
   `author_association`
4. M4: Codex and Gemini backends, native loop for API-key and self-hosted models
5. Later: desktop (Tauri sidecar), web, phone attach

## Lineage

monad replaces [Forge](https://github.com/AaronCx/Forge) (its provider-neutral agent loop and
test suite are the engine spec) and [LastGate](https://github.com/AaronCx/LastGate) (its check
engine is ported into `packages/checks` and its GitHub App plumbing into `packages/github`). Both
repos are archived.

## License

MIT
