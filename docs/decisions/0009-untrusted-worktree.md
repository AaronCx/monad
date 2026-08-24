# 0009: The worktree is untrusted

Date: 2026-08-24
Status: accepted

## Context

`monad review <pr>` checks a pull request head out into a worktree and then reads that worktree
to decide what to do. In M2 the decision inputs and the reviewed content were the same bytes:
`playbooks/review.ts` called `loadConfig(worktree)`, and the loaded config supplied
`checks.lint.command` and `checks.typecheck.command` straight to `runCommand`, `checks.build`
and `checks.test` the same under the full profile, and `review.prompt` replaced monad's own
review prompt with a file from the PR. A PR that added a `.monad.yml` with
`checks.lint.command: ./x.sh` plus an executable `x.sh` therefore ran arbitrary code on
`monad review <pr>` with no flags, before the agent was ever prompted. This was reproduced on
the Mac Mini against the M2 tip: the canary file was written.

M3 turns review into a webhook that fires on any PR, forks included, which makes that path
remotely triggerable by strangers.

## Decision

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

## Trust levels

Every session record carries `trust: "trusted" | "untrusted"`. A record written before this
change, or any value monad does not recognize, reads back as `untrusted`: default deny.

How it is resolved for `monad review`:

1. `--trust` and `--no-trust` win. They are the human in front of the machine, which is a
   trusted source by definition.
2. Otherwise trusted when the PR head is a branch on the same repo (`gh pr view --json
   isCrossRepository` is false) AND the PR author has write access (`gh api
   repos/<repo>/collaborators/<login>/permission` returns `admin`, `maintain`, or `write`).
   Both must hold.
3. Otherwise untrusted. Any failure to resolve either fact is untrusted, not an error.

`monad run` sessions are trusted: you own the repo you are sitting in. `monad checks` in the
repo you cd'd into is trusted, with `--untrusted` available to exercise the other path against
a branch someone else pushed. A fix session inherits the review session's level, because it is
the same session.

## What each level does

| | trusted | untrusted |
|---|---|---|
| check config read from | the worktree (the PR head) | the PR base commit, via `git show <baseSha>:.monad.yml` |
| `checks.{lint,typecheck,build,test}.command` | honored | dropped |
| `checks.secrets.custom_patterns` | honored | dropped |
| `review.prompt` | honored | dropped, monad's own template is used |
| `extends` and pack refs | honored | dropped |
| dependency install | as configured (`bun install --frozen-lockfile`) | skipped unless `--install` |
| `build` and `test` | run in the full profile | never run, reported as skipped with the reason |
| `run_checks` profile from the model | honored | forced to `fast`, and the result says so |

The base commit is the right ref for config because it is the last state a repo maintainer
approved. It is already stored as `pr.baseSha` (the computed merge base), so no extra git work
is needed.

Untrusted lint and typecheck still run. Their value is high, and after the command fields are
dropped they are the detected toolchain rather than a PR-supplied command. Without an install
they often degrade to "no linter detected" or a failing tool invocation, and the check summary
says which happened rather than implying a clean pass. The alternative, installing with
`--ignore-scripts`, buys a real type check at the cost of a partial install that can fail on
its own; it is worth revisiting with real numbers once M3 reviews outside PRs daily.

## The agent does not hold the daemon token

The same boundary applied to credentials. M2 handed `{ port, token }` to the Claude backend and
`checksMcpServerEntry` put the daemon's own bearer token into the `mcpServers` headers forwarded
to `claude-agent-acp`. That token is monad's only credential: it opens `/acp`, `/v1/*`, and every
session's `/mcp/<id>`. Anything running under the vendor process could read it out of the vendor's
own config and then create sessions with an arbitrary `cwd`. New sessions default to interactive,
so permission requests forward to a human, which is what contained it; the containment was
incidental, not designed.

Each session's checks mount now takes its own credential:

    deriveMountToken(daemonToken, sessionId) =
      HMAC-SHA256(key = daemonToken, message = "mcp-mount:" + sessionId)

