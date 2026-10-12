# Link acceptance run 3: spawn a child in a worktree, wait on it, read its result

**Result: PASS** (with backend claude-acp; codex-acp is not installed on this Mac).

Environment: this Mac (M4 Mac mini, macOS 26), 2026-10-12 (America/New_York), branch
`feat/link-4-import`, monadd/monad 0.1.0 built from the branch with `bun run build`
(`bunx turbo run build --force`), claude-agent-acp 0.70.0 (Claude Code 2.1.232 underneath),
`MONAD_HOME=/Users/acx/.monad-link` (never `~/.monad`), daemon on 127.0.0.1:7341. `m` below is
`/Users/acx/.monad-link-acceptance-work/m`, a two-line wrapper that exports
`MONAD_HOME=/Users/acx/.monad-link` and execs `apps/cli/dist/monad`. Build 1c5b03d.

## Backend choice

codex-acp is not available, so the child ran on claude-acp. Resolution order for `backend: "codex-acp"` (packages/backends/src/claude.ts) and what this Mac has:

- `MONAD_CODEX_CMD`: unset.
- `codex-acp` on PATH: not found (`which codex-acp`: not found).
- `$MONAD_HOME/vendor/node_modules/.bin/codex-acp`: absent (the vendor tree is a symlink to `~/.monad/vendor`, which has only claude-agent-acp; provisioning codex-acp there would write into Aaron's production monad state, which this run must not touch).
- Also observed: `/opt/homebrew/bin/codex` is a dangling symlink to a removed cask (`Caskroom/codex/0.94.0`); the Codex CLI is not installed either.

## Commands

~~~~~sh
cd /Users/acx/Developer/github/monad
m run -p "This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Users/acx/Developer/github/monad, worktree true, backend claude-acp, and this prompt for the child: 'Run the monad checks for this repository with the run_checks tool (the monad-checks MCP tool), then report each check's name and whether it passed or failed, and the overall result. Do not edit any files.' 2) Call sessions_wait on the child's id until it is idle (use the maximum timeout, and call it again if it times out while the child is still running). 3) Call sessions_read on the child to read its transcript and report the checks result it found: each check and pass/fail, and the overall result. Do not run the checks yourself." < /dev/null
m show 01a130a0-7972-7000-b973-7f23608a10da
m show 01a130a0-95cf-7000-93e1-c0158c802830
curl -H "Authorization: Bearer <daemon token>" "http://127.0.0.1:7341/v1/sessions?repo=/Users/acx/Developer/github/monad&limit=10"
m handoff 01a130a0-7972-7000-b973-7f23608a10da
~~~~~

Sessions: parent `01a130a0-7972-7000-b973-7f23608a10da` (cwd /Users/acx/Developer/github/monad), child `01a130a0-95cf-7000-93e1-c0158c802830` (cwd `/Users/acx/.monad-link/worktrees/987877441ec9/01a130a0-95cf-7000-93e1-c0158c802830`, a detached worktree of the monad repo at 1c5b03d).

## Parent: `monad show 01a130a0-7972-7000-b973-7f23608a10da` (includes the final answer)

~~~~~text
session 01a130a0-7972-7000-b973-7f23608a10da "This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Us"
[seq 31582] session created in /Users/acx/Developer/github/monad (interactive, claude-acp)
[seq 31584] user: This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Users/acx/Developer/github/monad, worktree true, backend claude-acp, and this prompt for the child: 'Run the monad checks for this repository with the run_checks tool (the monad-checks MCP tool), then report each check's name and whether it passed or failed, and the overall result. Do not edit any files.' 2) Call sessions_wait on the child's id until it is idle (use the maximum timeout, and call it again if it times out while the child is still running). 3) Call sessions_read on the child to read its transcript and report the checks result it found: each check and pass/fail, and the overall result. Do not run the checks yourself.
[seq 31587-31593] agent: I'll run the spawn-and-wait test. Let me load the tool schemas first.
[seq 31594] tool ToolSearch (other) -> completed
[seq 31602] tool mcp__monad-sessions__sessions_spawn (other) paths: /Users/acx/Developer/github/monad -> completed; permission: allow_once by policy:interactive
[seq 31613] access: 01a130a0-7972-7000-b973-7f23608a10da spawn (caller) target 01a130a0-95cf-7000-93e1-c0158c802830
[seq 31619-31625] agent: Spawned child `01a130a0-95cf-7000-93e1-c0158c802830` in a fresh worktree. Now waiting on it.
[seq 31626] tool mcp__monad-sessions__sessions_wait (other) -> completed; permission: allow_once by policy:interactive
[seq 31640] access: 01a130a0-7972-7000-b973-7f23608a10da wait (caller) target 01a130a0-95cf-7000-93e1-c0158c802830
[seq 31778] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31784] access: 01a130a0-7972-7000-b973-7f23608a10da read (caller) target 01a130a0-95cf-7000-93e1-c0158c802830
[seq 31789-31885] agent: Spawn-and-wait test passed end to end: spawn returned an id immediately, `sessions_wait` reached idle on the first call (no timeout, stop reason `end_turn`), and `sessions_read` returned the child's full transcript.

