# monad

One daemon for agentic coding and PR review.

monad runs coding-agent sessions that outlive the client that started them. Open a session
from the CLI, an editor, or (later) a phone; attach to it from anywhere else. Review sessions
open from GitHub pull requests, run diff-scoped checks, and are the same sessions you talk to
when something fails.

**Status: pre-alpha. Milestones 1 and 2 landed.** M1: `monadd` + `monad` (run, attach, ls,
acp-stdio), Claude via `claude-agent-acp`, sessions persisted in SQLite. M2: the deterministic
check engine in `packages/checks`, served to every session as the `monad-checks` MCP server;
git worktrees; `monad review <pr>` and `monad checks`. Interfaces and storage are still
unstable, there are no packaged releases yet (build from source with `bun run build`), and
everything past M2 on the roadmap does not exist. See `docs/architecture.md`.

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
as a detached `git worktree` under `~/.monad/worktrees`, installs the worktree's dependencies,
and runs the checks scoped to the `base..head` diff. It then opens a review session in that
worktree with the `monad-checks` tools injected, and parses the agent's final report into a
structured `ReviewReport` (summary, verdict, findings with `path:line` and severity). The exit
code follows the verdict: 0 when the verdict is `looks_good` or `comment` and no check failed,
1 otherwise.

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
posts nothing. monad never posts `APPROVE` or `REQUEST_CHANGES`; a review that carries a
verdict for you belongs to the GitHub App in M3.

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

- Review quality is the agent's. monad scopes the diff, runs the deterministic checks, shapes
  the prompt, and enforces policy; the judgment in the report is the model's, and the report is
  only structured when the agent ends its message with the contracted json block. Parse failures
  are printed, not hidden, and are not retried.
- `lint`, `typecheck`, `build`, and `test` need the repo's dependencies installed. Without them
  the underlying command fails, and a failing command is a failing check, not a skipped one.
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
  for a shared one; the M3 App replaces it.

## Roadmap

1. M1 (landed): daemon, CLI (`run`, `attach`, `ls`), Claude via `claude-agent-acp`, stdio bridge for Zed
2. M2 (landed): checks as tools (secrets, file patterns, lint, typecheck, dependencies, agent
   patterns, build, test), worktrees, `monad review <pr>` and `monad checks` run locally, opt-in
   `--post` COMMENT reviews
3. M3: GitHub App trigger, Check Runs and review comments
4. M4: Codex and Gemini backends, native loop for API-key and self-hosted models
5. Later: desktop (Tauri sidecar), web, phone attach

## Lineage

monad replaces [Forge](https://github.com/AaronCx/Forge) (its provider-neutral agent loop and
test suite are the engine spec) and [LastGate](https://github.com/AaronCx/LastGate) (its check
engine is ported into `packages/checks`; its GitHub App plumbing lands in M3). Both repos are
archived.

## License

MIT