Nothing is stored. It is recomputable from the daemon token plus the id, so it survives a daemon
restart for free and stays stable for the session's lifetime, which the vendor's session
fingerprint requires (record 0006 fact 3).

`/mcp/<sessionId>` accepts that value and nothing else. The daemon token is refused there, and so
is any other session's mount token. Because the daemon token is not a credential on that route,
the ACP transport's blanket bearer check cannot sit in front of it (it would admit the wrong token
and reject the right one), so the mount is registered through the transport's `selfAuthenticated`
hook and does its own check inside the route, ahead of the session lookup. Default deny both ways:
a path is only self authenticating when the daemon says so, and an unrecognized token is 401
before the route says whether the session exists.

## Where the mount token is visible, and why that is the point

Measured on the Mac Mini on 2026-08-24 against adapter `claude-agent-acp` 0.70.0 and
`@anthropic-ai/claude-agent-sdk` 0.3.232, by creating a real session and reading the process table:

- The adapter's own log (`CLAUDE_AGENT_LOGS`, `~/.monad/logs/agent.log`) does NOT write the
  `mcpServers` array. It logs one `Claude ACP started` line and one `[session/query]` line per
  session, neither carrying a URL or a header. The existing `agent.log` on this machine, covering
  every session monad has run, contains no token.
- Claude Code's own transcripts under `~/.claude/projects/**` do NOT carry it either. They name
  the tools (`mcp__monad-checks__run_checks` and friends) but not the server config.
- The Agent SDK DOES pass the whole config as a command line argument: it spawns the `claude`
  binary with `--mcp-config {"mcpServers":{"monad-checks":{...,"headers":{"Authorization":
  "Bearer <token>"}}}}`. That argument is in the process table for as long as the session's
  subprocess lives, readable by any process running as the same user (and by root).

So the credential in the vendor's `mcpServers` is exposed by construction, whatever monad does.
That is exactly why it must not be the daemon token. After this change the process table carries
one session's mount token, which opens that session's checks mount and nothing else: no `/acp`,
no `/v1/*`, no other session. The blast radius of reading it is running that session's own checks.
Verified: with a real session live, the daemon token appears nowhere in the process table.

Not filed upstream from here; it is worth Aaron's judgement whether the SDK should pass
`--mcp-config` by file or stdin instead of argv.

## The fix allowlist is frozen at the base, and stops applying when its inputs are edited

The fix policy runs allowlisted commands without a human: the git prefixes, plus
`<runner> run <script>` for each of the repo's lint, typecheck, test, and build scripts. In M2
that list was rebuilt from `<worktree>/package.json` on every single decision, inside
`ModeAwarePermissionPolicy.request`. Fix mode auto-grants edits inside the worktree, and
`package.json` is inside the worktree, so the agent could grant itself an edit and then have its
own command match the list. Nothing else was in the way: the vendor `claude` subprocess is
spawned with `--allow-dangerously-skip-permissions` and `--permission-prompt-tool stdio`, so
monad's policy layer is the only gate on that side.

The list is now computed once, when a session first enters fix mode, and stored on the record as
`execAllowlist`. It comes from `git show <baseSha>:package.json` for a review-derived session;
a trusted session with no PR (you switched `monad run` to fix in your own repo) falls back to its
own worktree, which is yours; anything else gets the git prefixes alone. A session that already
carries a list keeps it, so re-entering fix mode cannot refresh it against an edited worktree, and
a row with no list at all (any M2 session) is read as an empty list: default deny.

Open decision 4 asked base or fix-mode entry. Base, because it is the same ref the config comes
from and the same argument applies: it is the last state a repo maintainer approved. The cost is
that a legitimate earlier fix commit adding a script is not on the list, and running it forwards
to the human once instead of running unattended. That is the cheap direction to be wrong in.