**Checks result the child reported** (run with `run_checks`, `profile: full`, in worktree `/Users/acx/.monad-link/worktrees/987877441ec9/01a130a0-...`):

| Check | Name | Result |
|---|---|---|
| secrets | Secret Scanner | warn - 25 high-entropy hits, all the session UUID `6f0c8a52-…` in `packages/link/test/fixtures/import/claude/…` |
| file_patterns | File Pattern Guard | pass |
| agent_patterns | Agent Behavior Patterns | warn - 1 pattern, "Config Churn" (2x package.json, tsconfig.json) |
| lint | Lint & Type Check | pass (biome, 77 files) |
| typecheck | Type Check | fail - `bun run typecheck` exited 127, `turbo: command not found` |
| dependencies | Dependency Auditor | fail - 15 advisories (CRITICAL `proxy-addr` GHSA-jqcg-44mw-7w3h; HIGH `@modelcontextprotocol/sdk` OAuth; HIGH x2 `fast-uri`; moderates in `hono`, `ip-address`, `qs`) |

**Overall: FAILED** - 2 passed, 2 warnings, 2 failures (`hasFailures: true`).

Two caveats the child flagged about its own run: `build` and `test` are disabled in `.monad.yml`, so the `full` profile ran the same six checks as `fast` (nothing built or tested), and the typecheck failure is an environment issue (`turbo` not on PATH in the checks runner) rather than a real type error.
[seq 31888] turn ended (end_turn)
~~~~~

## Child: `monad show 01a130a0-95cf-7000-93e1-c0158c802830`

~~~~~text
session 01a130a0-95cf-7000-93e1-c0158c802830 "Run the monad checks for this repository with the run_checks tool (the monad-che"
[seq 31610] session created in /Users/acx/.monad-link/worktrees/987877441ec9/01a130a0-95cf-7000-93e1-c0158c802830 (interactive, claude-acp)
[seq 31611] access: 01a130a0-7972-7000-b973-7f23608a10da spawn (target) target 01a130a0-95cf-7000-93e1-c0158c802830
[seq 31612] user (peer message, hop 1): [message from monad session 01a130a0-7972-7000-b973-7f23608a10da "This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Us", repo /Users/acx/Developer/github/monad]

Run the monad checks for this repository with the run_checks tool (the monad-checks MCP tool), then report each check's name and whether it passed or failed, and the overall result. Do not edit any files.
[seq 31628-31633] agent: I'll load the run_checks tool schema first.
[seq 31634] tool ToolSearch (other) -> completed
[seq 31641] access: 01a130a0-7972-7000-b973-7f23608a10da wait (target) target 01a130a0-95cf-7000-93e1-c0158c802830
[seq 31649] tool mcp__monad-checks__run_checks (other) -> completed; permission: allow_once by policy:interactive
[seq 31657] tool mcp__monad-checks__list_checks (other) -> completed; permission: allow_once by policy:interactive
[seq 31665-31770] agent: Ran `run_checks` with `profile: full`. No files edited.

| Check | Name | Result |
|---|---|---|
| secrets | Secret Scanner | ⚠️ warn - 25 potential secrets (all high-entropy-string hits on the session-UUID `6f0c8a52-…` inside `packages/link/test/fixtures/import/claude/…` test fixtures) |
| file_patterns | File Pattern Guard | ✅ pass |
| agent_patterns | Agent Behavior Patterns | ⚠️ warn - 1 pattern: "Config Churn" (3 config files touched: 2x package.json, tsconfig.json) |
| lint | Lint & Type Check | ✅ pass (biome, 77 files) |
| typecheck | Type Check | ❌ fail - `bun run typecheck` exited 127: `/bin/bash: turbo: command not found` |
| dependencies | Dependency Auditor | ❌ fail - 15 advisories, incl. CRITICAL `proxy-addr` IP spoofing (GHSA-jqcg-44mw-7w3h), HIGH `@modelcontextprotocol/sdk` OAuth, HIGH x2 `fast-uri`, plus moderates in `hono`, `ip-address`, `qs` |

**Overall: FAILED** - 2 passed, 2 warnings, 2 failures (`hasFailures: true`).

