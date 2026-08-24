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