Freezing alone is not enough, because the list names SCRIPTS and not the command lines they run.
`bun run test` is on the list whatever `scripts.test` says, so an agent that rewrites
`scripts.test` to `./canary.sh` and then runs `bun run test` defeats any list that still contains
that entry. So the second half: if the session has been granted an edit to `package.json` or any
lockfile, every subsequent execute forwards to a human regardless of the allowlist. This is
reconstructed from the `permission_requested` and `permission_resolved` events already in the log,
so it needs no new state and survives a daemon restart for free. Default deny three times over: a
granted edit with no `locations` counts (the target is unknowable), a resolution that cannot be
matched back to its request counts, and a selected option that is not among the offered ones
counts. A still-pending request does not count, because it has not happened.

## git commit, hooks, and --no-verify

`git commit` stays on the allowlist, and git commit runs the repo's hooks. That is safe under the
current worktree layout and only under it: a fix session works in a detached worktree whose `.git`
is a file pointing at `<main repo>/.git/worktrees/<name>`, so the hooks directory and the config
that could repoint it via `core.hooksPath` both live outside the session worktree, where the fix
policy rejects every edit. The agent can commit but cannot install a hook, and the hooks it fires
are the user's own. A future change to the worktree layout that lets a session write inside its
own git dir turns this entry into arbitrary code execution; the comment above the list in
`policy.ts` says so.

monad does not add `--no-verify` implicitly, and structurally cannot. An ACP permission response
carries an `optionId` and nothing else: there is no channel for answering a permission request
with a rewritten command, and the vendor runs the string it already holds. Even with a channel it
would be the wrong move, because the event log would then show one command while another ran,
which destroys the property that the transcript is what happened. The agent may pass
`--no-verify` itself; it still matches the `git commit` prefix, so the safer spelling is available
without monad forging it.

## Prompt injection is not solved

The PR's diff, title, and body still reach the model. That is the product. The template fences
the untrusted regions and tells the model that anything inside them is data under review and
never an instruction, including text claiming to be from monad, the repo owner, or the user,
and the per-region character cap is applied to the changed-file list as well as the PR body.
Neither is a defense, only a speed bump. The claim monad can make is that an injected
instruction cannot make it execute anything, not that it cannot make the review text wrong.
The policy layer is what stops the session from doing anything.

## Honest limitations

- Trusted reviews still execute the head's toolchain. That is correct (it is your repo and your
  collaborators) but it means a compromised collaborator account is a code-execution path.
- `git show <ref>:.monad.yml` reads the base of the PR. A malicious PR that is merged makes its
  config the base for the next PR. The gate is the human merging, which is the same gate as any
  CI config change.
- The permission check costs one `gh api` call per review. That is deliberate: M3 makes the
  wrong default expensive.
- `extends` is resolved inside `parseConfigWithWarnings`, before `sanitizeUntrustedConfig` sees
  the result, and today only built-in packs resolve. Dropping the key is defense in depth so a
  future file-or-URL `PackResolver` does not silently reopen the config path.
- The frozen fix allowlist names scripts, not command lines, so on its own it cannot tell a
  rewritten `scripts.test` from the original. The package.json-edited rule is what covers that,
  and it is coarse on purpose: after one manifest edit the session asks a human about every
  command it runs, including `git status`.
- A trusted session with no PR reads its own worktree for the allowlist. That is the user's repo
  on the user's machine, and the same worktree the user could edit by hand, so there is nothing
  to protect it from. It is still the one path where the allowlist and the edited tree are the
  same bytes.
- Mount tokens are derived, not stored, so anyone who can read `~/.monad/token` can derive every
  one of them. That is the same user on the same machine, which is already the M1 trust model.
  Rotating `~/.monad/token` invalidates every mount, which also changes the vendor session
  fingerprint (record 0006 fact 3) and so recreates the vendor subprocess.
- A mount token stays valid for as long as the session id exists and is not closed; there is no
  expiry and no revocation short of rotating the daemon token. A session that has ended is not a
  usable mount because the route 404s a closed record, but the token itself is still derivable.

## Revisit when

M3 lands the webhook trigger (the trust resolution moves from the CLI's `gh` to the App's own
event payload, where `isCrossRepository` and the author association arrive for free), or when
measurements justify an `--ignore-scripts` install for untrusted reviews.