Two notes on the run itself:
- `build` and `test` are disabled in `.monad.yml`, so the `full` profile ran the same six checks as `fast`; nothing was built or tested.
- The typecheck failure is an environment problem, not a type error - `turbo` isn't on PATH in the checks runner, so the script never reached tsc.
[seq 31773] turn ended (end_turn)
[seq 31785] access: 01a130a0-7972-7000-b973-7f23608a10da read (target) target 01a130a0-95cf-7000-93e1-c0158c802830
~~~~~

## Records (`GET /v1/sessions`, selected fields)

~~~~~json
{
 "id": "01a130a0-7972-7000-b973-7f23608a10da",
 "parentId": null,
 "spawnDepth": null,
 "trust": "trusted",
 "mode": "interactive",
 "backend": "claude-acp",
 "cwd": "/Users/acx/Developer/github/monad",
 "status": "idle",
 "lastHandoff": null,
 "repos": null
}
{
 "id": "01a130a0-95cf-7000-93e1-c0158c802830",
 "parentId": "01a130a0-7972-7000-b973-7f23608a10da",
 "spawnDepth": 1,
 "trust": "trusted",
 "mode": "interactive",
 "backend": "claude-acp",
 "cwd": "/Users/acx/.monad-link/worktrees/987877441ec9/01a130a0-95cf-7000-93e1-c0158c802830",
 "status": "idle",
 "lastHandoff": null,
 "repos": null
}
~~~~~

## Parent's handoff (`monad handoff`), listing its child

~~~~~text
handoff 01a130a0-7972-7000-b973-7f23608a10da seq 31892 (manual)
handoff: last asked "This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Us..."; repos monad (feat/link-4-import, clean); 1 child

Session 01a130a0-7972-7000-b973-7f23608a10da "This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Us": idle, interactive, cwd /Users/acx/Developer/github/monad

## Last asks
1. This is a monad Link test of spawn and wait. 1) Call sessions_spawn with cwd /Users/acx/Developer/github/monad, worktree true, backend claude-acp, and this prompt for the child: 'Run the monad checks for this repository with the run_checks tool (the monad-checks MCP tool), then report each check's n...

## Repos
- /Users/acx/Developer/github/monad: branch feat/link-4-import, HEAD 1c5b03d91090, clean

## Files touched (last 1)
- /Users/acx/Developer/github/monad

## Spawned children
- 01a130a0-95cf-7000-93e1-c0158c802830 "Run the monad checks for this repository with the run_checks tool (the monad-che": idle
~~~~~

## Assessment

| criterion | result | evidence |
|---|---|---|
| backend recorded with the reason | PASS | claude-acp: codex-acp not installed (see above) |
| parent spawns with sessions_spawn, worktree true, cwd the monad repo | PASS | parent `[seq 31602] tool mcp__monad-sessions__sessions_spawn ... paths: /Users/acx/Developer/github/monad -> completed`; child cwd is `$MONAD_HOME/worktrees/987877441ec9/<child id>` |
| child runs the monad checks with run_checks and reports | PASS | child `[seq 31649] tool mcp__monad-checks__run_checks ... allow_once by policy:interactive`, then its table at seq 31665-31770 |
| parent waits with sessions_wait | PASS | parent `[seq 31626] tool mcp__monad-sessions__sessions_wait -> completed`, `[seq 31640] access ... wait (caller)`; child `[seq 31641] access ... wait (target)`; the wait returned after the child's `turn ended` at 31773 |
| parent reads the child with sessions_read and reports the checks result | PASS | parent `[seq 31778] sessions_read`, `[seq 31784] access ... read (caller)`; child `[seq 31785] access ... read (target)`; parent's answer reproduces the child's table and overall result |
| parent/child links on both records | PASS | child record `parentId: 01a130a0-7972-...`, `spawnDepth: 1`; parent's log `[seq 31613] access ... spawn (caller) target 01a130a0-95cf-...`; parent handoff "Spawned children: 01a130a0-95cf-... idle" |
| child's first turn is a peer turn with provenance | PASS | child `[seq 31612] user (peer message, hop 1): [message from monad session 01a130a0-7972-... repo /Users/acx/Developer/github/monad]` |
| access events | PASS | spawn, wait and read each on both logs (31613/31611, 31640/31641, 31784/31785) |

The checks result itself was "overall FAILED" (2 pass, 2 warn, 2 fail). That is the checks' verdict on the worktree, reported correctly, not a Link failure: `typecheck` failed with `turbo: command not found` because a spawned worktree has no `node_modules` (nothing installs dependencies in it), and `dependencies` failed on 15 advisories in the lockfile. The first is worth knowing: a spawned worktree child cannot typecheck this repo until something installs its dependencies.

**Run 3: PASS.**
