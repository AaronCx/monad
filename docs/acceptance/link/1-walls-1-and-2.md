# Link acceptance run 1: walls 1 and 2 (import, then find the meshyy scrolling history)

**Result: FAIL.** Twelve attempts. Link itself now does its part: search ranks session `096c02c8` first for the question, `sessions_read` reads it, `monad ls --repo meshyy --all` lists it, and its log records the asking session's access. But no attempt met every criterion: the one attempt that read `096c02c8` (attempt 9) read only the range of the fourth report and answered without the four reports or the deferred items named to Aaron; attempts 6, 8, 10, 11 and 12 gave a substantively correct answer but took it from a digest session (`f1b92b09`) instead of reading `096c02c8`. Attempts 10-12 ran on 94ebaa0, which lets `sessions_search` search inside one session (`session_id`) so a model that found the right long session can locate every relevant region; none of them used it on `096c02c8` (see [Attempts 10-12](#attempts-10-12-build-94ebaa0-sessions_search-session_id)). Two monad bugs were found and fixed on the way (64ce2bb, 1c5b03d), on top of the two the previous operator fixed (1bad1d4, 2837aae); attempts 10-12 found no monad bug.
Environment: this Mac (M4 Mac mini, macOS 26), 2026-10-12 (America/New_York), branch
`feat/link-4-import`, monadd/monad 0.1.0 built from the branch with `bun run build`
(`bunx turbo run build --force`), claude-agent-acp 0.70.0 (Claude Code 2.1.232 underneath),
`MONAD_HOME=/Users/acx/.monad-link` (never `~/.monad`), daemon on 127.0.0.1:7341. `m` below is
`/Users/acx/.monad-link-acceptance-work/m`, a two-line wrapper that exports
`MONAD_HOME=/Users/acx/.monad-link` and execs `apps/cli/dist/monad`.
Ground truth (`groundtruth-1.md`, extracted read-only from the 096c02c8 jsonl): four reports (L6227 preview to terminal scroll stops, fixed b62; L6615 b62 cannot scroll in tmux under meshyy, fixed b63 / daemon 0.1.17; L9996 inconsistent tmux scroll, fixed b70 / daemon 0.1.21; L10489 "no previous window", fixed b72 by `ScrollBridgeCore.wheelRow` clamping the wheel off the status row). Deferred items named to Aaron (L10307): wheel events dropped during silent QUIC path changes (3-4 s self-healing window), and alt-screen belief after reconnect (masked).

## Commands

~~~~~sh
# import (first state, 2026-10-11, by the previous operator)
cd /Users/acx && m import
# clean state (2026-10-12): every default root entry plus link.json import.roots, EXCEPT this
# acceptance orchestration's own Claude Code logs (session a9f9ea07, which built Link and holds
# the ground truth) and the vendor logs of monad sessions earlier acceptance states ran
/Users/acx/.monad-link-acceptance-work/fresh-state.sh state-attemptN-2026-10-12   # archive + fresh MONAD_HOME + import
#   = m import --path /Users/acx/.claude/projects/-Users-acx/43a93522-....jsonl --path ... (20 paths)
#     --path /Users/acx/.codex/sessions --path /Users/acx/Developer/cc-sessions
# the question, from a fresh session with cwd /Users/acx (not a repo)
cd /Users/acx && m run -p "what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history." < /dev/null
m show <session id>
m show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 30000      # access events on the target
m show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 12150 --limit 42   # the range attempt 9 read
m ls --repo ~/Developer/github/meshyy --all
# attempts 10-12 (build 94ebaa0): the same commands, one fresh state per attempt
fresh-state.sh state-attempt9-runs2-6-2026-10-12   # before attempt 10
fresh-state.sh state-attempt10-2026-10-12          # before attempt 11
fresh-state.sh state-attempt11-2026-10-12          # before attempt 12
m show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 31100      # access events on the target
~~~~~

## Import summaries

First state (2026-10-11 20:52, plain `monad import`, roots `~/.claude/projects`, `~/.codex/sessions`, `~/Developer/cc-sessions`):

~~~~~text
scanned 353 log file(s) under /Users/acx/.claude/projects, /Users/acx/.codex/sessions, /Users/acx/Developer/cc-sessions in 3.5s
imported 34706 event(s): 350 new session(s), 0 updated
~~~~~

Second plain `monad import` on the same state (2026-10-12 10:36, incremental; first lines):

~~~~~text
scanned 369 log file(s) under /Users/acx/.claude/projects, /Users/acx/.codex/sessions, /Users/acx/Developer/cc-sessions in 0.2s
imported 484 event(s): 12 new session(s), 6 updated
skipped /Users/acx/.claude/projects/-Users-acx/0e8a990a-b234-446f-8eed-8310c6a72879.jsonl: monad ran this session; its own log is the canonical one
skipped /Users/acx/.claude/projects/-Users-acx/18614d59-5049-4645-9e60-bb3c60f3df79.jsonl: monad ran this session; its own log is the canonical one
skipped /Users/acx/.claude/projects/-Users-acx/015ee17a-3170-4fc5-8df0-1aa2025b6551.jsonl: monad ran this session; its own log is the canonical one
skipped /Users/acx/.claude/projects/-Users-acx--monad-link-acceptance-work-canary-cwd/146e3a86-ee55-4127-91cd-1cd2e5300d26.jsonl: monad ran this session; its own log is the canonical one
~~~~~

Clean state, `--path` import with the exclusions (the paths are listed in the "scanned" line; excluded: `-Users-acx/a9f9ea07-*` and `-Users-acx-Developer-github-monad/a9f9ea07-*` (this acceptance orchestration and all its agents), and the vendor logs of attempt sessions):

~~~~~text
scanned 254 log file(s) under /Users/acx/.claude/projects/-Users-acx/29056adf-d556-4032-8b24-bc4bcff0d81f.jsonl, /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782, /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl, /Users/acx/.claude/projects/-Users-acx/5dab3418-9a10-49e3-8644-104ade640093.jsonl, /Users/acx/.claude/projects/-Users-acx/909981df-bb28-48a9-861d-6b85f9526b21, /Users/acx/.claude/projects/-Users-acx/909981df-bb28-48a9-861d-6b85f9526b21.jsonl, /Users/acx/.claude/projects/-Users-acx/aabe783e-cc24-47a0-afd0-341951d6ebb0.jsonl, /Users/acx/.claude/projects/-Users-acx/memory, /Users/acx/.claude/projects/-Users-acx--aplus-notifqa, /Users/acx/.claude/projects/-Users-acx--monad-link-acceptance-work-canary-cwd/memory, /Users/acx/.claude/projects/-Users-acx-Developer, /Users/acx/.claude/projects/-Users-acx-Developer-github-a-plus-terminal, /Users/acx/.claude/projects/-Users-acx-Developer-github-a-plus-terminal-104, /Users/acx/.claude/projects/-Users-acx-Developer-github-meshyy, /Users/acx/.claude/projects/-Users-acx-Developer-github-meshyy-prb, /Users/acx/.claude/projects/-Users-acx-security-automation-repos-NexaBase, /Users/acx/.claude/projects/-Users-acx-security-automation-repos-anomaly, /Users/acx/.claude/projects/-Users-acx-security-automation-repos-reporadar, /Users/acx/.codex/sessions, /Users/acx/Developer/cc-sessions in 2.5s
imported 30672 event(s): 251 new session(s), 0 updated
~~~~~

The state used for attempt 9 and runs 2-6 was imported the same way; its summary line: `imported 30923 event(s): 252 new session(s), 0 updated`.

Attempts 10-12 (2026-10-12 11:26-11:32, build 94ebaa0) each started from a fresh `MONAD_HOME` imported the same way. The path list was identical for all three (23 entries: the 20 above, minus `-Users-acx-Developer-github-meshyy` as a whole, plus its `43a93522-...` subagent dir and `memory`, `-Users-acx-Developer-github-monad/memory` and `-Users-acx-Developer-github-monad-review-demo`; the meshyy and monad project dirs are split because runs 2-6 left vendor logs in them). Excluded (25 entries before attempt 10, recorded in the work dir as `r1-a10-import-excluded.txt`): the a9f9ea07 orchestration logs and earlier vendor logs as before, now including attempt 9's (`-Users-acx/cff0fdfb-...`), plus the vendor logs of runs 2-6 (3 in `-Users-acx-Developer-github-meshyy`, 3 in `-Users-acx-Developer-github-monad`, 4 in `-Users-acx--monad-link-worktrees-*`, 1 in the canary cwd), and before attempts 11 and 12 the previous attempt's vendor log (`69913757-...` for attempt 10, `a0a03443-...` for attempt 11). The event counts grow by a few because Aaron's October sessions 43a93522 and 909981df were still being written to:

~~~~~text
attempt 10: scanned 256 log file(s) under ... in 3.0s / imported 31162 event(s): 253 new session(s), 0 updated
attempt 11: scanned 256 log file(s) under ... in 3.1s / imported 31171 event(s): 253 new session(s), 0 updated
attempt 12: scanned 256 log file(s) under ... in 3.2s / imported 31186 event(s): 253 new session(s), 0 updated
~~~~~

Before attempt 10 every imported path was grepped for `groundtruth-1`, `acceptance/link` and `a9f9ea07`; the only hit was `~/Developer/cc-sessions/monad-session-link-brief.md`, which is not a log and is not imported.

## Why the state was reset between attempts

Attempt 4 ran against the first state and read session `25170ea4` "Extract meshyy scrolling ground truth": the read-only agent THIS acceptance workflow used to write the ground truth, imported from `~/.claude/projects` because the default roots include the orchestration's own logs. It also read `01a12d9e` (attempt 2's own session). Any answer built that way says nothing about Link, so from attempt 5 on every attempt ran on a fresh `MONAD_HOME` (old state archived under `/Users/acx/.monad-link-acceptance-work/state-*`) imported without the orchestration's logs and without earlier attempts' sessions. Real history only: Aaron's Claude Code and Codex logs and `~/Developer/cc-sessions`. This is an acceptance-environment problem, not a monad bug, but it is worth knowing: an operator who imports `~/.claude/projects` imports its own transcripts too.

## Attempts

| # | asking session | build | state | what it read with sessions_read | outcome |
|---|---|---|---|---|---|
| 1 | `01a12d98-9109-7000-9eb8-dd66e2d12453` | ffb2bc2 (before 1bad1d4) | first state (2026-10-11) | 43a93522 (x3) | FAIL. Link results carried metadata-only `structuredContent`; Claude Code gave the model that instead of the fenced text (search hits without snippets, `sessions_read` as `{"entries":120}`). Fixed in **1bad1d4**. |
| 2 | `01a12d9e-3ac3-7000-b065-6b22e252474a` | 1bad1d4 | first state (2026-10-11) | 43a93522 (x3) | FAIL. 30 hits for "meshyy scrolling" came from 8 sessions, ten of them one session's edits to the same file; `096c02c8` was not among them. Fixed in **2837aae** (three hits per session). |
| 3 | `01a12da2-dd7e-7000-ac6e-ab793d95343e` | 2837aae | first state (2026-10-11) | 43a93522, 25170ea4, 01a12d9e | DIED on the vendor usage limit ("You've hit your session limit · resets 12am"), not on monad. Had already read the ground-truth extractor (25170ea4) and attempt 2's session. |
| 4 | `01a1308b-61e1-7000-b672-e7eb2a1331e7` | 2837aae (rebuilt 2026-10-12) | first state, contaminated | 25170ea4, f1b92b09, 43a93522, 01a12d9e | FAIL / contaminated: read the acceptance ground-truth extractor and attempt 2. Never read 096c02c8. State reset (see above). |
| 5 | `01a1308f-c73d-7000-99c1-46221d2aeaf2` | 2837aae | clean state #1 | 43a93522, 63a8d06a | FAIL. On clean state, "meshyy scroll" put `096c02c8` at hit 17 of 40: the first sixteen were all tool-call rows (Reads of `meshyy-scroll-brief.md`, edits to `ScrollOracle*.swift`). Fixed in **64ce2bb** (prose ranks above tool rows). |
| 6 | `01a13095-21ce-7000-947e-7fe6f2bd3311` | 64ce2bb | clean state #2 | f1b92b09, 43a93522, 63a8d06a, 909981df | FAIL. `096c02c8` was now hit 1; the model read `f1b92b09` ("understand:transcript", a subagent of the October campaign that had digested 096c02c8) instead. Answer substantively right (builds 62/63/70/72, b72 clamp, alt-screen and QUIC divergences) but not from 096c02c8. |
| 7 | `01a13097-6dd8-7000-9579-eb1a740b3e50` | 64ce2bb | clean state #3 | 58aa12e1, 4456fae5 (x2), 43a93522, 18ab714b, 63a8d06a | FAIL. Read 096c02c8's children (its "Investigate inconsistent tmux scrolling" subagents), not 096c02c8. No b72 clamp in the answer. Two reads refused for mistyped ids (`no session ...`), correctly. |
| 8 | `01a13099-cfe8-7000-ad10-c05ab68908d9` | 64ce2bb | clean state #4 | f1b92b09, 43a93522, 18ab714b, 63a8d06a | FAIL. Same digest path as attempt 6. Its own prompt and reply were hits 2 and 5 of its own search. Fixed in **1c5b03d** (a session's search leaves out its own log). |
| 9 | `01a1309c-b0a1-7000-92e3-a0d033dd247d` | 1c5b03d | clean state #5 (kept for runs 2-6) | 58aa12e1, 18ab714b, 43a93522, 63a8d06a, **096c02c8 seq 12150-12191** | FAIL (partial). Found 096c02c8 as hit 1 and read it, but only the fourth report's range. See the assessment. |
| 10 | `01a130b8-f9a3-7000-9305-34f3fb0f1451` | 94ebaa0 | clean state #6 | f1b92b09, 43a93522 (x2), 18ab714b, 63a8d06a, 909981df | FAIL. 096c02c8 was hit 1 for "scroll"; the model read the digest `f1b92b09` first and never read 096c02c8. Did not use `session_id`. |
| 11 | `01a130ba-e999-7000-9bc1-bacf185081da` | 94ebaa0 | clean state #7 | f1b92b09 (x2), 18ab714b, 43a93522 (x3) | FAIL. 096c02c8 hit 1; read the digest. Used `session_id` four times, on 43a93522 and 18ab714b, never on 096c02c8. Answer content right (four reports, b72 clamp, both deferred items) but not from 096c02c8. |
| 12 | `01a130bd-0f85-7000-9a80-7627ce9983df` | 94ebaa0 | clean state #8 (left running) | f1b92b09, 18ab714b, 909981df, 43a93522 (x2) | FAIL. 096c02c8 hit 1; read the digest. Did not use `session_id`. Answer content right but not from 096c02c8. |

## Bugs found by this run

- **1bad1d4** fix(link): return Link tool results as text only, without structuredContent (attempt 1, previous operator).
- **2837aae** fix(link): cap search hits at three per session so one session cannot hide the rest (attempt 2, previous operator).
- **64ce2bb** fix(link): rank what sessions said above tool call rows in search (attempt 5). bm25 normalizes by row length; tool rows are 89% of the index (13,103 of 14,708 rows) and short, so they won every query naming a file or topic. Regression test: `packages/engine/test/search-index.test.ts` "what a session said ranks above tool call rows that name the same words" (fails on the old ORDER BY, verified).
- **1c5b03d** fix(link): leave the caller's own log out of its sessions_search (attempt 8). Regression test: `packages/link/test/service.test.ts` "a session's search leaves out its own log; the human's search does not" (fails without the fix, verified).

Gates after each fix: `bun run lint` clean, `bunx turbo run typecheck --force` 7/7, `bun test` 968 pass / 1 skip / 0 fail. Both commits authored and committed as Aaron Character, not pushed.

## Attempt 9 (the final attempt on 1c5b03d), in full

Asking session `01a1309c-b0a1-7000-92e3-a0d033dd247d`, cwd `/Users/acx`, build 1c5b03d.

What each Link tool returned to the agent (header line of the fenced result; search hits in rank order, session prefix, row kind and first seq), read from the session's own log:

~~~~~text
seq 30964: [monad: quoted history from a search of session history for "meshyy scroll" (30 hits).]
    hits in order: 096c02c8(prompt 10809), 43a93522(prompt 53), 909981df(agent 710), 909981df(prompt 570), 096c02c8(prompt 12150), e44e94aa(prompt 13349), 63a8d06a(prompt 16820), 18ab714b(prompt 13944), 096c02c8(agent 12042), 909981df(agent 706), e44e94aa(prompt 13257), 706fcb26(agent 14667), 2a4e58ba(agent 12937), 0c585f12(agent 12728), 43a93522(agent 240), 70859e47(prompt 12478), efdff963(prompt 14013), 714049a6(prompt 13081), b441812a(prompt 12803), 43a93522(agent 490) ...
seq 30996: [monad: quoted history from a search of session history for "scrollback scrolling" (30 hits).]
    hits in order: 18ab714b(prompt 13944), e44e94aa(prompt 13257), 53264198(prompt 29821), 4456fae5(prompt 17557), 70859e47(prompt 12478), 58aa12e1(prompt 22443), b441812a(agent 12822), 0c585f12(prompt 12673), efdff963(prompt 14013), 43a93522(prompt 426), 2a4e58ba(prompt 12912), e44e94aa(agent 13366), bb292223(prompt 13121), fae1d038(agent 13830), 066b357c(prompt 13181), 7bce8d8c(prompt 13369), bb292223(agent 13178), e1a61dfe(agent 4938), e1a61dfe(agent 4826), cc98827f(prompt 30009) ...
seq 31013: [monad: quoted history from session 58aa12e1-dc4b-8cce-969a-748ffe4ecb01 "Investigate inconsistent tmux scrolling" seq 22443-30976.]
seq 31023: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 13944-30949.]
seq 31043: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 420-30980.]
seq 31053: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 16820-16935.]
seq 31070: [monad: quoted history from session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w" seq 12150-12191.]
seq 31097: [monad: quoted history from the session list (12 sessions).]
~~~~~

The agent's Link calls (arguments as the vendor recorded them):

~~~~~text
sessions_search {"query": "meshyy scroll", "limit": 30}
sessions_search {"query": "scrollback scrolling", "limit": 30}
sessions_read {"session_id": "58aa12e1-dc4b-8cce-969a-748ffe4ecb01", "from_seq": 22443, "limit": 40}
sessions_read {"session_id": "18ab714b-ca1a-8566-8361-fb236851821f", "from_seq": 13944, "limit": 40}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 420, "limit": 80}
sessions_read {"session_id": "63a8d06a-292c-8b11-bfa9-ac409056a817", "from_seq": 16820, "limit": 60}
sessions_read {"session_id": "096c02c8-1e54-4bcc-8520-de007e67c9f2", "from_seq": 12150, "limit": 25}
sessions_list {"limit": 12, "since": "2026-10-12T00:00:00Z"}
~~~~~

### Caller: `monad show 01a1309c-b0a1-7000-92e3-a0d033dd247d` (includes the final answer)

~~~~~text
session 01a1309c-b0a1-7000-92e3-a0d033dd247d "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 30924] session created in /Users/acx (interactive, claude-acp)
[seq 30926] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 30929] tool ToolSearch (other) -> completed
[seq 30937] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30940] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30943] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d search (caller) query "meshyy scroll"
[seq 30970] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d search (caller) query "scrollback scrolling"
[seq 30998-31002] agent: Found two eras of work. Reading the diagnosis and the latest state.
[seq 31003] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31007] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31010] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (caller) target 58aa12e1-dc4b-8cce-969a-748ffe4ecb01
[seq 31020] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 31025-31032] agent: The August investigation session died on a session limit. Let me read the October work and the orchestrator's findings.
[seq 31033] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31037] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31040] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31050] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (caller) target 63a8d06a-292c-8b11-bfa9-ac409056a817
[seq 31055] tool ls -la /Users/acx/Developer/cc-sessions/scroll-evidence/ 2>/dev/null | head -30; echo "=== audit doc ==="; ls -la /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo "=== meshyy PR 68 ==="; cd /Users/acx/Developer/github/meshyy && gh pr view 68 --json number,state,mergedAt,title 2>&1 | head -20; echo "=== aplus PRs ==="; cd /Users/acx/Developer/github/a-plus-terminal && gh pr list --state all --limit 8 --json number,state,title,baseRefName 2>&1 | head -40 (execute) paths: /Users/acx/Developer/cc-sessions/scroll-evidence/, /dev/null, /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal -> completed
[seq 31058] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31067] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (caller) target 096c02c8-1e54-4bcc-8520-de007e67c9f2
[seq 31072] tool git log --oneline origin/develop..scroll-oracle 2>&1 | head; echo "--- branches ---"; git branch -a --list '*scroll*' 2>&1; echo "=== meshyy PR68 checks ==="; cd /Users/acx/Developer/github/meshyy && gh pr checks 68 2>&1 | head -15; echo "=== meshyy main green? ==="; ~/bin/ci-all-green.sh AaronCx/meshyy main 2>&1 | tail -8 (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy, ~/bin/ci-all-green.sh -> failed; permission: cancelled by human
[seq 31075] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 31084] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d list (caller)
[seq 31099-31440] agent: Two separate scroll bugs, nine weeks apart. One was fixed; the current one is diagnosed but **not fixed**.

## Round 1 - August 6–7 (session `096c02c8`): fixed

Your report: "can't scroll inside the tmux session at all when in meshyy, ssh works," then the decisive clue - a green→yellow bar reading **"no previous window."**

That message is tmux *switching windows*, not failing to scroll. tmux's default binding for wheel events on its **status line** (bottom row) is previous/next-window, so swipes drifting low fired wheel bytes right at it. Fix: wheel rows are clamped off the bottom row. Shipped in **build 72**, 454 tests green. The competing geometry-drift theory (app/daemon/tmux disagreeing on grid size) was tested live and **refuted**.

Two parallel "Investigate inconsistent tmux scrolling" sessions (`58aa12e1`, `4456fae5`) were spawned the same day and both died on usage limits before doing any work - `58aa12e1`'s log is one prompt and one `session limit` error.

## Round 2 - October 11–12: diagnosed, not fixed

Scrolling was still inconsistent, so it became a three-PR program off `~/Developer/cc-sessions/meshyy-scroll-brief.md`. The mechanism: `ScrollBridge` picks a route from the **app-side** SwiftTerm emulator's belief (`isCurrentBufferAlternate`, `mouseMode`) - mouse-on → SGR wheel bytes, alt-no-mouse → arrow keys, else native scrollback, which inside a fullscreen TUI is a **dead swipe**. Under meshyy that belief can be wrong.

An oracle suite judged every meshyy swipe against a real SSH swipe by what tmux actually did (`pane_in_mode`/`scroll_position`). Four measured divergences:

| Condition | meshyy vs ssh |
|---|---|
| Mouse **off** + any fresh emulator (relaunch, or after *any* redial) | meshyy routes `native` and sends **nothing**; ssh sends arrow keys → dead swipe |
| **True path change** (old QUIC path never returns) | swipe **silently lost**, no send error |
| 4 s hole that heals | arrives 4–5.5 s late, never lost ("works after a few seconds") |
| Your config (tmux mouse **on**) | matched ssh on everything *except* the path change |

Root causes read out of the code (session `43a93522`, seq 444): `establish()` calls `resetToInitialState()` on **every** reconnect, after which meshyy restores mouse belief only through the `.modes` frame and **never restores alt-screen belief**. And the outbox snapshots `self.meshyy` per item, so a swipe during a silent path death writes into the dead transport and raises no error.

## What's actually left undone

The orchestrator's own words at seq 490: *"Scrolling is **not fixed**: everything so far adds observation and tests."*

1. **No fix has been attempted or chosen.** PR A shipped *observability only* - the Scroll trace (meshyy `v0.1.22`, a+Terminal #155/#156, TestFlight **build 75 VALID**, sim-tested with a real finger drag).
2. **meshyy PR #68 is still OPEN** (just verified - `mergedAt: null`). The suite passes locally (`make check`, 250 tests, 3 consecutive runs) but CI went red on two *pre-existing* sleep-based resize tests (`AttachResyncTests.unchangedResizeStillRepairs`, `MultiplexerResizeTests`). Those were hardened and re-pushed, then the session hit another usage limit mid-CI-probe. Merge command left ready: `~/bin/pr-babysit.sh AaronCx/meshyy 68 --merge`.
3. **tmux on CI was backed out** - it starved the GitHub runner. So the tmux-based scroll suites run *only locally*; CI never exercises them.
4. **The a+Terminal half of PR B was never merged** - no PR exists. `ScrollOracleLiveTests.swift` (~1115 lines), the `test-scroll-oracle` target and the `bootstrapRewriteForTesting` seam sit on branch `scroll-oracle`. The last stabilize run got 3/3 tests passing, then was cut off mid ring-overrun work. Still owes the 1006-ordering mutation run and `docs/qa/mutation-log.md`.
5. **PR C was never written.** `docs/qa/scroll-divergence-audit.md` does not exist (confirmed - `docs/qa/` holds only leak-audit, live-activity-test-plan, preview-live, voiceover-checklist). Both strict known-issue annotations in the test suites cite that missing file as their justification.
6. **Blocked on you:** the build-75 Pushover asked you to note the time of a dead swipe, then Settings → Diagnostics → Scroll trace → Send to inbox, and say which it was - nothing happens / wrong thing scrolls / works after a few seconds. Nothing proceeds to a real fix without that.

One coordination note from the history: the 1.0.4 release session is gating the whole Scroll trace feature behind `#if MESHYY` so it stays out of the App Store binary, and it's rebasing on `develop` - it wants a heads-up before the app half of PR B merges.
[seq 31443] turn ended (end_turn)
~~~~~

Streamed output of `monad run` (tool progress lines dropped; it shows the Bash permission the agent asked for being cancelled, since nobody was attached):

~~~~~text
session: 01a1309c-b0a1-7000-92e3-a0d033dd247d
access: this session ran search for "meshyy scroll"
access: this session ran search for "scrollback scrolling"
Found two eras of work. Reading the diagnosis and the latest state.
access: this session ran read on 58aa12e1
access: this session ran read on 18ab714b
The August investigation session died on a session limit. Let me read the October work and the orchestrator's findings.
access: this session ran read on 43a93522
access: this session ran read on 63a8d06a
access: this session ran read on 096c02c8
permission requested: git log --oneline origin/develop..scroll-oracle 2>&1 | head; echo "--- branches ---"; git branch -a --list '*scroll*' 2>&1; echo "=== meshyy PR68 checks ==="; cd /Users/acx/Developer/github/meshyy && gh pr checks 68 2>&1 | head -15; echo "=== meshyy main green? ==="; ~/bin/ci-all-green.sh AaronCx/meshyy main 2>&1 | tail -8
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
access: this session ran list
(the answer that follows is identical to the caller's final answer above)
~~~~~

### Target: access events on `096c02c8`

~~~~~text
session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"
[seq 30944] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d search (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2 query "meshyy scroll"
[seq 31068] access: 01a1309c-b0a1-7000-92e3-a0d033dd247d read (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2
~~~~~

### Target: the range attempt 9 read (`monad show 096c02c8 --from 12150 --limit 42`)

Running this `monad show` appended one more `human read` access event to 096c02c8, as it should. Trimmed for publication to the lines that carry the evidence: Aaron's fourth report, the agent's status-row diagnosis, the clamp, and the build 72 summary. Tool rows with local paths and the custom-icon thread in the same turn are elided; seq 12192 onward lies past the range the agent read.

~~~~~text
session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"
[seq 12150] user:  custom icon selection isn't working and scrolling is still not working with meshyy tmux + claude code when i try to scroll im getting the bar from green to yellow saying "no previous window" which non of this is an issue on ssh
[seq 12151] agent: Two real bugs. The custom-icon one I can see in my own code: the file picker's dismissal can clear the pending agent id *before* the completion reads it (a state race), and worse - your files live in iCloud Drive, and a file that isn't downloaded locally fails a plain read *silently*. The "no previous window" clue is gold for the scroll bug: that's tmux's own message for *window switching* - tmux's default binding for **wheel-scrolling on its status line** is previous/next-window. Your swipes are being delivered as wheel events whose coordinates land on the status row - which smells like a pty-size/emulator-size mismatch that only exists under meshyy. Fixing the icon bug first, then measuring the geometry:
[seq 12152-12162] (6 tool rows: the custom-icon fix and the geometry live test; elided)
[seq 12164] tool Bash: Clamp wheel rows off status line (execute) -> completed
[seq 12166] tool Bash: Test the status-line clamp (execute) -> completed
[seq 12168-12178] (6 tool rows: full suite, commit, PR and merge, archive and upload, notification, CI wait for build 72; elided)
[seq 12180] agent: **Build 72 is on TestFlight (VALID) with both of your reports root-caused and fixed.**

[custom-icon paragraph elided: a separate bug, not part of the scrolling question]

**"No previous window"** - your symptom description solved it: that yellow bar is tmux *switching windows*. tmux's default binding for wheel-scrolling on its status line - the bottom row - is previous/next-window, and a swipe drifting low was firing wheel events right at it. Wheel events are now clamped off the bottom row entirely: a scroll gesture means scroll the content, and no TUI keeps content on the multiplexer's status row. I also chased my geometry-drift theory properly and it **didn't hold** - a new live test proves app, daemon, and tmux agree on the grid through a full keyboard cycle, so the status-line binding was the whole story.

454 tests green, CI on the merge sha being watched in the background. If any scroll deadness survives this build, the next suspect is already documented - the 3–4 second self-healing QUIC dead-window - and I'd want your description of exactly what a dead swipe looks like when it happens.
[seq 12181-12191] (turn end, background-task notifications and the build-72 CI confirmation; elided)
~~~~~

### `monad ls --repo ~/Developer/github/meshyy --all` (096c02c8 line and its neighbours)

~~~~~text
01a1309c-b0a1-7000-92e3-a0d033dd247d  idle                    interactive  -       "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"  /Users/acx  2026-10-12T14:57:15.134Z
    repos: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy
43a93522-3701-437a-a02a-60a68db2c782  imported                interactive  -       "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh"  /Users/acx  2026-10-12T14:55:31.642Z
    repos: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy, /opt/homebrew
...
bd62fddd-c5c1-8911-a395-898b6aaceecc  imported                interactive  -       "Draft meshyy 0.1.21 release notes"  /Users/acx/Developer/github/a-plus-terminal  2026-08-20T00:28:30.023Z
    repos: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy
096c02c8-1e54-4bcc-8520-de007e67c9f2  imported                interactive  -       "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"  /Users/acx  2026-08-10T22:28:26.546Z
    repos: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal, /opt/homebrew, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/SwiftTerm, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/meshyy
...
(100 lines in all)
~~~~~

## Assessment (attempt 9; the earlier attempts are in the table above)

| criterion | result | evidence |
|---|---|---|
| `monad import` run, summary recorded | PASS | summaries above; 096c02c8 imported from `~/Developer/cc-sessions/home-sessions/096c02c8-....jsonl` |
| finds 096c02c8 via sessions_search | PASS | first search "meshyy scroll": hits `096c02c8(prompt 10809)` first, plus `096c02c8(prompt 12150)` and `096c02c8(agent 12042)` |
| reads the right seq range with sessions_read | PARTIAL | read 096c02c8 seq 12150-12191: Aaron's fourth report ("no previous window") and the build 72 status-row clamp. It did not read the earlier reports or the message naming the deferred items to Aaron (ground truth L10307) |
| answer: four reports | FAIL | the answer presents August as one report ("can't scroll inside the tmux session ... then the decisive clue") and never names the b62/b63/b70 rounds |
| answer: build 72 status-row clamp | PASS | "wheel rows are clamped off the bottom row. Shipped in **build 72**" |
| answer: the two deferred items named to Aaron | FAIL (content right, attribution wrong) | both divergences appear (alt-screen belief never restored after reconnect; a swipe lost silently on a true path change), but as findings of the October oracle work, not as the two items deferred and named to Aaron in August |
| `monad ls --repo ~/Developer/github/meshyy --all` lists 096c02c8 | PASS | `096c02c8-1e54-4bcc-8520-de007e67c9f2  imported ... /Users/acx` with repos meshyy, a-plus-terminal |
| 096c02c8's log has access events from the asking session | PASS | `[seq 30944] access: 01a1309c-... search (target)`, `[seq 31068] access: 01a1309c-... read (target)` |

The answer also says the two August "Investigate inconsistent tmux scrolling" subagents "both died on usage limits before doing any work". That holds for `58aa12e1` (the one it read) and is wrong for `4456fae5`, which attempt 7 read and which holds the August root-cause report.

**Run 1: FAIL.**

## Earlier attempts

<details><summary>Attempt 1: <code>01a12d98-9109-7000-9eb8-dd66e2d12453</code> (ffb2bc2 (before 1bad1d4), first state (2026-10-11))</summary>

`monad show 01a12d98-9109-7000-9eb8-dd66e2d12453`:

~~~~~text
session 01a12d98-9109-7000-9eb8-dd66e2d12453 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 34721] session created in /Users/acx (interactive, claude-acp)
[seq 34723] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 34726-34730] agent: I'll search monad's session history for the meshyy scrolling work.
[seq 34731] tool ToolSearch (other) -> completed
[seq 34739] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 34742] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 34745] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 search (caller) query "meshyy scroll"
[seq 34766] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 search (caller) query "scrollback"
[seq 34794] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 34797] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 34800] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 list (caller)
[seq 34866] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 notes_read (caller)
[seq 34870] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 34877] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 34882] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 34889] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 34894] tool ls -la ~/.monad/ 2>/dev/null | head -30; echo ---; ls ~/.monad/sessions 2>/dev/null | head (execute) paths: ~/.monad/, /dev/null, ~/.monad/sessions -> completed
[seq 34901] tool ls -la ~/.monad/*.db* 2>/dev/null; echo ---; find ~ -name "monad*.db" -not -path "*/node_modules/*" -maxdepth 6 2>/dev/null | head -20 (execute) paths: ~/.monad/*.db*, /dev/null, ~ -> completed
[seq 34907] access: human read (target) target 01a12d98-9109-7000-9eb8-dd66e2d12453
[seq 34912] tool ls -la ~/.monad-link/; echo ---; sqlite3 ~/.monad-link/monad.db ".tables" (execute) paths: ~/.monad-link/, ~/.monad-link/monad.db -> failed; permission: cancelled by human
[seq 34920] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 34927] access: 01a12d98-9109-7000-9eb8-dd66e2d12453 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 34932] tool ls -la ~/.claude/projects/-Users-acx/ 2>/dev/null | tail -30 (execute) paths: ~/.claude/projects/-Users-acx/, /dev/null -> completed
[seq 34939] tool python3 - <<'EOF'
import json
p='/Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl'
n=0
for line in open(p):
    try: d=json.loads(line)
    except: continue
    if d.get('type')=='user' and not d.get('isMeta'):
        c=d.get('message',{}).get('content')
        if isinstance(c,str): t=c
        elif isinstance(c,list):
            t=' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        else: t=''
        t=t.strip()
        if t and not t.startswith('<'):
            n+=1
            print('=== USER',n,d.get('timestamp'),'===')
            print(t[:1500])
            print()
EOF (execute) paths: /Users/acx -> failed; permission: cancelled by human
[seq 34947] tool python3 -c "print('ok')" (execute) -> failed; permission: cancelled by human
[seq 34955] tool grep -c . /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 34962] tool ls ~/bin | head -40 (execute) paths: ~/bin -> completed
[seq 34969] tool ~/bin/monad sessions read 43a93522-3701-437a-a02a-60a68db2c782 --from-seq 855 --limit 5 2>&1 | head -40 (execute) paths: ~/bin/monad -> failed; permission: cancelled by human
[seq 34977] tool ls -la ~/Developer/cc-sessions/ | head -40 (execute) paths: ~/Developer/cc-sessions/ -> completed
[seq 34984] tool Read Developer/cc-sessions/meshyy-scroll-brief.md (read) paths: /Users/acx/Developer/cc-sessions/meshyy-scroll-brief.md -> completed
[seq 34986] tool ls -laR ~/Developer/cc-sessions/scroll-evidence | head -60 (execute) paths: ~/Developer/cc-sessions/scroll-evidence -> completed
[seq 34995] tool grep -n "scroll\|Scroll\|meshyy\|build 6[0-9]\|build 7[0-9]" /Users/acx/Developer/cc-sessions/HANDOFF.md | head -60 (execute) paths: /Users/acx/Developer/cc-sessions/HANDOFF.md -> completed
[seq 34998] tool ls /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo ---; ls /Users/acx/Developer/github/meshyy/docs/ 2>/dev/null (execute) paths: /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /dev/null, /Users/acx/Developer/github/meshyy/docs/ -> completed
[seq 35007] tool Read Developer/cc-sessions/HANDOFF.md (124 - 203) (read) paths: /Users/acx/Developer/cc-sessions/HANDOFF.md -> completed
[seq 35011] tool ls /Users/acx/Developer/github/meshyy/docs/qa/; echo ---; cd /Users/acx/Developer/github/a-plus-terminal && git log --oneline -15 --all --since=2026-10-10 2>&1 | head -30; echo === ; git status -sb | head -5 (execute) paths: /Users/acx/Developer/github/meshyy/docs/qa/, /Users/acx/Developer/github/a-plus-terminal -> failed; permission: cancelled by human
[seq 35021] tool git -C /Users/acx/Developer/github/a-plus-terminal log --oneline -20 --date=short --pretty="%h %ad %s" develop (execute) paths: /Users/acx/Developer/github/a-plus-terminal -> failed; permission: cancelled by human
[seq 35024] tool git -C /Users/acx/Developer/github/meshyy log --oneline -15 --date=short --pretty="%h %ad %s" main; echo === ; git -C /Users/acx/Developer/github/meshyy status -sb | head (execute) paths: /Users/acx/Developer/github/meshyy -> failed; permission: cancelled by human
[seq 35035] tool grep -o '"text":"[^"]\{80,4000\}' /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | tail -12 (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> failed; permission: cancelled by human
[seq 35044] tool grep -n "scroll-divergence-audit" /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | head -5 (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 35051] tool find /Users/acx/Developer/github/a-plus-terminal /Users/acx/Developer/github/meshyy /Users/acx/Developer/cc-sessions/meshyy-mutant-63 -name "*scroll*" -o -name "*mutation*" -o -name "*device-matrix*" 2>/dev/null | grep -v node_modules | head -30 (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy, /Users/acx/Developer/cc-sessions/meshyy-mutant-63, /dev/null -> completed
[seq 35058] tool Read Developer/github/meshyy/docs/qa/mutation-log.md (read) paths: /Users/acx/Developer/github/meshyy/docs/qa/mutation-log.md -> completed
[seq 35060] tool Read Developer/github/meshyy/.git/HEAD (read) paths: /Users/acx/Developer/github/meshyy/.git/HEAD -> completed
[seq 35068] tool ls -la /Users/acx/Developer/cc-sessions/meshyy-mutant-63/ ; echo ===; tail -25 /Users/acx/Developer/github/meshyy/.git/logs/HEAD (execute) paths: /Users/acx/Developer/cc-sessions/meshyy-mutant-63/, /Users/acx/Developer/github/meshyy/.git/logs/HEAD -> failed
[seq 35071] tool grep -o "scroll-divergence-audit[a-z.-]*" /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | sort | uniq -c (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 35079] tool Read Developer/cc-sessions/meshyy-mutant-63/m63-status.txt (read) paths: /Users/acx/Developer/cc-sessions/meshyy-mutant-63/m63-status.txt -> completed
[seq 35081] tool Read Developer/cc-sessions/meshyy-mutant-63/lane-status.txt (read) paths: /Users/acx/Developer/cc-sessions/meshyy-mutant-63/lane-status.txt -> completed
[seq 35090] tool Read Developer/github/a-plus-terminal/.git/HEAD (read) paths: /Users/acx/Developer/github/a-plus-terminal/.git/HEAD -> completed
[seq 35092] tool tail -20 /Users/acx/Developer/github/meshyy/.git/logs/HEAD; echo "----APLUS----"; tail -25 /Users/acx/Developer/github/a-plus-terminal/.git/logs/HEAD (execute) paths: /Users/acx/Developer/github/meshyy/.git/logs/HEAD, /Users/acx/Developer/github/a-plus-terminal/.git/logs/HEAD -> completed
[seq 35103] tool grep -o '"text":"[^"]*' /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | tail -30 | cut -c1-900 (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 35110] tool grep -o '"text":"[^"]*' /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | grep -v total_tokens | cut -c1-1200 | tail -60 (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 35117] tool cut -c1-200 /Users/acx/Developer/github/meshyy/.git/logs/refs/heads/scroll-oracle | tail -30 (execute) paths: /Users/acx/Developer/github/meshyy/.git/logs/refs/heads/scroll-oracle -> completed
[seq 35120] tool grep -o '"text":"[^"]*' /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl | grep -i "oracle\|mouse off\|dead swipe\|alt" | cut -c1-1500 | tail -25 (execute) paths: /Users/acx/.claude/projects/-Users-acx/43a93522-3701-437a-a02a-60a68db2c782.jsonl -> completed
[seq 35129] tool grep -c "" /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-check.log; grep -iE "Test run with|passed after|failed after|error:" /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-check.log | tail -5; echo "--- oracle1"; grep -iE "Test run with|passed after|failed after|✘|Test .* failed" /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-1.log | tail -8; echo "--- oracle2"; grep -iE "Test run with|passed after|failed after|✘" /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-2.log | tail -8 (execute) paths: /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-check.log, /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-1.log, /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-2.log -> completed
[seq 35136] tool grep -o "recorded a known issue.*" /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-2.log | cut -c1-260 | sort | uniq -c | sort -rn | head -20 (execute) paths: /Users/acx/Developer/cc-sessions/scroll-evidence/postfix-oracle-2.log -> completed
[seq 35143-35527] agent: Read through the monad session tree rooted at `43a93522` ("start-meshyy-scroll.sh", still live as of 00:52 UTC) plus the historical arc in `~/Developer/cc-sessions/HANDOFF.md:124-166`. Note: `sessions_read` returns metadata only (no `entries` payload) in this build, so I read the underlying Claude Code transcripts and repo artifacts directly.

## What broke

The whole family of bugs is one shape: **the emulator's belief about tmux's state diverging from tmux's real state.** Over SSH, SwiftTerm sees every byte tmux sends, so its mouse-mode / alt-screen belief is always right. Under meshyy, a fresh or resumed emulator gets modes from the daemon's `.modes` frame and `ScrollBridge` routes every swipe on that synthesized belief.

Four root causes were found and fixed in builds 70/72 + daemon 0.1.21 (2026-08-07):

1. Mode-correction frames rode a **different QUIC stream** than output, so they could be reordered and silently undone - fixed by putting control and pty on one ordered stream (meshyy #63).
2. Mode synthesis **reset SGR encoding after arming the mouse**, which SwiftTerm reads as mouse-off.
3. A **512-chunk buffer cap** dropped bytes the resume arithmetic had already counted.
4. Wheel events landing on **tmux's status row** triggered tmux's default prev/next-window binding - the yellow "no previous window" symptom Aaron saw. Wheel events are now clamped off the bottom row.

A geometry-drift theory was tested and refuted.

The process failure matters as much as the bugs: all four fixes closed with "verified end to end" on the Mac harness, simulator and CI. **None was ever confirmed on Aaron's phone**, and `docs/qa/device-matrix.md` has never been run. That's why tonight's brief added the "'Fixed' means Aaron confirmed it on a device" rule to both repos' CLAUDE.md.

## New finding from tonight's differential (the real answer to "still broken")

The SSH-as-oracle suite reproduces dead swipes:

- **Every reconnect resets the emulator.** `establish()` calls `resetToInitialState()`; afterwards meshyy restores mouse belief only via `.modes` and **never restores alt-screen belief**. This is why the oracle sees dead swipes with tmux mouse *off* after any redial.
- **Sends during the path-change window don't fail.** The outbox snapshots `self.meshyy` per item and sends into whatever transport exists, so a swipe during a silent QUIC path death goes into the dead connection and raises no error.
- In `scroll-evidence/postfix-oracle-{1,2}.log` the suite "passes" **with 16 known issues**, every one the same divergence: meshyy delivered nothing to tmux (`rx=""`) where SSH produced copy-mode entry (`mode=1 pos=10`) or 9 arrow presses. The bug is now *measured and parked as a known issue*, not fixed - which is also why CI reads green.

## What shipped tonight

- **PR A (swipe trace)** - merged (a+Terminal #155), **TestFlight build 75 VALID**, Pushover sent asking Aaron to share a trace when a swipe goes dead. meshyy #66 + 0.1.22 (#67) merged and tagged; `~/bin/meshyyd` is 0.1.22 with `--trace-modes` on.
- **PR B (SSH oracle)** - meshyy half is PR #68, auto-merging when green (first CI run of the tmux suites on a GitHub runner). Planted violations both confirmed red 3/3: `m63-status.txt` (revert of #63) and `lane-status.txt` (1006 ordering) are `exit=1` on all three runs.

## Left unfixed

1. **Alt-screen belief after reconnect** - still ignored in `MeshyyTransport` ("not this type's business"); now known to produce dead swipes with mouse off, not merely masked.
2. **QUIC path-change dead window** (3–4 s) - swipes are sent into a dead connection with no error, no queue, no UI signal. Brief says audit only, don't implement.
3. **PR C's audit doc** - `docs/qa/scroll-divergence-audit.md` does not exist yet; the session was still gathering code facts for it when it hit the current turn. The a+Terminal half of PR B also had no commits yet.
4. **Field confirmation** - build 75 only *observes*; nobody has confirmed scrolling works on a device. Status is "unconfirmed on device (build 75)".
5. **Older carry-overs**: cross-device simultaneous resume race (fix idea: daemon-side exclusive-attach flag); the stray `scroll-invest` branch commit `b94113d` still undecided; parked push-notifications brief PR 5.

Also live: a merge-order dependency with the other session (acx-0b) over the `MESHYY` compile flag and both editing `scripts/ship-testflight.sh` - build 75 is this session's, 76 is theirs.
[seq 35530] turn ended (end_turn)
~~~~~

What the model received for its first search (raw `tool_call_update` from the log, start): the structuredContent JSON, with no snippets, instead of the fenced text:

~~~~~json
{"sessionId":"01a12d98-9109-7000-9eb8-dd66e2d12453","update":{"toolCallId":"toolu_<id>","status":"completed","content":[{"content":{"text":"{\"hits\":[{\"session_id\":\"43a93522-3701-437a-a02a-60a68db2c782\",\"title\":\"can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh\",\"kind\":\"tool\",\"first_seq\":491,\"last_seq\":491,\"ts\":\"2026-10-11T19:53:09.824Z\"},{\"session_id\":\"e44e94aa-ba8a-8c9a-afa4-16ef21cdb255\",\"title\":\"stabilize\",\"kind\":\"tool\",\"first_seq\":13318,\"last_seq\":13318,\"ts\":\"2026-10-11T23:06:14.612Z\"},{\"session_id\":\"4456fae5-2954-85ce-ad4a-d2537614e8af\",\"title\":\"Investigate inconsistent tmux scrolling\",\"ki ...
~~~~~

</details>

<details><summary>Attempt 2: <code>01a12d9e-3ac3-7000-b065-6b22e252474a</code> (1bad1d4, first state (2026-10-11))</summary>

`monad show 01a12d9e-3ac3-7000-b065-6b22e252474a`:

~~~~~text
session 01a12d9e-3ac3-7000-b065-6b22e252474a "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 35533] session created in /Users/acx (interactive, claude-acp)
[seq 35535] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 35538-35544] agent: I'll search monad's session history for the meshyy scrolling work.
[seq 35545] tool ToolSearch (other) -> completed
[seq 35553] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 35559] access: 01a12d9e-3ac3-7000-b065-6b22e252474a search (caller) query "meshyy scrolling"
[seq 35571-35575] agent: Found several related sessions. Let me read the brief and session list.
[seq 35576] tool Read Developer/cc-sessions/meshyy-scroll-brief.md (read) paths: /Users/acx/Developer/cc-sessions/meshyy-scroll-brief.md -> completed
[seq 35578] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 35585] access: 01a12d9e-3ac3-7000-b065-6b22e252474a list (caller)
[seq 35628] tool ls -la /Users/acx/Developer/github/meshyy/docs/qa/ 2>/dev/null; echo "---APLUS QA---"; ls -la /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo "---HANDOFF---"; grep -n -i -A40 "meshyy" /Users/acx/Developer/cc-sessions/HANDOFF.md | head -120 (execute) paths: /Users/acx/Developer/github/meshyy/docs/qa/, /dev/null, /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /Users/acx/Developer/cc-sessions/HANDOFF.md -> completed
[seq 35631] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 35640] access: 01a12d9e-3ac3-7000-b065-6b22e252474a read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 35645] tool cd /Users/acx/Developer/github/meshyy && echo "=== MESHYY ===" && git log --oneline -12 && git status --porcelain | head -20 && echo "--- branches ---" && git branch -a | head -20 && echo "=== APLUS ===" && cd /Users/acx/Developer/github/a-plus-terminal && git log --oneline -12 && git status --porcelain | head -20 && git branch -a | head -20 && echo "=== PRs ===" && gh pr list -R AaronCx/meshyy --state all --limit 8 && gh pr list -R AaronCx/a-plus-terminal --state all --limit 8 (execute) paths: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal -> failed; permission: cancelled by human
[seq 35648] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 35658] access: 01a12d9e-3ac3-7000-b065-6b22e252474a read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 35663-35667] agent: Git command was declined. Continuing with the session history.
[seq 35668] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 35675] access: 01a12d9e-3ac3-7000-b065-6b22e252474a read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 35680] tool find /Users/acx/Developer/github/a-plus-terminal /Users/acx/Developer/github/meshyy /Users/acx/Developer/github/meshyy-prb -name "scroll-divergence-audit.md" 2>/dev/null; echo "--- aplus qa ---"; ls /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo "--- prb worktree ---"; ls /Users/acx/Developer/github/meshyy-prb 2>/dev/null | head; echo "--- evidence ---"; ls -la /Users/acx/Developer/cc-sessions/scroll-evidence/ 2>/dev/null (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/meshyy-prb, /dev/null, /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /Users/acx/Developer/cc-sessions/scroll-evidence/ -> completed
[seq 35683] tool tail -60 /Users/acx/Developer/github/meshyy/docs/qa/mutation-log.md (execute) paths: /Users/acx/Developer/github/meshyy/docs/qa/mutation-log.md -> completed
[seq 35692] tool cd /Users/acx/Developer/github/meshyy-prb && echo "=== prb branch/log ===" && git log --oneline -9 && echo "=== status ===" && git status -sb | head -5; echo; cd /Users/acx/Developer/github/meshyy && echo "=== meshyy main ===" && git log --oneline -4 && git branch -a --list "*oracle*" "*scroll*" (execute) paths: /Users/acx/Developer/github/meshyy-prb, /Users/acx/Developer/github/meshyy -> failed; permission: cancelled by human
[seq 35695] tool cd /Users/acx/Developer/github/a-plus-terminal && echo "=== develop log ===" && git log --oneline -8 develop && echo "=== branches ===" && git branch -a --list "*scroll*" "*oracle*" "*trace*" && echo "=== trace files ===" && find . -path ./.git -prune -o -name "*ScrollTrace*" -print -o -name "*ScrollOracle*" -print -o -name "*Differential*" -print 2>/dev/null | head (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /dev/null -> failed; permission: cancelled by human
[seq 35706-35711] agent: Git invocations were declined; reading the ref logs directly instead.
[seq 35712] tool echo "=== meshyy-prb HEAD ==="; cat /Users/acx/Developer/github/meshyy-prb/.git 2>/dev/null | head -2; cat /Users/acx/Developer/github/meshyy/.git/worktrees/*/HEAD 2>/dev/null; echo "=== scroll-oracle reflog (tail) ==="; cut -c1-160 /Users/acx/Developer/github/meshyy/.git/logs/refs/heads/scroll-oracle 2>/dev/null | tail -8; echo "=== remote refs matching scroll/oracle ==="; ls /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/ 2>/dev/null; grep -E "scroll|oracle" /Users/acx/Developer/github/meshyy/.git/packed-refs 2>/dev/null; echo "=== aplus develop reflog tail ==="; cut -c1-200 /Users/acx/Developer/github/a-plus-terminal/.git/logs/refs/heads/develop 2>/dev/null | tail -6; echo "=== aplus local branches ==="; ls /Users/acx/Developer/github/a-plus-terminal/.git/refs/heads/ 2>/dev/null (execute) paths: /Users/acx/Developer/github/meshyy-prb/.git, /dev/null, /Users/acx/Developer/github/meshyy/.git/worktrees/*/HEAD, /Users/acx/Developer/github/meshyy/.git/logs/refs/heads/scroll-oracle, /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/, /Users/acx/Developer/github/meshyy/.git/packed-refs, /Users/acx/Developer/github/a-plus-terminal/.git/logs/refs/heads/develop, /Users/acx/Developer/github/a-plus-terminal/.git/refs/heads/ -> completed
[seq 35719] tool echo "=== meshyy local scroll-oracle ==="; cat /Users/acx/Developer/github/meshyy/.git/refs/heads/scroll-oracle 2>/dev/null; echo "=== meshyy origin/scroll-oracle ==="; cat /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/scroll-oracle 2>/dev/null; echo "=== meshyy main / origin main ==="; cat /Users/acx/Developer/github/meshyy/.git/refs/heads/main /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/main 2>/dev/null; echo "=== aplus scroll-oracle local ==="; cat /Users/acx/Developer/github/a-plus-terminal/.git/refs/heads/scroll-oracle 2>/dev/null; echo "=== aplus origin scroll-oracle ==="; cat /Users/acx/Developer/github/a-plus-terminal/.git/refs/remotes/origin/scroll-oracle 2>/dev/null; echo "(absent if blank)"; echo "=== aplus origin/develop ==="; cat /Users/acx/Developer/github/a-plus-terminal/.git/refs/remotes/origin/develop 2>/dev/null; echo "=== aplus scroll-oracle reflog ==="; cut -c1-150 /Users/acx/Developer/github/a-plus-terminal/.git/logs/refs/heads/scroll-oracle 2>/dev/null | tail -6 (execute) paths: /Users/acx/Developer/github/meshyy/.git/refs/heads/scroll-oracle, /dev/null, /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/scroll-oracle, /, /Users/acx/Developer/github/meshyy/.git/refs/heads/main, /Users/acx/Developer/github/meshyy/.git/refs/remotes/origin/main, /Users/acx/Developer/github/a-plus-terminal/.git/refs/heads/scroll-oracle, /Users/acx/Developer/github/a-plus-terminal/.git/refs/remotes/origin/scroll-oracle, /Users/acx/Developer/github/a-plus-terminal/.git/refs/remotes/origin/develop, /Users/acx/Developer/github/a-plus-terminal/.git/logs/refs/heads/scroll-oracle -> completed
[seq 35727] tool gh pr list -R AaronCx/meshyy --state all --limit 5 --json number,title,state,headRefName 2>&1 | head -20 (execute) -> completed
[seq 35734-36043] agent: Read the brief, the handoff, and the orchestrator session (`43a93522`, "complete start-meshyy-scroll.sh") plus its child workflows. Here's the picture.

## What broke

Aaron reported it four times (2026-08-06 → 08-07, builds pre-62 through 71), always **meshyy only, SSH fine**: scrolling in tmux + Claude Code did nothing, worked inconsistently, and by build 71 showed tmux's bar going yellow with *"no previous window."*

The structural reason meshyy differs: over SSH the emulator sees every byte tmux sends, so its belief about mouse mode and the alt screen is always right. Under meshyy a fresh or resumed emulator gets its modes from the daemon's `.modes` frame, synthesized locally, and `ScrollBridge` routes every swipe on that belief. **Every scroll bug so far has been belief diverging from tmux's real state.**

Five distinct defects were found and fixed (builds 62, 63, 70, 72; daemon 0.1.17 → 0.1.21):

1. Returning from the preview sheet resigned first responder - mode-1004 focus-out with no refocus, so the TUI ignored wheel input (build 62).
2. Mode-correction frames rode a *different* QUIC stream than output, so they could be reordered and silently undone. Control and pty frames now share one ordered stream (meshyy #63).
3. The app's mode synthesis reset SGR encoding *after* arming the mouse - SwiftTerm reads that as mouse-off.
4. A 512-chunk buffer cap could drop bytes the resume arithmetic had already counted.
5. Wheel events landing on tmux's status row hit tmux's default wheel-on-status binding → prev/next window. That's the "no previous window" symptom. Wheel events are now clamped off the bottom row.

Worth knowing: build 63's "root cause" (a cold emulator never learning tmux's modes) was never actually reproduced with tmux - the tmux test **passed without the fix** and was replaced by a tmux-free flood test. tmux re-arms the outer terminal on every attach/WINCH, so it re-teaches a fresh emulator by itself.

## What was left unfixed

The 2026-10-11 session built the differential harness the brief asked for (one real tmux session, reached over SSH and over meshyy, asserting what *tmux actually did* via `#{pane_in_mode} #{scroll_position}`). It measured the deferrals as real, not theoretical:

- **Mouse off + any fresh or reset emulator: the swipe is dead.** SSH routes `arrowKeys` and tmux scrolls; meshyy routes `native` and nothing lands (`landed=never`). 16 of the suite's known issues are this. Cause: `establish()` calls `resetToInitialState()` on *every* reconnect, and meshyy restores only mouse belief via `.modes` - **alt-screen belief is never restored** (`.screenMode` is ignored in `MeshyyTransport` as "not this type's business"). It's masked only while tmux has mouse on.
- **QUIC path change: the swipe is permanently lost**, mouse on *and* off (`fate=lost`), and the *next* swipe after the redial is dead too. A self-healing drop delivers 3.7–4.8 s late. Sends during the dead window **raise no error** - the outbox snapshots the transport and sends into the dead connection.
- Cross-device simultaneous resume of the same survivor still has a small residual race.
- **Nobody has confirmed scrolling on a device.** `docs/qa/device-matrix.md` has still never been run. Build 75 shipped to TestFlight with the on-device swipe trace and the Pushover ask - Aaron's trace hadn't come back when the session stopped.

Three work items are open where the session stopped mid-flight:

| Item | State |
|---|---|
| PR A (swipe trace) | **Done** - a+Terminal #155 merged to develop, meshyy #66 merged, build 75 VALID on TestFlight, Pushovered |
| PR B meshyy half | **meshyy PR #68 open, unmerged** (`scroll-oracle`, pushed, rebased on 0.1.22, suite green 3× with 16 known issues) |
| PR B a+Terminal half | **Never written** - local `scroll-oracle` branch sits at develop's tip with zero commits |
| PR C audit | **Never written** - `docs/qa/scroll-divergence-audit.md` doesn't exist, yet PR #68's `withKnownIssue` messages point readers at it |

Evidence logs and the two simulator screenshots are durable in `~/Developer/cc-sessions/scroll-evidence/`.
[seq 36046] turn ended (end_turn)
~~~~~

</details>

<details><summary>Attempt 3: <code>01a12da2-dd7e-7000-ac6e-ab793d95343e</code> (2837aae, first state (2026-10-11))</summary>

`monad show 01a12da2-dd7e-7000-ac6e-ab793d95343e`:

~~~~~text
session 01a12da2-dd7e-7000-ac6e-ab793d95343e "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 36049] session created in /Users/acx (interactive, claude-acp)
[seq 36051] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 36054] tool ToolSearch (other) -> completed
[seq 36062] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36065] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36068] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e search (caller) query "meshyy scroll"
[seq 36091] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e search (caller) query "scrollback scrolling"
[seq 36119] tool Read Developer/cc-sessions/meshyy-scroll-brief.md (read) paths: /Users/acx/Developer/cc-sessions/meshyy-scroll-brief.md -> completed
[seq 36121] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36128] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e notes_read (caller)
[seq 36132] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 36135] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36138] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e list (caller)
[seq 36205] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e search (caller) query "\"scroll-divergence-audit\""
[seq 36218] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36222] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36225] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 36235] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e read (caller) target 01a12d9e-3ac3-7000-b065-6b22e252474a
[seq 36240] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36244] tool echo "=== aplus docs/qa ==="; ls -la /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo "=== meshyy docs/qa ==="; ls -la /Users/acx/Developer/github/meshyy/docs/qa/ 2>/dev/null; echo "=== divergence audit anywhere ==="; find /Users/acx/Developer/github/a-plus-terminal /Users/acx/Developer/github/meshyy /Users/acx/Developer/github/meshyy-prb -name "scroll-divergence-audit.md" -not -path "*/.git/*" 2>/dev/null; echo "=== PRs meshyy ==="; gh pr list -R AaronCx/meshyy --state all --limit 8 --json number,title,state,headRefName 2>&1 | head -40; echo "=== PRs aplus ==="; gh pr list -R AaronCx/a-plus-terminal --state all --limit 8 --json number,title,state,headRefName 2>&1 | head -40 (execute) paths: /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /dev/null, /Users/acx/Developer/github/meshyy/docs/qa/, /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/meshyy-prb -> completed
[seq 36247] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 36257] tool Read Developer/github/meshyy/docs/qa/mutation-log.md (read) paths: /Users/acx/Developer/github/meshyy/docs/qa/mutation-log.md -> completed
[seq 36259] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36267] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e search (caller) query "status row wheel \"no previous window\""
[seq 36277] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36285] access: 01a12da2-dd7e-7000-ac6e-ab793d95343e read (caller) target 25170ea4-a500-84a8-a7db-86cca4fb2bac
[seq 36290] agent: You've hit your session limit · resets 12am (America/New_York)
[seq 36292] error: Internal error: You've hit your session limit · resets 12am (America/New_York)
~~~~~

Tail of the streamed output:

~~~~~text
tool: toolu_<id> (completed)
You've hit your session limit · resets 12am (America/New_York)
error: Internal error: You've hit your session limit · resets 12am (America/New_York)
error: Internal error: You've hit your session limit · resets 12am (America/New_York)
~~~~~

</details>

<details><summary>Attempt 4: <code>01a1308b-61e1-7000-b672-e7eb2a1331e7</code> (2837aae (rebuilt 2026-10-12), first state, contaminated)</summary>

Link tool results the agent received:

~~~~~text
seq 36831: [monad: quoted history from a search of session history for "meshyy scroll" (30 hits).]
    hits in order: 01a12da2(tool 36120), 01a12d9e(tool 35577), 01a12d98(tool 34985), 43a93522(tool 491), e44e94aa(tool 13318), 4456fae5(tool 21508), 4456fae5(tool 21460), 4456fae5(tool 21458), 01a12d9e(tool 35721), 01a12d9e(tool 35720), 7bce8d8c(tool 13474), 7bce8d8c(tool 13466), 7bce8d8c(tool 13439), e44e94aa(tool 13358), e44e94aa(tool 13356), 70859e47(tool 12680), 70859e47(tool 12672), 70859e47(tool 12668), 7fb23aff(tool 13892), fae1d038(tool 13772) ...
seq 36839: [monad: quoted history from the repo notes for /Users/acx/Developer/github/meshyy (0 notes).]
seq 36892: [monad: quoted history from the session list (40 sessions).]
seq 36913: [monad: quoted history from a search of session history for "screenMode alt screen deferred divergence" (6 hits).]
    hits in order: 25170ea4(agent 18477), a9f9ea07(prompt 239), 7fb23aff(agent 14000), efdff963(prompt 14002), f1b92b09(agent 13558), fae1d038(agent 13888)
seq 36931: [monad: quoted history from a search of session history for "\"scroll-divergence-audit\"" (18 hits).]
    hits in order: 01a12d98(tool 35046), 01a12d98(tool 35045), 01a12d98(tool 35074), 01a12d9e(tool 35682), 01a12d9e(tool 35681), 01a12da2(tool 36252), 01a12da2(tool 36251), 43a93522(agent 36404), e44e94aa(prompt 13315), 43a93522(agent 684), 01a12d9e(agent 35538), 70859e47(prompt 12536), efdff963(prompt 14002), 43a93522(prompt 861), e44e94aa(agent 13424), 066b357c(prompt 13239), bb292223(prompt 13179), fae1d038(agent 13888)
seq 36943: [monad: quoted history from session 25170ea4-a500-84a8-a7db-86cca4fb2bac "Extract meshyy scrolling ground truth" seq 18470-36906.]
seq 36953: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13550-13608.]
seq 36970: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 36380-36923.]
seq 37014: [monad: quoted history from session 01a12d9e-3ac3-7000-b065-6b22e252474a "what broke with meshyy scrolling, and what was left unfixed? Look through monad'" seq 35690-36921.]
seq 37033: [monad: quoted history from a search of session history for "tmux test passed without the fix build 63 modes never reproduced" (4 hits).]
    hits in order: 01a12d9e(agent 35538), f1b92b09(agent 13558), fae1d038(agent 13888), 2a4e58ba(prompt 12970)
seq 37045: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13609-13638.]
seq 37057: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13639-36951.]
~~~~~

`monad show 01a1308b-61e1-7000-b672-e7eb2a1331e7`:

~~~~~text
session 01a1308b-61e1-7000-b672-e7eb2a1331e7 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 36791] session created in /Users/acx (interactive, claude-acp)
[seq 36793] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 36796-36799] agent: I'll search monad's session history for this.
[seq 36800] tool ToolSearch (other) -> completed
[seq 36808] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36811] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36814] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 search (caller) query "meshyy scroll"
[seq 36837] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 notes_read (caller)
[seq 36842] tool Read Developer/cc-sessions/meshyy-scroll-brief.md (read) paths: /Users/acx/Developer/cc-sessions/meshyy-scroll-brief.md -> completed
[seq 36844] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 36851] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 list (caller)
[seq 36894-36898] agent: Brief read. Now pulling the actual session arc.
[seq 36899] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36902] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 36905] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 search (caller) query "screenMode alt screen deferred divergence"
[seq 36919] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 search (caller) query "\"scroll-divergence-audit\""
[seq 36933] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36937] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36940] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target 25170ea4-a500-84a8-a7db-86cca4fb2bac
[seq 36950] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 36955-36959] agent: Historical arc is clear. Now the October campaign's outcome.
[seq 36960] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 36964] tool cd /Users/acx/Developer/github/a-plus-terminal && echo "=== BRANCH ===" && git rev-parse --abbrev-ref HEAD && echo "=== STATUS ===" && git status --porcelain && echo "=== LOG ===" && git log --oneline -12 && echo "=== QA DOCS ===" && ls -la docs/qa/ 2>/dev/null (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /dev/null -> failed; permission: cancelled by human
[seq 36967] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 36978] tool git -C /Users/acx/Developer/github/a-plus-terminal status --short --branch; echo "--- qa docs ---"; ls /Users/acx/Developer/github/a-plus-terminal/docs/qa/ (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/a-plus-terminal/docs/qa/ -> failed; permission: cancelled by human
[seq 36986-36993] agent: Bash is unavailable in this session (permission aborted), so I'll verify file state directly.
[seq 36994] tool Read Developer/github/a-plus-terminal/docs/qa/scroll-divergence-audit.md (read) paths: /Users/acx/Developer/github/a-plus-terminal/docs/qa/scroll-divergence-audit.md -> failed
[seq 36996] tool Read Developer/github/a-plus-terminal/docs/qa/mutation-log.md (read) paths: /Users/acx/Developer/github/a-plus-terminal/docs/qa/mutation-log.md -> failed
[seq 37004] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 37011] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target 01a12d9e-3ac3-7000-b065-6b22e252474a
[seq 37016-37020] agent: One claim needs checking before I report it - let me verify the build-63 reproduction question.
[seq 37021] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 37027] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 search (caller) query "tmux test passed without the fix build 63 modes never reproduced"
[seq 37035] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 37042] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 37047] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 37054] access: 01a1308b-61e1-7000-b672-e7eb2a1331e7 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 37059-37555] agent: Answer assembled from monad's session history - the original August arc (session `096c02c8`, re-audited by `f1b92b09`/`25170ea4`) and the 2026-10-11 campaign (`43a93522` + children).

## What broke

Aaron reported it four times, 2026-08-06 → 08-07, always **meshyy only, SSH fine**: scrolling in tmux + Claude Code did nothing, then "works inconsistently," and by build 71 tmux's status bar flashed yellow with *"no previous window."*

The structural reason: over SSH the emulator sees every byte tmux sends, so its belief about mouse mode and the alt screen is always right. Under meshyy a fresh or resumed emulator gets its modes from the daemon's `.modes` frame, synthesized locally, and `ScrollBridge` routes every swipe off that belief. **Every scroll bug in the arc was belief diverging from tmux's real state.**

Five defects were found and shipped (builds 62/63/70/72, daemon 0.1.17 → 0.1.21):

1. **Preview sheet left the terminal unfocused** - SwiftTerm sent a mode-1004 focus-out, nothing refocused on dismiss, so the TUI ignored wheel input (build 62, app #136).
2. **Cold emulator never learned tmux's modes** - a program announces modes once; a relaunched emulator started with everything off and the arming escapes had aged out of the ring. Daemon now tracks `{1,1000,1002,1003,1004,1006,2004}` and sends a `modes` frame on every attach (meshyy #48, v0.1.17; build 63).
3. **Mode frames raced pty bytes on a separate QUIC stream**, so a correction could be overtaken and silently undone. `ChannelKind.wireLane` puts control and pty on one ordered lane (meshyy #63, v0.1.21).
4. **The app's synthesis disarmed the mouse it just armed** - it emitted `?1006l` after the mouse family, and SwiftTerm reads DECRST 1006 as mouse-off. Now 1006 settles first. Same build also fixed `transport.output` being `.bufferingNewest(512)`, which could drop bytes the resume arithmetic had already counted (build 70, app #145).
5. **Wheel events landing on tmux's status row** hit tmux's `WheelUpStatus`/`WheelDownStatus` binding → previous/next-window. That's the "no previous window" symptom; wheel rows are now clamped off the bottom row (build 72, app #147).

A caveat the October re-audit established, and it matters: **most of those fixes were never shown red.** The tmux repro for #2 *passed without the fix* (tmux re-arms the outer terminal on every attach/WINCH, so it re-teaches a fresh emulator by itself) and was replaced with a tmux-free flood test; #3's tests are pure property tests with no reorder ever reproduced; the 512-cap fix got no test; #4 doesn't even bite tmux, since tmux arms 1006 anyway; #5's clamp is transport-agnostic and doesn't explain the meshyy-only part. The "belief settles within 52 ms, 8-for-8" figure came from a no-tmux loopback test and was the *same before and after* the wire-lane fix.

## What was left unfixed

Four divergences were deliberately deferred in August (only the first two were named to Aaron). The October campaign built the differential harness - one real tmux session reached over SSH and over meshyy, asserting what tmux *actually did* via `#{pane_in_mode} #{scroll_position}` - and measured them as real rather than theoretical:

- **Alt-screen belief after reconnect.** `establish()` calls `resetToInitialState()` on every reconnect; 1049 isn't tracked and `MeshyyTransport` ignores `.screenMode` ("not this type's business"). Measured: with **tmux mouse off + any fresh or reset emulator, the swipe is dead** - SSH routes arrow keys and tmux scrolls, meshyy routes `native` and nothing lands. Masked today only because Aaron runs mouse on.
- **QUIC path change.** Measured worse than documented: the swipe is **permanently lost**, mouse on *and* off, and the next swipe after redial is dead too. Sends into the dead connection **raise no error** - the outbox swallows them via `try? await meshyy.send`. A 4 s hole that heals delivers 3.7–4.8 s late instead of losing it. This is the one divergence that still bit Aaron's own configuration.
- **`ScrollBridge` per-swipe gates** - a 0.3 s hold suspends the pan, a `|vy|>|vx|` gate rejects diagonal starts, and `activeMode` latches at `.began`, so a gesture starting inside tmux's WINCH disarm/rearm pulse keeps the stale route for its whole life.
- **`rebuilt()` chunk loss** - discards chunks left in the old output stream at suspend; same class as the 512 cap.

Plus the thing underneath all of it: **nobody has ever confirmed scrolling on Aaron's phone.** `docs/qa/device-matrix.md` has never been run. Every "verified end to end" was simulator, `swift test`, or CI.

## Open work where the October session stopped (usage limit, ~01:05 today)

| Item | State |
|---|---|
| PR A - on-device swipe trace | **Done.** meshyy #66/#67 → v0.1.22, a+Terminal #155 on develop, **TestFlight build 75 VALID**, Aaron Pushovered to share a trace when a swipe dies. His trace hadn't come back. |
| PR B - meshyy half (#68) | **Open, unmerged.** Oracle suite green locally (250 tests); reverting meshyy #63 turned it red 3/3 runs. CI red on two pre-existing resize tests (`unchangedResizeStillRepairs`, `MultiplexerResizeTests`) that wait on fixed sleeps - the fix is to wait on a ready marker instead. |
| PR B - a+Terminal half | **Uncommitted.** Branch `scroll-oracle` sits at develop's tip with 3 dirty files (`Makefile`, `MeshyyTransport.swift`, `ScrollOracleLiveTests.swift`). Still needs the 1006-ordering mutation run and `docs/qa/mutation-log.md`. Resumable via `resumeFromRunId: "wf_a732c94b-7c6"`. |
| PR C - divergence audit | **Never written.** I confirmed `docs/qa/scroll-divergence-audit.md` does not exist in a-plus-terminal - yet #68's `withKnownIssue` messages already point readers at it. The measurements it needs are durable in `~/Developer/cc-sessions/scroll-evidence/`. |

Two caveats on that table: Bash was declined in this session, so #68's *current* merge status is what the last recorded session saw, not a live `gh` check. And `mutation-log.md`/`device-matrix.md` exist in **meshyy**'s `docs/qa`, not a+Terminal's - the a+Terminal copies are the ones outstanding.
[seq 37558] turn ended (end_turn)
~~~~~

</details>

<details><summary>Attempt 5: <code>01a1308f-c73d-7000-99c1-46221d2aeaf2</code> (2837aae, clean state #1)</summary>

Link tool results the agent received:

~~~~~text
seq 30578: [monad: quoted history from a search of session history for "meshyy scroll" (40 hits).]
    hits in order: 43a93522(tool 56), e44e94aa(tool 13222), 4456fae5(tool 17322), 4456fae5(tool 17274), 4456fae5(tool 17272), 7bce8d8c(tool 13378), 7bce8d8c(tool 13370), 7bce8d8c(tool 13343), e44e94aa(tool 13262), e44e94aa(tool 13260), 70859e47(tool 12584), 70859e47(tool 12576), 70859e47(tool 12572), 7fb23aff(tool 13796), fae1d038(tool 13676), cbb77278(tool 13551), 096c02c8(prompt 10771), 909981df(tool 510), 7fb23aff(tool 13842), fae1d038(tool 13684) ...
seq 30610: [monad: quoted history from a search of session history for "scrollback" (30 hits).]
    hits in order: 53264198(prompt 29418), e1a61dfe(agent 4900), e1a61dfe(agent 4788), cc98827f(prompt 29606), c452fba5(prompt 29334), c41fbc80(prompt 29538), e1a61dfe(agent 4721), b441812a(agent 12784), e44e94aa(prompt 13219), 4456fae5(prompt 17154), 58aa12e1(prompt 22040), bb292223(agent 13140), 70859e47(prompt 12440), efdff963(prompt 13906), 7bce8d8c(prompt 13331), 2a4e58ba(prompt 12874), bb292223(prompt 13083), 43a93522(prompt 426), 0c585f12(prompt 12635), c41fbc80(agent 29539) ...
seq 30664: [monad: quoted history from the session list (40 sessions).]
seq 30708: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 380-30624.]
seq 30723: [monad: quoted history from a search of session history for "postflake" (0 hits).]
    hits in order: 
seq 30764: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 16603-30626.]
~~~~~

This attempt's state was archived before its `monad show` was saved; its streamed `monad run` output (tool progress lines dropped) is the transcript:

~~~~~text
session: 01a1308f-c73d-7000-99c1-46221d2aeaf2
I'll search monad's session history for this.
access: this session ran search for "meshyy scroll"
access: this session ran search for "scrollback"
access: this session ran list
permission requested: cd ~/Developer/github/a-plus-terminal 2>/dev/null && git log --oneline -15 --all --graph | head -40; echo "=== docs/qa ==="; ls -la ~/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; ls -la ~/Developer/github/meshyy/docs/qa/ 2>/dev/null; ls -d ~/Developer/github/meshyy-prb 2>/dev/null && ls -la ~/Developer/github/meshyy-prb/docs/qa/ 2>/dev/null
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
permission requested: git -C /Users/acx/Developer/github/a-plus-terminal log --oneline -12 develop 2>&1 | head -15; echo "=== branches ==="; git -C /Users/acx/Developer/github/a-plus-terminal branch -vv 2>&1 | head -20; echo "=== qa docs aplus ==="; ls /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>&1; echo "=== meshyy ==="; git -C /Users/acx/Developer/github/meshyy log --oneline -8 2>&1 | head; ls /Users/acx/Developer/github/meshyy/docs/qa/ 2>&1; echo "=== prb ==="; ls -d /Users/acx/Developer/github/meshyy-prb 2>&1
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
access: this session ran read on 43a93522
access: this session ran search for "postflake"
access: this session ran read on 63a8d06a
permission requested: gh api repos/AaronCx/a-plus-terminal/branches --jq '.[].name' 2>&1 | head -20; echo "=== meshyy branches ==="; gh api repos/AaronCx/meshyy/branches --jq '.[].name' 2>&1 | head -20
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
Pulled this from monad's session history (the 2026-08 meshyy main session plus the 2026-10-11/12 campaign driven by `~/Developer/cc-sessions/meshyy-scroll-brief.md`).

## What broke

The symptom Aaron reported four times: in tmux + Claude Code, swipes do nothing - only under meshyy, fine over SSH. Sometimes the tmux bar went yellow with *"no previous window"*.

Every bug has the same shape: **the emulator's belief about tmux's state diverges from tmux's real state.** Over SSH the emulator sees every byte, so its mouse/alt-screen belief is always right. Under meshyy a fresh or resumed emulator gets its modes from the daemon's `.modes` frame, synthesized locally, and `ScrollBridge` routes every swipe on that belief.

Four root causes were found and fixed (a+Terminal builds 70/72, daemon 0.1.21):
1. Mode-correction frames rode a different QUIC stream than output, so they could be reordered and silently undone - control and pty frames now share one ordered stream (meshyy #63).
2. Mode synthesis reset SGR encoding *after* arming the mouse, which SwiftTerm reads as mouse-off.
3. A 512-chunk buffer cap could drop bytes the resume arithmetic had already counted.
4. Wheel events landing on tmux's status row hit tmux's default wheel-on-status binding (prev/next window) - hence "no previous window". Wheel events are now clamped off the bottom row.

A geometry-drift theory was tested and refuted. **Aaron never confirmed any of it on a device**, and `docs/qa/device-matrix.md` has still never been run - which is why the October campaign was about observability rather than more fixes.

## What the October run measured (and did not fix)

PR A shipped: TestFlight **build 75** with an on-device swipe-trace ring buffer, Pushovered, and meshyy `v0.1.22` with far-side mode tracing. PR B built a real SSH-vs-meshyy differential oracle that judges swipes by *what tmux actually did*. It confirmed three live divergences, all still open:

- **tmux mouse off + any fresh emulator** (relaunch, or after *any* redial): meshyy sends **nothing**; SSH sends arrow keys. Root cause located: `establish()` calls `resetToInitialState()` on every reconnect, and meshyy restores mouse belief via `.modes` but **never alt-screen belief** (`.screenMode` is ignored in `MeshyyTransport`). 16 known-issue records in the suite are this.
- **True QUIC path change**: the swipe is **lost silently, with no send error** - the outbox snapshots the transport per item and writes into the dead connection.
- **A 4 s hole that heals**: the swipe lands 4–5.5 s late, never lost.
- Aaron's own setup (mouse on) matched SSH on everything **except** the path change.

## Left unfixed / in flight

1. **Scrolling is not fixed.** Everything in October is observation and tests. Status is "unconfirmed on device" pending Aaron's trace from build 75.
2. **meshyy PR #68 (the oracle suite) is still OPEN**, CI red: `MultiplexerResizeTests.swift:181` - *"A pane inside the multiplexer tracks shrink and growth"* (`regrown → nil` vs `tall → 64`), a pre-existing fixed-sleep flake. A local hardened re-run was in flight and its log (`scroll-evidence/postflake-check.log`, 10:41 today) is **truncated mid-run** - never completed.
3. **tmux on CI was backed out** (it starved the runner), so the tmux/oracle suites run on this Mac only - a green badge does not cover them.
4. **The a+Terminal half of PR B was never done**: no commits, no PR, no `docs/qa/mutation-log.md` in that repo, and the **1006-ordering mutation was never run**. Its workflow was paused (`resumeFromRunId: "wf_a732c94b-7c6"`).
5. **PR C was never written** - `docs/qa/scroll-divergence-audit.md` does not exist, though all the measurements for it are in `~/Developer/cc-sessions/scroll-evidence/`.
6. **The oracle's own honesty caveats** (`meshyy-prb/docs/qa/mutation-log.md:284-317`): the tmux differential **alone does not catch #63** - only the row checker does, at ~23% per-seed hit rate; `WireLaneTests` pins the helper, not the routing; and mutant 2 run 2 produced an **unexplained red** (tmux session vanished after `path-drop-heal`) whose cause was never established.
7. **Older deferred item still open**: the cross-device simultaneous-resume race (fix idea: a daemon-side exclusive-attach flag), and the stray meshyy branch `scroll-invest` commit `b94113d` still undecided.
8. Separately, the 1.0.4 release session stopped **mid-rebase** while gating the whole Scroll trace feature behind `#if MESHYY` for the App Store candidate - so that gate is incomplete, and once it lands the trace exists in beta builds only.

Both driving sessions ended on usage limits, not on completion.

Want me to pick this up - hardening the two flaky resize tests to get #68 green, or writing the PR C audit from the evidence that's already measured?
~~~~~

</details>

<details><summary>Attempt 6: <code>01a13095-21ce-7000-947e-7fe6f2bd3311</code> (64ce2bb, clean state #2)</summary>

Link tool results the agent received:

~~~~~text
seq 30729: [monad: quoted history from a search of session history for "scroll" (40 hits).]
    hits in order: 096c02c8(prompt 10776), 43a93522(agent 281), 909981df(prompt 537), 096c02c8(prompt 12117), 096c02c8(agent 10649), 909981df(agent 677), 43a93522(prompt 53), 01a13095(prompt 30688), 63a8d06a(prompt 16674), e44e94aa(prompt 13316), 909981df(prompt 745), 2a4e58ba(agent 12904), e44e94aa(prompt 13224), 0c585f12(agent 12695), 714049a6(prompt 13048), 70859e47(prompt 12445), b441812a(prompt 12770), 0c585f12(prompt 12640), b84f31fc(prompt 12826), 706fcb26(agent 14565) ...
seq 30757: [monad: quoted history from a search of session history for "meshyy scrollback" (24 hits).]
    hits in order: 53264198(prompt 29570), c452fba5(prompt 29486), cc98827f(prompt 29758), c41fbc80(prompt 29690), 4456fae5(prompt 17306), e44e94aa(prompt 13224), 58aa12e1(prompt 22192), b441812a(agent 12789), efdff963(prompt 13911), 43a93522(prompt 426), bb292223(prompt 13088), 70859e47(prompt 12445), c452fba5(agent 29487), e44e94aa(agent 13333), 066b357c(prompt 13148), 7bce8d8c(prompt 13336), c41fbc80(agent 29691), bb292223(agent 13145), fae1d038(agent 13797), 2a4e58ba(prompt 12879) ...
seq 30769: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13460-30724.]
seq 30815: [monad: quoted history from the session list (40 sessions).]
seq 30827: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 420-30776.]
seq 30845: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 16672-16746.]
seq 30857: [monad: quoted history from session 909981df-bb28-48a9-861d-6b85f9526b21 "can you complete this Read ~/Developer/cc-sessions/aplus-1.0.4-release-brief.md " seq 740-30778.]
~~~~~

`monad show 01a13095-21ce-7000-947e-7fe6f2bd3311`:

~~~~~text
session 01a13095-21ce-7000-947e-7fe6f2bd3311 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 30686] session created in /Users/acx (interactive, claude-acp)
[seq 30688] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 30691] tool ToolSearch (other) -> completed
[seq 30699] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30702] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30705] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 search (caller) query "scroll"
[seq 30735] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 search (caller) query "meshyy scrollback"
[seq 30759] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30763] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 30766] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 30774] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 list (caller)
[seq 30817] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30824] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 30829] tool cd /Users/acx/Developer/github/meshyy 2>/dev/null && gh pr view 68 --json number,title,state,mergedAt,headRefName 2>&1 | head -20; echo "---audit doc---"; ls -la /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>&1; echo "---aplus branches---"; git -C /Users/acx/Developer/github/a-plus-terminal branch -a --list '*scroll*' 2>&1; echo "---aplus open PRs---"; gh -R AaronCx/a-plus-terminal pr list --state open --limit 10 2>&1 (execute) paths: /Users/acx/Developer/github/meshyy, /dev/null, /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /Users/acx/Developer/github/a-plus-terminal -> failed; permission: cancelled by human
[seq 30832] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30842] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 read (caller) target 63a8d06a-292c-8b11-bfa9-ac409056a817
[seq 30847] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30854] access: 01a13095-21ce-7000-947e-7fe6f2bd3311 read (caller) target 909981df-bb28-48a9-861d-6b85f9526b21
[seq 30859-31406] agent: Pulled this from monad's session history - the Aug 6–7 arc (session `096c02c8`, reconstructed in detail by `understand:transcript` / `f1b92b09`) plus the Oct 11–12 re-investigation (`43a93522` and its children).

## What Aaron actually reported

Four reports, all **meshyy-only, SSH always fine**:

1. **Aug 6, pre-build-62** - returning from the in-app preview sheet killed scrolling in the chat TUI.
2. **Aug 6, build 62** - "even worse": can't scroll inside tmux at all under meshyy.
3. **Aug 7, ~build 69** - "works inconsistently" with tmux + Claude Code, meshyy only.
4. **Aug 7, build 71** - swipe turns the tmux status bar yellow with **"no previous window"**.

## What was shipped as fixes - and how thin the proof was

| Build | Fix | Verification reality |
|---|---|---|
| 62 | Preview sheet's `onDismiss` now calls `session.bridge.focus()` (mode-1004 focus-out never un-done) | Live test called `focus()` directly, never drove the sheet; never run red; no tmux. Aaron said 62 was worse. |
| 63 | meshyy daemon tracks `trackedModes` and re-teaches them on attach (`.modes` frame, v0.1.17); app synthesizes the escapes | **The tmux repro passed *without* the fix** - replay re-taught the modes. The shipped test has no tmux (6 MB flood instead). So the "root cause" Pushover was about a real bug, but probably not Aaron's. |
| 70 | Three stacked defects: (a) control + pty frames put on one QUIC lane, (b) `modeEscapes` emitted `?1006l` *after* arming the mouse family, self-disarming, (c) `transport.output` was `.bufferingNewest(512)`, silently dropping counted bytes | (a) and (c) **never shown red** - loopback QUIC loses nothing and the chaos relay wasn't used. (b) only bites programs arming mouse without SGR - tmux arms 1006, so it never affected Aaron. The famous "settles in 52 ms, 8/8 cycles" numbers came from a no-tmux test with a hand-written SwiftTerm *replica*, and were identical before and after the fix. |
| 72 | `ScrollBridge.wheelRow` clamps the wheel row to `rows-1` so a low swipe can't hit tmux's status line (that's the "no previous window" binding) | Explains the mechanism, but the clamp is transport-agnostic - nothing explains the meshyy-only part. Unit test written *with* the fix, not red-checked. |

Across all four rounds **no fix was ever confirmed on Aaron's phone**; every "verified" claim was simulator, Mac `swift test`, or CI. The Oct 11 reconstruction's blunt summary: "the build-63 root cause probably isn't Aaron's tmux case."

## What the Oct 11–12 oracle work established (first real evidence)

A real SSH-vs-meshyy differential (`ScrollOracleOrderingTests`, judging swipes by what tmux actually did via `#{pane_in_mode}`/`#{scroll_position}`) finally measured the divergences:

- **tmux mouse OFF + any fresh emulator** (relaunch, or after *any* redial): meshyy sends **nothing**, SSH sends arrow keys. Cause: `establish()` calls `resetToInitialState()` on every reconnect, mouse belief comes back via `.modes` but **alt-screen belief never does** - `MeshyyTransport` ignores `.screenMode` and 1049 isn't in `trackedModes`.
- **True QUIC path change**: the swipe is **lost silently** - the outbox does `try? await meshyy.send(data)`, so there's no error, no queue, no replay.
- **A 4 s hole that heals**: the swipe lands 4–5.5 s late, never lost → exactly Aaron's "inconsistent / works after a few seconds".
- **Aaron's own setup (tmux mouse on)**: everything matched SSH **except** the path change.

## Left unfixed

**Still-open code divergences** (observation and tests were added; the bugs themselves were not fixed):

1. Alt-screen belief wrong after every reconnect (`.screenMode` not plumbed into a field `ScrollBridge` prefers - and don't synthesize `?1049h`, it blanks the buffer).
2. Wheel bytes swallowed during the 3–4 s silent-path-death window (`SessionManager.swift` outbox, no error/queue/replay).
3. `ScrollBridge.activeMode` latched at `.began`, so a swipe starting inside tmux's WINCH mouse-pulse keeps the stale route for the whole gesture.
4. `MeshyyTransport.rebuilt()` discards counted-but-unfed chunks at suspend - same loss class as the old 512 cap.
5. Claude Code inline-vs-alt-screen and tmux wheel pass-through (H3) were never tested; no harness runs real `claude`.

**Open work items**, as of the last entries (`43a93522` seq 490–504, and the cross-session note in `909981df` at 14:40 today):

- **meshyy PR #68** (oracle suite) - open, not merged. Local `make check` green, 250 tests; reverting the #63 fix turned it red 3/3 runs. CI was red on two pre-existing fixed-sleep resize tests (`unchangedResizeStillRepairs`, `MultiplexerResizeTests`); hardened waits were committed and pushed, then merge via `pr-babysit.sh … 68 --merge`. Installing tmux on the GitHub runner starved it and was backed out, so the tmux suites still don't run in CI.
- **a+Terminal half of PR B** - paused mid-workflow (resume `wf_a732c94b-7c6`). Needs `ScrollOracleLiveTests.swift`, `test-scroll-oracle`, the 1006-ordering mutation run, and a `docs/qa/mutation-log.md`; its `bootstrapRewriteForTesting` seam must be wrapped for the App Store target where `MeshyyTransport` is compiled out.
- **PR C** - `docs/qa/scroll-divergence-audit.md` (fix options and costs, no implementation) not written.
- **Build 75 is on TestFlight** with the new Scroll trace diagnostic, and Aaron was asked to capture a dead swipe and send the trace. **That report hasn't come back** - everything downstream was waiting on it.

Net: scrolling is **not fixed**. The Oct work replaced four rounds of plausible-but-unproven fixes with measured evidence of where meshyy diverges from SSH, and left the actual repairs to a future PR.

Also worth noting: the 1.0.4 release session is gating the whole Scroll trace feature behind `#if MESHYY`, so it's beta-only and won't ship to the App Store.

(I tried to confirm #68's live merge state with `gh`, but the shell call was declined, so those last two bullets reflect the sessions' last recorded state rather than GitHub right now.)
[seq 31409] turn ended (end_turn)
~~~~~

</details>

<details><summary>Attempt 7: <code>01a13097-6dd8-7000-9579-eb1a740b3e50</code> (64ce2bb, clean state #3)</summary>

Link tool results the agent received:

~~~~~text
seq 30818: [monad: quoted history from a search of session history for "meshyy scrolling" (30 hits).]
    hits in order: 096c02c8(prompt 10789), 01a13097(agent 30779), 43a93522(prompt 53), 909981df(agent 690), 01a13097(prompt 30776), 909981df(prompt 550), 096c02c8(prompt 12130), e44e94aa(prompt 13329), 63a8d06a(prompt 16732), 18ab714b(prompt 13924), 096c02c8(agent 12022), 909981df(agent 686), e44e94aa(prompt 13237), 706fcb26(agent 14623), 2a4e58ba(agent 12917), 0c585f12(agent 12708), 43a93522(agent 240), 70859e47(prompt 12458), efdff963(prompt 13969), 714049a6(prompt 13061) ...
seq 30834: [monad: quoted history from session 58aa12e1-dc4b-8cce-969a-748ffe4ecb01 "Investigate inconsistent tmux scrolling" seq 22293-30811.]
seq 30851: [monad: quoted history from session 4456fae5-2954-85ce-ad4a-d2537614e8af "Investigate inconsistent tmux scrolling" seq 17407-17482.]
seq 30863: [monad: quoted history from session 4456fae5-2954-85ce-ad4a-d2537614e8af "Investigate inconsistent tmux scrolling" seq 17483-30849.]
seq 30879: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 460-30799.]
seq 30922: [monad: quoted history from the session list (24 sessions).]
seq 30934: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 13924-30899.]
seq 30946: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 16732-16847.]
~~~~~

`monad show 01a13097-6dd8-7000-9579-eb1a740b3e50`:

~~~~~text
session 01a13097-6dd8-7000-9579-eb1a740b3e50 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 30774] session created in /Users/acx (interactive, claude-acp)
[seq 30776] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 30779-30782] agent: I'll search monad's session history for meshyy scrolling work.
[seq 30783] tool ToolSearch (other) -> completed
[seq 30791] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30797] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 search (caller) query "meshyy scrolling"
[seq 30820-30823] agent: Two eras of work here. Reading the key sessions.
[seq 30824] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30831] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 58aa12e1-dc4b-8cce-969a-748ffe4ecb01
[seq 30836-30840] agent: That one died on a session limit. Checking the sibling investigation and the October work.
[seq 30841] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30848] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 4456fae5-2954-85ce-ad4a-d2537614e8af
[seq 30853] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30860] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 4456fae5-2954-85ce-ad4a-d2537614e8af
[seq 30865-30868] agent: That's the August root-cause report. Now the October follow-up work.
[seq 30869] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30876] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 30881] tool mcp__monad-sessions__sessions_read (other) -> failed; permission: allow_once by policy:interactive
[seq 30888] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) refused: no session 18ab714b-a1a8-4a3a-8361-bf236851821f
[seq 30891] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 30897] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 list (caller)
[seq 30924] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30931] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 30936] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30943] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) target 63a8d06a-292c-8b11-bfa9-ac409056a817
[seq 30948] tool mcp__monad-sessions__sessions_read (other) -> failed; permission: allow_once by policy:interactive
[seq 30955] access: 01a13097-6dd8-7000-9579-eb1a740b3e50 read (caller) refused: no session e44e94aa-8a8a-8c9a-afa4-16ef21cdb255
[seq 30958] tool cd /Users/acx/Developer/github/meshyy 2>/dev/null && gh pr view 68 --json number,title,state,mergedAt,statusCheckRollup --jq '{n:.number,t:.title,s:.state,m:.mergedAt,checks:[.statusCheckRollup[]|{name,conclusion}]}' 2>&1 | head -30; echo "--- app PRs ---"; gh pr list --repo AaronCx/a-plus-terminal --state open --limit 10 2>&1 | head -20 (execute) paths: /Users/acx/Developer/github/meshyy, /dev/null -> completed
[seq 30965-31326] agent: Found it. Two phases: an August root-cause investigation, and an October push that added instrumentation but did **not** fix the scrolling.

## What broke (Aug 7, session `4456fae5`, "Investigate inconsistent tmux scrolling")

Symptom: over meshyy (never plain SSH), swipes inside tmux+Claude Code sometimes scrolled, sometimes were dead. The decision point is `ScrollBridge`, which routes a swipe from the app-side SwiftTerm emulator's belief about mouse/alt-screen mode - believe "mouse off" in a fullscreen TUI and the swipe goes to native scrollback, i.e. nowhere.

Four defects, three fixed:

1. **The wire was unordered.** meshyy used per-kind QUIC streams; the daemon switched output from the control stream to the pty stream at the first keystroke, after which `modes`/`termios` frames raced pty bytes. An overtaken modes frame silently undoes the arming it asserts. Inbound, resize raced keystrokes. **Fixed** - control+pty share one `ChannelKind.wireLane` both directions (blobs keep their own).
2. **`modeEscapes` disarmed what it had just armed.** It emitted `?1006l` *after* the mouse family; SwiftTerm reads `?1006l` as `mouseMode = .off`. Asserting `{1000}` synthesized its own disarm. **Fixed** - 1006 settles first, red-then-green in `ModeSynthesisTests`.
3. **`transport.output` used `.bufferingNewest(512)`.** Bytes already counted into `consumedOffset` could be dropped under backlog and never replayed - permanent emulator desync, and if the dropped chunk held `?1000h`, swipes stayed dead until tmux's next pulse. **Fixed** - unbounded, matching MeshyySession's policy one hop upstream.
4. The flapper turned out to be **tmux itself**: on every WINCH redraw (so every keyboard show/dismiss on a phone) tmux 3.6a pulses `?1006l ?1000l ?1002l ?1003l` then re-arms. Claude Code's own mode changes never reach the outer stream. So the race was constant in normal use rather than rare.

Measured after the fix: belief settles ≤52 ms, 8/8 reattach cycles correct, 0 stuck-wrong windows.

## Left unfixed - explicitly reported, never implemented

- **Dead-transport windows** - judged the most frequent real-world dead swipe. A QUIC path change black-holes silently; ~3–4 s until heartbeat detection and reconnect, during which the outbox drops wheel events at `try? await meshyy.send` (`SessionManager.swift:1366`). Self-healing, which matches "works inconsistently."
- **Alt-screen belief is structurally wrong after every reconnect.** `resetToInitialState()` wipes it, replay anchors postdate `?1049h`, 1049 isn't tracked, and the app does `case .screenMode: break`. Only masked because mouse-on routes to sgrWheel anyway. Recommended fix (plumb `.screenMode` into a session field ScrollBridge prefers) was never built.
- **ScrollBridge per-swipe deadness**, transport-agnostic: 0.3 s stationary hold suspends the pan, the `|vy|>|vx|` gate rejects diagonal starts, and `activeMode` latches at `.began` so a swipe straddling a tmux pulse keeps the stale route (`ScrollBridge.swift:135-154`).
- `rebuilt()` discards chunks left in the old output stream at suspend - same counted-but-unfed loss class as the 512 cap.

Also messy: a concurrent Claude session committed the shared app worktree mid-run, sweeping the synthesis fix into `933fa57` on `by-the-book`; commit `800596d` is **mislabeled** (its message describes the synthesis fix, its diff is a temporary buffering revert).

## October 11–12: observability, not a fix

The current effort (`43a93522` and children) states it plainly - *"Scrolling is not fixed: everything so far adds observation and tests."*

- **PR A shipped**: meshyy #66/#67 merged as v0.1.22, a+Terminal #155 merged to develop, **TestFlight build 75** carries a Settings → Diagnostics → Scroll trace screen. Aaron was Pushovered to capture a trace on the next dead swipe - **that trace has not come back yet**, and the plan ends with "wait for Aaron's trace."
- **PR B (oracle: judge every meshyy swipe against real SSH by what tmux actually did)** is unfinished. meshyy **#68 is still open and `build-test` is red right now** (I just checked - lint and clean-room pass). The app half is mid-flight in session `18ab714b`, still needs the 1006-ordering mutation run and a `docs/qa/mutation-log.md`.
- **PR C never written** - `docs/qa/scroll-divergence-audit.md`, the write-up of fix options and costs. The evidence for it is already measured in `~/Developer/cc-sessions/scroll-evidence/`: with tmux mouse **off** on a fresh emulator, meshyy sends *nothing* where SSH sends arrow keys; a true path change loses the swipe with no send error; a 4 s hole delivers 4–5.5 s late but never loses.
- Separately, session `63a8d06a` is gating the whole scroll-trace feature behind `#if MESHYY` so it stays out of the 1.0.4 App Store build.

Net: the ordering and dropped-bytes bugs are fixed and tested; the *behavioral* causes of a dead swipe - transport holes, alt-screen belief, the ScrollBridge gesture gates - are diagnosed, documented, and still live in the app.
[seq 31329] turn ended (end_turn)
~~~~~

</details>

<details><summary>Attempt 8: <code>01a13099-cfe8-7000-ad10-c05ab68908d9</code> (64ce2bb, clean state #4)</summary>

Link tool results the agent received:

~~~~~text
seq 30847: [monad: quoted history from a search of session history for "meshyy scroll" (40 hits).]
    hits in order: 096c02c8(prompt 10797), 01a13099(agent 30803), 43a93522(prompt 53), 909981df(agent 698), 01a13099(prompt 30800), 909981df(prompt 558), 096c02c8(prompt 12138), e44e94aa(prompt 13337), 63a8d06a(prompt 16749), 18ab714b(prompt 13932), 096c02c8(agent 12030), 909981df(agent 694), e44e94aa(prompt 13245), 706fcb26(agent 14631), 2a4e58ba(agent 12925), 0c585f12(agent 12716), 43a93522(agent 240), 70859e47(prompt 12466), efdff963(prompt 13977), 714049a6(prompt 13069) ...
seq 30854: [monad: quoted history from the repo notes for /Users/acx/Developer/github/meshyy (0 notes).]
seq 30866: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13488-30844.]
seq 30876: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 460-30824.]
seq 30905: [monad: quoted history from the session list (20 sessions).]
seq 30925: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 13931-30888.]
seq 30935: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 16749-16805.]
~~~~~

`monad show 01a13099-cfe8-7000-ad10-c05ab68908d9`:

~~~~~text
session 01a13099-cfe8-7000-ad10-c05ab68908d9 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 30798] session created in /Users/acx (interactive, claude-acp)
[seq 30800] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 30803-30807] agent: I'll search monad's session history for the meshyy scrolling work.
[seq 30808] tool ToolSearch (other) -> completed
[seq 30816] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 30819] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30822] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 search (caller) query "meshyy scroll"
[seq 30852] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 notes_read (caller)
[seq 30856] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30860] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30863] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 30873] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 30878] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 30881] tool mcp__monad-sessions__sessions_read (other) -> failed; permission: allow_once by policy:interactive
[seq 30884] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 list (caller)
[seq 30912] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 read (caller) refused: no session 18ab714b-a1a6-8566-8361-fb236851821f
[seq 30915] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30919] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 30922] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 30932] access: 01a13099-cfe8-7000-ad10-c05ab68908d9 read (caller) target 63a8d06a-292c-8b11-bfa9-ac409056a817
[seq 30937] tool ls -la /Users/acx/Developer/github/a-plus-terminal/docs/qa/ 2>/dev/null; echo "--- evidence ---"; ls -la /Users/acx/Developer/cc-sessions/scroll-evidence/ 2>/dev/null | head -30; echo "--- meshyy PR 68 ---"; cd /Users/acx/Developer/github/meshyy 2>/dev/null && git log --oneline -3 origin/main 2>/dev/null (execute) paths: /Users/acx/Developer/github/a-plus-terminal/docs/qa/, /dev/null, /Users/acx/Developer/cc-sessions/scroll-evidence/, /Users/acx/Developer/github/meshyy -> failed; permission: cancelled by human
[seq 30945-31372] agent: Here's what the session history shows. Two distinct eras of work on this.

## Era 1 - Aug 6–7, 2026 (a+Terminal builds 62→72)

Aaron reported four times that scrolling inside tmux + Claude Code was dead or inconsistent **only over meshyy, never over plain SSH** - including "no previous window" flashing yellow in tmux's status bar. Four fixes shipped, each announced as the root cause:

| Build | Fix | Verdict in the later audit |
|---|---|---|
| 62 | Preview sheet never refocused the terminal → mode-1004 focus-out left the TUI ignoring the wheel | Real but secondary; test never driven through the sheet, never run red. Aaron said 62 was *worse* |
| 63 | meshyyd (0.1.17) tracks input modes and re-teaches them to a fresh emulator (`ScreenScanner.trackedModes`, `.modes` control frame, `MeshyyTransport.modeEscapes`) | **The tmux repro passed without the fix.** tmux re-arms the outer terminal on every attach/WINCH by itself, so the "cold emulator" theory was never shown to happen in Aaron's case |
| 70 | Three stacked defects: control+pty frames onto one QUIC lane (`wireLane`); `modeEscapes` emitted `?1006` *after* the mouse family, disarming what it just armed; `transport.output` was `.bufferingNewest(512)` and silently dropped counted bytes | The 1006 ordering doesn't bite tmux (tmux arms 1006 anyway). The lane fix and the 512-cap fix were **never shown red** - pure property tests, no chaos relay. The famous "settles in 52 ms, 8/8 cycles" figure came from a *no-tmux* loopback test with a replica of SwiftTerm, and was identical before and after the fix |
| 72 | `ScrollBridge.wheelRow` clamps the wheel row off tmux's status line (explains "no previous window") | Transport-agnostic - doesn't explain why it only happened under meshyy. The clamp test was written with the fix, never red |

The audit's blunt summary: no harness drove an actual swipe, none asserted the *outcome* (tmux `pane_in_mode`/`scroll_position`), none compared SSH vs meshyy side by side, and **not one fix was ever confirmed on Aaron's phone** - every "verified" claim was simulator, `swift test`, or CI.

## Era 2 - Oct 11–12, 2026 (last night/this morning)

A fresh session re-opened it and stated plainly: **scrolling is not fixed; everything so far adds observation and tests.** Split into PR A/B/C.

**Shipped (PR A):** meshyy v0.1.22 with mode tracing; a+Terminal #155 merged to develop → **TestFlight build 75 VALID**, with a Settings → Diagnostics → Scroll trace screen so the next dead swipe reports its own cause. Live-tested in the simulator with a real finger drag. Aaron was Pushovered to capture a trace.

**Measured divergences (meshyy vs real SSH, the evidence for PR C):**
1. **tmux mouse off + any fresh emulator** (relaunch or redial): meshyy sends **nothing**, where SSH sends arrow keys - `.screenMode` is ignored, so alt-screen belief is wrong after every reconnect
2. **True QUIC path change:** the swipe is **lost silently**, no send error (`try? await meshyy.send(data)` in the outbox, no queueing or replay)
3. **~4 s self-healing hole:** the swipe arrives 4–5.5 s late but isn't lost
4. In Aaron's actual config (tmux mouse **on**), everything matched SSH **except the path change** - i.e. #2 is the live suspect for his inconsistency

## Left unfixed

- **The user-visible bug itself.** No fix for any of the three divergences has landed - they're documented and instrumented, not repaired.
- **PR B, meshyy half (#68):** open, not merged. Oracle suite passes locally (250 tests, and went red 3/3 with the #63 fix reverted), but CI was red on two pre-existing flaky resize tests; tmux-on-CI was backed out for starving the runner.
- **PR B, app half:** the 1115-line `ScrollOracleLiveTests.swift` on branch `scroll-oracle` was still being stabilized when the session hit a usage limit mid-run. Also still owed: the 1006-ordering mutation run and a new `docs/qa/mutation-log.md` in a+Terminal.
- **PR C:** `docs/qa/scroll-divergence-audit.md` never written.
- **Older deferrals still in the code:** the `activeMode` latch at gesture `.began` keeps a stale route across tmux's WINCH mode pulse; `MeshyyTransport.rebuilt()` discards unfed chunks at suspend (same loss class as the 512 cap); `ScrollBridge`'s 0.3 s long-press suspend and diagonal-start rejection.
- **Never investigated at all:** Claude Code inline vs alt-screen, and tmux's wheel pass-through path (H3) - no test ever ran real `claude`.

Two sessions were still mid-flight as of ~14:50 today: `18ab714b` stabilizing the app oracle suite, and `63a8d06a` gating the whole Scroll-trace feature behind `#if MESHYY` so it stays out of the 1.0.4 App Store build.
[seq 31375] turn ended (end_turn)
~~~~~

</details>

## Attempts 10-12 (build 94ebaa0, sessions_search session_id)

What changed since attempt 9: commit 94ebaa0 ("feat(link): search inside one session with sessions_search session_id") adds an optional `session_id` to `sessions_search` (and `?session=` / `--session` on the control API and CLI). With it the search covers that one session only and the three-hits-per-session cap does not apply, so a model that found the right long session can find every matching region before choosing ranges to read. The tool description says so. Nothing else changed: same question, same cwd (`/Users/acx`, not a repo), same import discipline, a fresh `MONAD_HOME` per attempt, no hint in the prompt.

Build: `~/.bun/bin/bun run build` at 94ebaa0 (2026-10-12 11:25; the daemon binary carries the new `session_id` schema text). The daemon from attempt 9 (1c5b03d, pid 91393) was stopped and its state archived as `state-attempt9-runs2-6-2026-10-12`.

Attempt times (America/New_York): 10 at 11:26-11:27:54, 11 at 11:28-11:30:28, 12 at 11:31-11:32:25.

### Attempt 10: `01a130b8-f9a3-7000-9305-34f3fb0f1451` (94ebaa0, clean state #6)

The agent's Link calls (arguments as the vendor recorded them):

~~~~~text
sessions_search {"query": "scroll", "limit": 40}
notes_read {"repo": "/Users/acx/Developer/github/meshyy"}
sessions_read {"session_id": "f1b92b09-5bc5-8391-8f4e-82734a1a2b15", "from_seq": 13583, "limit": 90}
notes_read {"repo": "/Users/acx/Developer/github/a-plus-terminal"}
sessions_list {"limit": 25}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 440, "limit": 120}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 615, "limit": 150}
sessions_read {"session_id": "18ab714b-ca1a-8566-8361-fb236851821f", "from_seq": 14027, "limit": 120}
sessions_read {"session_id": "63a8d06a-292c-8b11-bfa9-ac409056a817", "from_seq": 17048, "limit": 80}
sessions_search {"query": "scroll-divergence-audit", "limit": 15}
sessions_read {"session_id": "909981df-bb28-48a9-861d-6b85f9526b21", "from_seq": 850, "limit": 20}
~~~~~

What each Link tool returned to the agent (header line of the fenced result; search hits in rank order, first 20, session prefix, row kind and first seq):

~~~~~text
seq 31211: [monad: quoted history from a search of session history for "scroll" (40 hits).]
    hits in order: 096c02c8(prompt 10892), 43a93522(agent 281), 909981df(prompt 647), 096c02c8(prompt 12233), 096c02c8(agent 10765), 909981df(agent 787), 43a93522(prompt 53), 63a8d06a(prompt 17048), e44e94aa(prompt 13432), 909981df(prompt 855), 18ab714b(prompt 14027), 2a4e58ba(agent 13020), e44e94aa(prompt 13340), 0c585f12(agent 12811), 714049a6(prompt 13164), 70859e47(prompt 12561), b441812a(prompt 12886), 0c585f12(prompt 12756), b84f31fc(prompt 12942), 706fcb26(agent 14852) ...
seq 31218: [monad: quoted history from the repo notes for /Users/acx/Developer/github/meshyy (0 notes).]
seq 31230: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13583-31207.]
seq 31237: [monad: quoted history from the repo notes for /Users/acx/Developer/github/a-plus-terminal (0 notes).]
seq 31270: [monad: quoted history from the session list (25 sessions).]
seq 31280: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 440-31245.]
seq 31292: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 615-31278.]
seq 31304: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 14027-31246.]
seq 31314: [monad: quoted history from session 63a8d06a-292c-8b11-bfa9-ac409056a817 "meshyy:rebase+gate-scrolltrace" seq 17048-17203.]
seq 31333: [monad: quoted history from a search of session history for "scroll-divergence-audit" (12 hits).]
    hits in order: 909981df(prompt 855), 43a93522(agent 490), e44e94aa(prompt 13340), 43a93522(agent 249), 18ab714b(prompt 14027), 70859e47(prompt 12561), efdff963(prompt 14198), 43a93522(prompt 426), e44e94aa(agent 13449), 066b357c(prompt 13264), bb292223(prompt 13204), fae1d038(agent 13913)
seq 31351: [monad: quoted history from session 909981df-bb28-48a9-861d-6b85f9526b21 "can you complete this Read ~/Developer/cc-sessions/aplus-1.0.4-release-brief.md " seq 850-31323.]
~~~~~

Caller: `monad show 01a130b8-f9a3-7000-9305-34f3fb0f1451` (includes the final answer):

~~~~~text
session 01a130b8-f9a3-7000-9305-34f3fb0f1451 "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 31163] session created in /Users/acx (interactive, claude-acp)
[seq 31165] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 31168-31172] agent: I'll search monad's session history for the meshyy scrolling work.
[seq 31173] tool ToolSearch (other) -> completed
[seq 31181] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31184] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31187] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 search (caller) query "scroll"
[seq 31216] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 notes_read (caller)
[seq 31220] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31224] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31227] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 31235] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 notes_read (caller)
[seq 31239] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 31241] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31244] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 list (caller)
[seq 31277] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31282] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31289] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31294] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31298] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31301] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 31311] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target 63a8d06a-292c-8b11-bfa9-ac409056a817
[seq 31316] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31319] tool cd /Users/acx/Developer/github/meshyy && git log --oneline -6 2>&1; echo "--- PR68:"; gh pr view 68 --repo AaronCx/meshyy --json state,title,mergedAt 2>&1 | head -5; echo "=== aplus develop:"; cd /Users/acx/Developer/github/a-plus-terminal && git log --oneline -5 origin/develop 2>&1; echo "--- branch:"; git status -sb 2>&1 | head -5; echo "--- audit doc:"; ls docs/qa/ 2>&1 (execute) paths: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal -> failed; permission: cancelled by human
[seq 31322] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 search (caller) query "scroll-divergence-audit"
[seq 31341] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31348] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 read (caller) target 909981df-bb28-48a9-861d-6b85f9526b21
[seq 31353-31809] agent: Read the arc across the October scroll sessions (orchestrator `43a93522`, the transcript-archaeology agent `f1b92b09`, the oracle/stabilize children, and the 1.0.4 release session `909981df`).

## What actually broke

Aaron reported dead/inconsistent scrolling four times (Aug 6–7, builds 62→71), always **meshyy-only, SSH fine**, with tmux + Claude Code. Four fixes shipped, each announced as root-caused:

| Build | Fix | Verdict from the October re-audit |
|---|---|---|
| 62 | Preview sheet's `onDismiss` never refocused the terminal → mode-1004 focus-out left the TUI ignoring the wheel | Real but secondary. Its test calls `bridge.focus()` directly, never drives the sheet, never ran red |
| 63 | "Cold emulator": a fresh emulator starts `mouseMode == .off`; daemon now tracks `trackedModes` and re-teaches them via a `.modes` frame | **The tmux repro passed *without* the fix** - tmux re-arms the outer terminal on every attach/WINCH, so it re-teaches by itself. Real for non-tmux programs; probably not Aaron's case. The tmux test was deleted and replaced with a no-tmux flood test |
| 70 | Three stacked defects: control+pty frames onto one QUIC lane; `modeEscapes` emitted `?1006l` *after* arming the mouse (disarming it); `transport.output` was `.bufferingNewest(512)` and silently dropped counted bytes | The 1006 order only bites programs that arm mouse *without* SGR - tmux arms `{1,1000,1002,1006,2004}`, so it was already fine. Lane fix and 512 fix were never shown red. The "settles in 52 ms, 8/8" figure came from a no-tmux loopback test with a replica of SwiftTerm, and was the same *before* the fix |
| 72 | Wheel row could land on tmux's status line → "no previous window"; `wheelRow(forY:height:rows:)` clamps to `rows-1` | Explains the symptom's mechanism, but it's transport-agnostic - doesn't explain meshyy-only. The geometry hypothesis was refuted |

The structural problem: no harness ever drove a swipe, checked the outcome (`pane_in_mode`/`scroll_position`), or compared SSH against meshyy. Every "verified" claim was simulator/`swift test`/CI; **no fix was ever confirmed on Aaron's phone.**

The Oct 11–12 work built that missing oracle and measured the real divergences in `~/Developer/cc-sessions/scroll-evidence/`:

- **tmux mouse off, any fresh emulator (relaunch or after any redial):** meshyy sends *nothing*; SSH sends arrow keys. Cause: `establish()` calls `resetToInitialState()` on every reconnect, and `MeshyyTransport` ignores `.screenMode`, so alt-screen belief is never restored (1049 isn't in `trackedModes`).
- **True QUIC path change:** the swipe is lost **silently** - `try? await meshyy.send(data)` in `startOutbox()` snapshots the transport and raises no error.
- **A 4 s healing hole:** swipe arrives 4–5.5 s late, never lost (heartbeat 1 s × 3 misses + reconnect).
- **Aaron's actual setup (tmux mouse *on*):** everything matched SSH except the path change.

## What was left unfixed

Scrolling itself. As of the last session, the October work added **observation, not repair**:

**Shipped:** PR A - meshyy `v0.1.22` + a+Terminal #155, build 75 on TestFlight with the Scroll trace diagnostic (Settings → Diagnostics → Scroll trace → Send to inbox). Aaron was Pushovered to capture a dead swipe. **That trace has not come back yet** - it's the gating input.

**Open work:**
1. **meshyy #68** (the SSH-vs-meshyy oracle suite) - not merged. Chased all evening: the new `ModeTraceTests` leaked sessions and blocked threads, starving two older resize tests on GitHub's 3-core runner; narrowed to one blocking-wait test, rewrote it non-blocking, injectable trace sink, probes in flight. Local `make check` green (250 tests).
2. **a+Terminal half of PR B** - `ScrollOracleLiveTests.swift` on branch `scroll-oracle`, uncommitted/unpushed. Last run had 3 tests green (224 s), then the ring-overrun step was backed out to a patch file because it pegged the network queue; a two-consecutive-run verification was still pending when the session ended. The 1006-ordering mutation run and a+Terminal's `docs/qa/mutation-log.md` are still to do.
3. **PR C, `docs/qa/scroll-divergence-audit.md`** - never written. It's the doc the oracle's `XCTExpectFailure` messages point at, so those strict expected-failures currently reference a nonexistent file.

**Known divergences still live in shipped code:**
- alt-screen belief wrong after every reconnect (`.screenMode` ignored; fix is to plumb it into a field ScrollBridge prefers - *not* to synthesize `?1049h`, which blanks the buffer)
- wheel bytes swallowed during the silent dead window (no queueing/replay in the outbox)
- `activeMode` latched at `.began`, so a swipe starting inside tmux's WINCH disarm/rearm window keeps the stale route
- `rebuilt()` discards chunks left in the old output stream at suspend - same counted-but-unfed loss class as the old 512 cap
- `ScrollBridge` per-swipe gates (0.3 s long-press suspend, diagonal rejection) - transport-agnostic, untouched

Separately, the 1.0.4 release session has now gated the whole Scroll trace feature behind `#if MESHYY` so it stays out of the App Store candidate (build 76) - PRs B and C will need to rebase onto that compile-out.
[seq 31812] turn ended (end_turn)
~~~~~

Streamed output of `monad run` (tool progress lines dropped):

~~~~~text
session: 01a130b8-f9a3-7000-9305-34f3fb0f1451
I'll search monad's session history for the meshyy scrolling work.
access: this session ran search for "scroll"
access: this session ran notes_read
access: this session ran read on f1b92b09
access: this session ran notes_read
access: this session ran list
access: this session ran read on 43a93522
access: this session ran read on 43a93522
access: this session ran read on 18ab714b
access: this session ran read on 63a8d06a
access: this session ran search for "scroll-divergence-audit"
permission requested: cd /Users/acx/Developer/github/meshyy && git log --oneline -6 2>&1; echo "--- PR68:"; gh pr view 68 --repo AaronCx/meshyy --json state,title,mergedAt 2>&1 | head -5; echo "=== aplus develop:"; cd /Users/acx/Developer/github/a-plus-terminal && git log --oneline -5 origin/develop 2>&1; echo "--- branch:"; git status -sb 2>&1 | head -5; echo "--- audit doc:"; ls docs/qa/ 2>&1
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
access: this session ran read on 909981df
(the answer that follows is identical to the caller's final answer above)
~~~~~

Target: `monad show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 31100` (the access events this attempt left):

~~~~~text
session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"
[seq 31188] access: 01a130b8-f9a3-7000-9305-34f3fb0f1451 search (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2 query "scroll"
~~~~~

`monad ls --repo ~/Developer/github/meshyy --all` (the 096c02c8 line, and the asking session's line when it is listed):

~~~~~text
01a130b8-f9a3-7000-9305-34f3fb0f1451  idle                    interactive  -       "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"  /Users/acx  2026-10-12T15:27:54.233Z
    repos: /Users/acx/Developer/github/a-plus-terminal, /Users/acx/Developer/github/meshyy
...
096c02c8-1e54-4bcc-8520-de007e67c9f2  imported                interactive  -       "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"  /Users/acx  2026-08-10T22:28:26.546Z
    repos: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal, /opt/homebrew, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/SwiftTerm, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/meshyy
...
(100 lines in all)
~~~~~

Assessment (attempt 10):

| criterion | result | evidence |
|---|---|---|
| `monad import` run, summary recorded | PASS | `imported 31162 event(s): 253 new session(s), 0 updated` (see Import summaries) |
| finds 096c02c8 via sessions_search | PASS (found, then passed over) | first search "scroll": `096c02c8(prompt 10892)` is hit 1, with `096c02c8(prompt 12233)` and `096c02c8(agent 10765)` at 4 and 5 |
| reads the right seq range(s) with sessions_read | FAIL | no `sessions_read` of 096c02c8 at all, and no `session_id` search; it read `f1b92b09` ("understand:transcript", the October digest of 096c02c8) first, then 43a93522 (x2), 18ab714b, 63a8d06a, 909981df |
| answer: four reports | PARTIAL | "Aaron reported dead/inconsistent scrolling four times (Aug 6-7, builds 62->71)" and a table of the 62/63/70/72 fixes, but the four reports themselves are not named; taken from the digest, not from 096c02c8 |
| answer: build 72 status-row clamp | PASS (content) | "72 / Wheel row could land on tmux's status line -> 'no previous window'; `wheelRow(forY:height:rows:)` clamps to `rows-1`" |
| answer: the two deferred items named to Aaron | FAIL (content right, attribution wrong) | alt-screen belief wrong after every reconnect, and wheel bytes swallowed during the silent dead window, both listed as "known divergences still live in shipped code" from the October work, not as the two items deferred and named to Aaron in August |
| `monad ls --repo ~/Developer/github/meshyy --all` lists 096c02c8 | PASS | the 096c02c8 line above |
| 096c02c8's log has access events from the asking session | PARTIAL | `search (target)` only; there is no read event because it never read 096c02c8 |

Attempt 10: **FAIL.** The same digest path as attempts 6 and 8.

### Attempt 11: `01a130ba-e999-7000-9bc1-bacf185081da` (94ebaa0, clean state #7)

The agent's Link calls (arguments as the vendor recorded them):

~~~~~text
sessions_search {"query": "meshyy scroll", "limit": 40}
notes_read {"repo": "/Users/acx/Developer/github/meshyy"}
sessions_read {"session_id": "f1b92b09-5bc5-8391-8f4e-82734a1a2b15", "from_seq": 13590, "limit": 12}
sessions_list {"repo": "/Users/acx/Developer/github/meshyy", "limit": 30}
sessions_search {"query": "root cause clamp scrollback", "session_id": "43a93522-3701-437a-a02a-60a68db2c782", "limit": 30}
sessions_read {"session_id": "f1b92b09-5bc5-8391-8f4e-82734a1a2b15", "from_seq": 13670, "limit": 10}
sessions_search {"query": "deferred remaining not fixed dead window alt-screen belief", "session_id": "43a93522-3701-437a-a02a-60a68db2c782", "limit": 25}
sessions_read {"session_id": "18ab714b-ca1a-8566-8361-fb236851821f", "from_seq": 14030, "limit": 8}
sessions_search {"query": "divergence", "session_id": "43a93522-3701-437a-a02a-60a68db2c782", "limit": 30}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 484, "limit": 8}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 800, "limit": 60}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 497, "limit": 90}
sessions_search {"query": "XCTExpectFailure divergence MEASURE result", "session_id": "18ab714b-ca1a-8566-8361-fb236851821f", "limit": 20}
~~~~~

What each Link tool returned to the agent (header line of the fenced result; search hits in rank order, first 20, session prefix, row kind and first seq):

~~~~~text
seq 31216: [monad: quoted history from a search of session history for "meshyy scroll" (40 hits).]
    hits in order: 096c02c8(prompt 10901), 43a93522(prompt 53), 909981df(agent 796), 909981df(prompt 656), 096c02c8(prompt 12242), e44e94aa(prompt 13441), 63a8d06a(prompt 17057), 18ab714b(prompt 14036), 096c02c8(agent 12134), 909981df(agent 792), e44e94aa(prompt 13349), 706fcb26(agent 14861), 2a4e58ba(agent 13029), 0c585f12(agent 12820), 43a93522(agent 240), 70859e47(prompt 12570), efdff963(prompt 14207), 714049a6(prompt 13173), b441812a(prompt 12895), 43a93522(agent 490) ...
seq 31223: [monad: quoted history from the repo notes for /Users/acx/Developer/github/meshyy (0 notes).]
seq 31235: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13590-13612.]
seq 31273: [monad: quoted history from the session list (30 sessions).]
seq 31284: [monad: quoted history from a search of session history for "root cause clamp scrollback" (0 hits).]
    hits in order: (none)
seq 31294: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13670-31256.]
seq 31305: [monad: quoted history from a search of session history for "deferred remaining not fixed dead window alt-screen belief" (0 hits).]
    hits in order: (none)
seq 31315: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 14035-14047.]
seq 31327: [monad: quoted history from a search of session history for "divergence" (3 hits).]
    hits in order: 43a93522(agent 490), 43a93522(agent 249), 43a93522(prompt 426)
seq 31339: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 484-496.]
seq 31351: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 31193-31337.]
seq 31363: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 497-31349.]
seq 31375: [monad: quoted history from a search of session history for "XCTExpectFailure divergence MEASURE result" (1 hits).]
    hits in order: 18ab714b(prompt 14036)
~~~~~

Caller: `monad show 01a130ba-e999-7000-9bc1-bacf185081da` (includes the final answer):

~~~~~text
session 01a130ba-e999-7000-9bc1-bacf185081da "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 31172] session created in /Users/acx (interactive, claude-acp)
[seq 31174] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 31177] tool ToolSearch (other) -> completed
[seq 31185] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31188] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31191] access: 01a130ba-e999-7000-9bc1-bacf185081da search (caller) query "meshyy scroll"
[seq 31221] access: 01a130ba-e999-7000-9bc1-bacf185081da notes_read (caller)
[seq 31225] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31229] tool mcp__monad-sessions__sessions_list (other) -> completed; permission: allow_once by policy:interactive
[seq 31232] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 31241] access: 01a130ba-e999-7000-9bc1-bacf185081da list (caller)
[seq 31275] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31279] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31282] access: 01a130ba-e999-7000-9bc1-bacf185081da search (caller) query "root cause clamp scrollback"
[seq 31291] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 31296] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31300] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31303] access: 01a130ba-e999-7000-9bc1-bacf185081da search (caller) query "deferred remaining not fixed dead window alt-screen belief"
[seq 31312] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 31317] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31324] access: 01a130ba-e999-7000-9bc1-bacf185081da search (caller) query "divergence"
[seq 31329] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31336] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31341] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31348] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31353] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31360] access: 01a130ba-e999-7000-9bc1-bacf185081da read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31365] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31372] access: 01a130ba-e999-7000-9bc1-bacf185081da search (caller) query "XCTExpectFailure divergence MEASURE result"
[seq 31377-31817] agent: Read through monad's session history for meshyy/a+Terminal scrolling - the arc spans two campaigns: the August fix rounds (session `096c02c8` + subagent investigation) and the October 11–12 audit/instrumentation campaign (`43a93522` and ~15 spawned sessions).

## What Aaron actually reported

Four reports, all **meshyy-only, SSH fine**, all tmux + Claude Code:

1. **Aug 6** (pre-62) - returning from the in-app preview kills scrolling in chat.
2. **Aug 6** (build 62) - "even worse now", can't scroll inside tmux at all under meshyy.
3. **Aug 7** (~69) - "works inconsistently."
4. **Aug 7** (build 71) - swiping flips tmux's status bar yellow with **"no previous window"**.

## The four fix rounds, and what the October audit found wrong with them

| Build | Shipped fix | Audit verdict (session `f1b92b09`) |
|---|---|---|
| 62 | Refocus terminal on preview `onDismiss` (`TerminalScreen.swift`) | Real but secondary; the test called `bridge.focus()` directly, never drove the sheet, never ran red |
| 63 | Daemon tracks DEC modes and re-teaches a fresh emulator (meshyy #48/#49 → 0.1.17, app #137) | Declared "the disease" - but **H63 was never reproduced with tmux**; the tmux repro *passed without the fix* (replay + tmux's own attach pulse re-arm), so the tmux test was deleted and replaced with a no-tmux flood test |
| 70 | 3 defects: control/pty frames share one QUIC lane (meshyy #63), `modeEscapes` emitted `?1006l` after arming the mouse family, `transport.output` `.bufferingNewest(512)` → unbounded | The 1006 reorder **can't bite tmux** (tmux arms 1006 anyway); the lane fix and the 512-cap fix were never shown red; the "settles in 52 ms, 8/8 cycles" figure came from a **no-tmux, loopback, replica-belief** test and was identical before and after the fix |
| 72 | `ScrollBridge.wheelRow(forY:height:rows:)` clamps the wheel row off tmux's status line (#147) | Explains the "no previous window" *mechanism*, but the clamp is transport-agnostic - the only meshyy-specific theory (geometry mismatch) was **refuted** by a live test |

Bottom line from that audit: no fix was ever confirmed on Aaron's phone, every "verified end to end" claim was simulator/`swift test`/CI, and **nothing explains the meshyy-only part**.

## What the October campaign actually measured (real daemon + chaos relay)

- **tmux mouse *off*, any fresh emulator** (relaunch, any redial): meshyy **sends nothing** while SSH sends arrow keys - `MeshyyTransport` ignores `.screenMode`, and `resetToInitialState()` on reconnect wipes alt-screen belief, so `ScrollBridgeCore` routes `.native` = dead swipe.
- **True network path change**: the swipe is **lost silently** - `try? await meshyy.send(data)` in `startOutbox()` (`SessionManager.swift:1400`) swallows wheel bytes with no error, queueing, or replay.
- **A 4 s healing hole**: swipe arrives **4–5.5 s late**, never lost (matches "works after a few seconds").
- **Aaron's own config (tmux mouse on)**: matched SSH on everything **except** the path change.

## Left unfixed

Scrolling is **not fixed** - everything since August adds observation and tests. Still live in the code:

1. **Alt-screen belief wrong after every reconnect** - `.screenMode` not plumbed into a field ScrollBridge prefers; mode 1049 isn't in `trackedModes`. Masked only while mouse belief is on.
2. **Wheel bytes dropped during the ~3–4 s dead-transport window** (heartbeat 1 s × 3 misses) - no retry/queue.
3. **`activeMode` latched at gesture `.began`** (`ScrollBridge.swift:160-168`), so a swipe starting inside tmux's WINCH disarm/rearm pulse keeps the stale route for the whole gesture.
4. **`rebuilt()`** (`MeshyyTransport.swift:412`) discards counted-but-unfed chunks at suspend - same loss class as the 512 cap.
5. **Per-swipe gates**: 0.3 s stationary long-press suspends the pan; diagonal starts rejected.
6. **The meshyy-only "no previous window"** still has no explanation.

## In flight as of today

- **PR A shipped**: meshyy 0.1.22 + app #155 merged; **TestFlight build 75 VALID** with Settings → Diagnostics → **Scroll trace**. Aaron was Pushovered to capture a dead swipe and send the trace - **that's the gating item**.
- **meshyy #68** (ssh-vs-meshyy oracle suite) open, not merged. Its CI reds turned out to be self-inflicted: the new ModeTrace suite left sessions running and blocked threads, starving GitHub's 3-core runner; injectable-sink/non-blocking fixes were being probed when the session stopped.
- **a+Terminal PR B** (`ScrollOracleLiveTests.swift`, real SwiftTerm + real finger drags, outcome asserted via tmux `pane_in_mode`/`scroll_position`) restarted 14:47 today, still running. Still owes the 1006-ordering mutation and `docs/qa/mutation-log.md`.
- **PR C not written**: `docs/qa/scroll-divergence-audit.md` (user impact, frequency, fix options/costs) - evidence is already in `~/Developer/cc-sessions/scroll-evidence/`.
- Separately, session `63a8d06a` is gating the scroll-trace code behind the `MESHYY` compile-out flag for the 1.0.4 release.

Two of these stops were usage-limit interruptions, not dead ends - the work is resumable (`resumeFromRunId: wf_a732c94b-7c6` for the app oracle).
[seq 31820] turn ended (end_turn)
~~~~~

Streamed output of `monad run` (tool progress lines dropped):

~~~~~text
session: 01a130ba-e999-7000-9bc1-bacf185081da
access: this session ran search for "meshyy scroll"
access: this session ran notes_read
access: this session ran read on f1b92b09
access: this session ran list
access: this session ran search for "root cause clamp scrollback"
access: this session ran read on f1b92b09
access: this session ran search for "deferred remaining not fixed dead window alt-screen belief"
access: this session ran read on 18ab714b
access: this session ran search for "divergence"
access: this session ran read on 43a93522
access: this session ran read on 43a93522
access: this session ran read on 43a93522
access: this session ran search for "XCTExpectFailure divergence MEASURE result"
(the answer that follows is identical to the caller's final answer above)
~~~~~

Target: `monad show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 31100` (the access events this attempt left):

~~~~~text
session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"
[seq 31192] access: 01a130ba-e999-7000-9bc1-bacf185081da search (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2 query "meshyy scroll"
[seq 31260] access: 01a130ba-e999-7000-9bc1-bacf185081da list (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2
~~~~~

`monad ls --repo ~/Developer/github/meshyy --all` (the 096c02c8 line, and the asking session's line when it is listed):

~~~~~text
096c02c8-1e54-4bcc-8520-de007e67c9f2  imported                interactive  -       "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"  /Users/acx  2026-08-10T22:28:26.546Z
    repos: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal, /opt/homebrew, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/SwiftTerm, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/meshyy
...
(100 lines in all)
~~~~~

Assessment (attempt 11):

| criterion | result | evidence |
|---|---|---|
| `monad import` run, summary recorded | PASS | `imported 31171 event(s): 253 new session(s), 0 updated` |
| finds 096c02c8 via sessions_search | PASS (found, then passed over) | first search "meshyy scroll": `096c02c8(prompt 10901)` is hit 1, with `096c02c8(prompt 12242)` and `096c02c8(agent 12134)` at 5 and 9 |
| reads the right seq range(s) with sessions_read | FAIL | no `sessions_read` of 096c02c8. It is the only attempt that used the new `session_id`, four times, but on 43a93522 (three times) and 18ab714b, never on 096c02c8; it read f1b92b09 (x2), 18ab714b and 43a93522 (x3) |
| answer: four reports | PASS (content; source is the digest) | "1. Aug 6 (pre-62) - returning from the in-app preview kills scrolling ... 2. Aug 6 (build 62) - ... can't scroll inside tmux at all ... 3. Aug 7 (~69) - works inconsistently. 4. Aug 7 (build 71) - ... 'no previous window'", matching the ground truth, taken from f1b92b09 |
| answer: build 72 status-row clamp | PASS | "72 / `ScrollBridge.wheelRow(forY:height:rows:)` clamps the wheel row off tmux's status line (#147)" |
| answer: the two deferred items named to Aaron | FAIL (content right, attribution wrong) | "Alt-screen belief wrong after every reconnect ... Masked only while mouse belief is on" and "Wheel bytes dropped during the ~3-4 s dead-transport window" are both there, with the ground truth's details, but as what the October campaign measured, not as the two items deferred and named to Aaron in August |
| `monad ls --repo ~/Developer/github/meshyy --all` lists 096c02c8 | PASS | the 096c02c8 line above (the asking session ran no shell command, so it touched no repo and is not listed) |
| 096c02c8's log has access events from the asking session | PARTIAL | `search (target)` and `list (target)`; no read event |

Attempt 11: **FAIL.** Two of its `session_id` searches ("root cause clamp scrollback", "deferred remaining not fixed dead window alt-screen belief") returned 0 hits: FTS5 joins the words of a query with AND, and no single row of 43a93522 holds all of them. That did not cause the failure (it was searching 43a93522, not 096c02c8), but a model that writes long natural-language queries gets nothing back from them.

### Attempt 12: `01a130bd-0f85-7000-9a80-7627ce9983df` (94ebaa0, clean state #8 (left running))

The agent's Link calls (arguments as the vendor recorded them):

~~~~~text
sessions_search {"query": "meshyy scroll", "limit": 40}
notes_read {"repo": "/Users/acx/Developer/github/meshyy"}
sessions_read {"session_id": "f1b92b09-5bc5-8391-8f4e-82734a1a2b15", "from_seq": 13562, "limit": 150}
sessions_read {"session_id": "18ab714b-ca1a-8566-8361-fb236851821f", "from_seq": 14030, "limit": 120}
sessions_search {"query": "scroll-divergence-audit", "limit": 20}
sessions_read {"session_id": "909981df-bb28-48a9-861d-6b85f9526b21", "from_seq": 855, "limit": 40}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 480, "limit": 30}
sessions_read {"session_id": "43a93522-3701-437a-a02a-60a68db2c782", "from_seq": 530, "limit": 60}
~~~~~

What each Link tool returned to the agent (header line of the fenced result; search hits in rank order, first 20, session prefix, row kind and first seq):

~~~~~text
seq 31235: [monad: quoted history from a search of session history for "meshyy scroll" (40 hits).]
    hits in order: 096c02c8(prompt 10901), 43a93522(prompt 53), 909981df(agent 796), 909981df(prompt 656), 096c02c8(prompt 12242), e44e94aa(prompt 13441), 63a8d06a(prompt 17072), 18ab714b(prompt 14036), 096c02c8(agent 12134), 909981df(agent 792), e44e94aa(prompt 13349), 706fcb26(agent 14867), 2a4e58ba(agent 13029), 0c585f12(agent 12820), 43a93522(agent 240), 70859e47(prompt 12570), efdff963(prompt 14213), 714049a6(prompt 13173), b441812a(prompt 12895), 43a93522(agent 490) ...
seq 31242: [monad: quoted history from the repo notes for /Users/acx/Developer/github/meshyy (0 notes).]
seq 31259: [monad: quoted history from session f1b92b09-5bc5-8391-8f4e-82734a1a2b15 "understand:transcript" seq 13562-31232.]
seq 31269: [monad: quoted history from session 18ab714b-ca1a-8566-8361-fb236851821f "stabilize" seq 14035-31216.]
seq 31294: [monad: quoted history from a search of session history for "scroll-divergence-audit" (12 hits).]
    hits in order: 909981df(prompt 864), 43a93522(agent 490), e44e94aa(prompt 13349), 43a93522(agent 249), 18ab714b(prompt 14036), 70859e47(prompt 12570), efdff963(prompt 14213), 43a93522(prompt 426), e44e94aa(agent 13458), 066b357c(prompt 13273), bb292223(prompt 13213), fae1d038(agent 13922)
seq 31315: [monad: quoted history from session 909981df-bb28-48a9-861d-6b85f9526b21 "can you complete this Read ~/Developer/cc-sessions/aplus-1.0.4-release-brief.md " seq 855-31284.]
seq 31325: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 480-529.]
seq 31337: [monad: quoted history from session 43a93522-3701-437a-a02a-60a68db2c782 "can you read and complete this ~/Developer/cc-sessions/start-meshyy-scroll.sh" seq 530-622.]
~~~~~

Caller: `monad show 01a130bd-0f85-7000-9a80-7627ce9983df` (includes the final answer):

~~~~~text
session 01a130bd-0f85-7000-9a80-7627ce9983df "what broke with meshyy scrolling, and what was left unfixed? Look through monad'"
[seq 31187] session created in /Users/acx (interactive, claude-acp)
[seq 31189] user: what broke with meshyy scrolling, and what was left unfixed? Look through monad's session history.
[seq 31192-31195] agent: I'll search monad's session history for this.
[seq 31196] tool ToolSearch (other) -> completed
[seq 31204] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31207] tool mcp__monad-sessions__notes_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31210] access: 01a130bd-0f85-7000-9a80-7627ce9983df search (caller) query "meshyy scroll"
[seq 31240] access: 01a130bd-0f85-7000-9a80-7627ce9983df notes_read (caller)
[seq 31244-31248] agent: Found two eras of work. Reading the key ranges.
[seq 31249] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31253] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31256] access: 01a130bd-0f85-7000-9a80-7627ce9983df read (caller) target f1b92b09-5bc5-8391-8f4e-82734a1a2b15
[seq 31266] access: 01a130bd-0f85-7000-9a80-7627ce9983df read (caller) target 18ab714b-ca1a-8566-8361-fb236851821f
[seq 31271] tool cd /Users/acx/Developer/github/a-plus-terminal 2>/dev/null && git log --oneline -5 && echo "--- branches ---" && git branch -a --format='%(refname:short) %(committerdate:short)' | head -20 && echo "--- divergence audit ---" && ls -la docs/qa/ 2>/dev/null (execute) paths: /Users/acx/Developer/github/a-plus-terminal, /dev/null -> failed; permission: cancelled by human
[seq 31274] tool mcp__monad-sessions__sessions_search (other) -> completed; permission: allow_once by policy:interactive
[seq 31283] access: 01a130bd-0f85-7000-9a80-7627ce9983df search (caller) query "scroll-divergence-audit"
[seq 31296-31304] agent: Permission for that shell call was declined, so I'll stay in the session history. Reading the most recent state.
[seq 31305] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31309] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31312] access: 01a130bd-0f85-7000-9a80-7627ce9983df read (caller) target 909981df-bb28-48a9-861d-6b85f9526b21
[seq 31322] access: 01a130bd-0f85-7000-9a80-7627ce9983df read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31327] tool mcp__monad-sessions__sessions_read (other) -> completed; permission: allow_once by policy:interactive
[seq 31334] access: 01a130bd-0f85-7000-9a80-7627ce9983df read (caller) target 43a93522-3701-437a-a02a-60a68db2c782
[seq 31339-31799] agent: ## What Aaron actually reported

Four reports, all **meshyy-only, SSH fine** (session `096c02c8`, Aug 6–7):

1. Aug 6 17:42 - return from preview → scrolling stops in chat
2. Aug 6 21:19 (build 62) - "worse now, not able to scroll inside the TMUX session at all when in meshyy"
3. Aug 7 18:04 (~build 69) - "tmux in cc... works inconsistently"
4. Aug 7 19:48 (build 71) - swipe turns the tmux status bar yellow with **"no previous window"**

## What got fixed, and how solid each one is

| Build | Fix | Verdict |
|---|---|---|
| 62 | Refocus terminal on preview-sheet dismiss (`TerminalScreen.swift`, app PR #136) | Real, but secondary. Its test calls `bridge.focus()` directly - never exercises the `onDismiss` fix site, never run red. |
| 63 | Daemon tracks terminal modes and re-teaches them on every fresh attach (meshyy #48/#49 → 0.1.17, app #137 `MeshyyTransport.modeEscapes`) | Shipped as "the disease." **Probably not Aaron's bug**: the tmux repro *passed without the fix*, and build 70 later measured why - tmux re-arms the outer terminal on every attach/WINCH by itself. Real for non-tmux programs. |
| 70 | Three defects: (a) control + pty frames forced onto one QUIC lane (`StreamFraming.swift:42` `wireLane`), (b) `modeEscapes` emitted `?1006` *after* arming the mouse family, self-disarming (DECRST 1006 sets `mouseMode = .off`), (c) `transport.output` `.bufferingNewest(512)` → `.unbounded` (app PR #145, meshyy #63/#64 → 0.1.21) | (b) is a genuine bug but **doesn't bite tmux**, which arms 1006 itself. (a) and (c) were never shown red - no reorder was ever reproduced; the chaos relay wasn't used. The "settles within 52 ms, 8/8 cycles" headline came from a **no-tmux loopback test against a replica of SwiftTerm**, and read 51/52 ms *before* the lane fix vs 46 ms after - it doesn't discriminate the fix. |
| 72 | `ScrollBridge.wheelRow(forY:height:rows:)` clamps the wheel row off the bottom row, so a low swipe can't hit tmux's status-line previous/next-window binding (app PR #147) | Explains the "no previous window" string. But the clamp and `ScrollBridge` are **transport-agnostic**, and the only meshyy-specific theory (geometry mismatch) was explicitly refuted by `testGeometryAgreesAcrossAppDaemanAndTmux`. Unit test written with the fix, not red-checked. |

Across all four rounds, **no fix was ever confirmed on Aaron's phone** - every "verified" claim was simulator, Mac `swift test`, or CI. The Oct 11 re-read of the arc put it bluntly: the build-63 "root cause" wasn't reproduced with tmux, and build 72 doesn't explain the meshyy-only part.

## What the October re-investigation measured

The Oct 11–12 effort built the thing that was missing: a real **SSH-vs-meshyy oracle** that drives actual swipes and asserts the *outcome* via tmux (`pane_in_mode`/`scroll_position`). Measurements (logs in `~/Developer/cc-sessions/scroll-evidence/`):

- **tmux mouse off + any fresh emulator** (relaunch, any redial): meshyy sends **nothing**; SSH sends arrow keys. Dead swipe.
- **True path change**: the swipe is **lost silently**, no send error.
- **4 s healing hole**: swipe arrives 4–5.5 s late, never lost.
- **Aaron's own config (tmux mouse on)**: matched SSH on everything **except** the path change.

That last line is the important one - it narrows his remaining inconsistency to the path-change case.

## Left unfixed

The orchestrating session's own summary (Oct 12, 01:05): *"Scrolling is **not fixed**: everything so far adds observation and tests."*

Code divergences still live:

1. **Alt-screen belief wrong after every reconnect** - `resetToInitialState()` at `SessionManager.swift:999` wipes it, `1049` isn't in `trackedModes`, and `MeshyyTransport` drops `.screenMode` on the floor (`MeshyyTransport.swift:512`). Masked while mouse belief is on; with mouse off, `alt=false` routes the swipe `.native` and it dies. Fix is to plumb `.screenMode` into a field `ScrollBridge` prefers - *not* to synthesize `?1049h` (that blanks the buffer).
2. **Wheel bytes dropped during the dead transport window** - `try? await meshyy.send(data)` in `startOutbox()`, `SessionManager.swift:1400`: no error, no queue, no replay. Detection takes ~3–4 s (1 s heartbeat × 3 misses). This is the one that still matches Aaron's config.
3. **`activeMode` latched at gesture `.began`** (`ScrollBridge.swift:160-168`) - a swipe starting inside tmux's WINCH mode pulse keeps the stale route for the whole gesture. Never measured on a real network; on loopback both halves of the pulse land in one event.
4. **`rebuilt()` chunk loss** (`MeshyyTransport.swift:412`) - discards counted-but-unfed chunks at suspend, same class as the old 512 cap.

Work in flight when the session stopped (usage limit):

- **meshyy #68** (oracle suite) - open, not merged; was stuck chasing a CI flake its own `ModeTraceTests` caused by starving GitHub's 3-core runner.
- **a+Terminal PR B** - `ScrollOracleLiveTests.swift` + `test-scroll-oracle` were green on 2 consecutive runs, but still needed the 1006-ordering mutation run and `docs/qa/mutation-log.md`; a ring-overrun step was pulled out and parked as `app-oracle-ring-overrun-step.patch`.
- **PR C** - `docs/qa/scroll-divergence-audit.md` **was never written**, yet the strict `XCTExpectFailure`s in the oracle suite point at it.
- **Blocked on Aaron**: build 75 shipped the on-device Scroll trace (Settings → Diagnostics → Scroll trace → Send to inbox). The plan was to wait for a trace from a real dead swipe. Note that the 1.0.4 App Store target compiles `MeshyyTransport` out behind `#if MESHYY`, so the trace UI is gated out of build 76.
[seq 31802] turn ended (end_turn)
~~~~~

Streamed output of `monad run` (tool progress lines dropped):

~~~~~text
session: 01a130bd-0f85-7000-9a80-7627ce9983df
I'll search monad's session history for this.
access: this session ran search for "meshyy scroll"
access: this session ran notes_read
Found two eras of work. Reading the key ranges.
access: this session ran read on f1b92b09
access: this session ran read on 18ab714b
permission requested: cd /Users/acx/Developer/github/a-plus-terminal 2>/dev/null && git log --oneline -5 && echo "--- branches ---" && git branch -a --format='%(refname:short) %(committerdate:short)' | head -20 && echo "--- divergence audit ---" && ls -la docs/qa/ 2>/dev/null
  [1] Deny (reject_once)
  [2] Allow Once (allow_once)
  [3] Always Allow (allow_always)
no interactive input available; cancelling the permission request
cancelled
access: this session ran search for "scroll-divergence-audit"
Permission for that shell call was declined, so I'll stay in the session history. Reading the most recent state.
access: this session ran read on 909981df
access: this session ran read on 43a93522
access: this session ran read on 43a93522
(the answer that follows is identical to the caller's final answer above)
~~~~~

Target: `monad show 096c02c8-1e54-4bcc-8520-de007e67c9f2 --from 31100` (the access events this attempt left):

~~~~~text
session 096c02c8-1e54-4bcc-8520-de007e67c9f2 "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"
[seq 31211] access: 01a130bd-0f85-7000-9a80-7627ce9983df search (target) target 096c02c8-1e54-4bcc-8520-de007e67c9f2 query "meshyy scroll"
~~~~~

`monad ls --repo ~/Developer/github/meshyy --all` (the 096c02c8 line, and the asking session's line when it is listed):

~~~~~text
096c02c8-1e54-4bcc-8520-de007e67c9f2  imported                interactive  -       "/Users/acx/.aplusterminal-inbox/cff1f1bd-meshyy-handoff-2026-07-29.md ive been w"  /Users/acx  2026-08-10T22:28:26.546Z
    repos: /Users/acx/Developer/github/meshyy, /Users/acx/Developer/github/a-plus-terminal, /opt/homebrew, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/SwiftTerm, /Users/acx/Library/Developer/Xcode/DerivedData/aPlusTerminal-fohhspabihkckadbcadnjjjltbep/SourcePackages/checkouts/meshyy
...
(100 lines in all)
~~~~~

Assessment (attempt 12):

| criterion | result | evidence |
|---|---|---|
| `monad import` run, summary recorded | PASS | `imported 31186 event(s): 253 new session(s), 0 updated` |
| finds 096c02c8 via sessions_search | PASS (found, then passed over) | first search "meshyy scroll": `096c02c8(prompt 10901)` is hit 1, with hits 5 and 9 also from 096c02c8 |
| reads the right seq range(s) with sessions_read | FAIL | no `sessions_read` of 096c02c8 and no `session_id` search; it read f1b92b09, 18ab714b, 909981df and 43a93522 (x2) |
| answer: four reports | PASS (content; source is the digest) | "Four reports, all meshyy-only, SSH fine (session `096c02c8`, Aug 6-7): 1. Aug 6 17:42 - return from preview ... 2. Aug 6 21:19 (build 62) ... 3. Aug 7 18:04 (~build 69) ... 4. Aug 7 19:48 (build 71) ... 'no previous window'"; it names 096c02c8 as the source but took the reports from f1b92b09 |
| answer: build 72 status-row clamp | PASS | "72 / `ScrollBridge.wheelRow(forY:height:rows:)` clamps the wheel row off the bottom row, so a low swipe can't hit tmux's status-line previous/next-window binding" |
| answer: the two deferred items named to Aaron | FAIL (content right, attribution wrong) | "Alt-screen belief wrong after every reconnect ... Masked while mouse belief is on" and "Wheel bytes dropped during the dead transport window ... ~3-4 s" (plus the latch and `rebuilt()` items from the investigator's list), as code divergences still live after the October work, not as the items deferred and named to Aaron in August |
| `monad ls --repo ~/Developer/github/meshyy --all` lists 096c02c8 | PASS | the 096c02c8 line above (the asking session's one shell call was cancelled before it ran and named only a-plus-terminal, so it is not listed under meshyy) |
| 096c02c8's log has access events from the asking session | PARTIAL | `search (target)` only; no read event |

Attempt 12: **FAIL.** The best answer of the twelve on content, and the same path as attempts 6, 8, 10 and 11: the digest, not the original.

### Assessment (attempts 10-12)

| criterion | attempt 10 | attempt 11 | attempt 12 |
|---|---|---|---|
| import run, summary recorded | PASS | PASS | PASS |
| finds 096c02c8 via sessions_search | PASS (hit 1, passed over) | PASS (hit 1, passed over) | PASS (hit 1, passed over) |
| reads the right seq range(s) of 096c02c8 | FAIL (never read it) | FAIL (never read it) | FAIL (never read it) |
| used the new `session_id` on 096c02c8 | no (not used) | no (used on 43a93522, 18ab714b) | no (not used) |
| answer: four reports | PARTIAL (from the digest) | PASS on content, from the digest | PASS on content, from the digest |
| answer: build 72 status-row clamp | PASS | PASS | PASS |
| answer: two deferred items named to Aaron | FAIL (content right, attribution wrong) | FAIL (content right, attribution wrong) | FAIL (content right, attribution wrong) |
| `monad ls --repo meshyy --all` lists 096c02c8 | PASS | PASS | PASS |
| access events on 096c02c8 from the asker | PARTIAL (search only) | PARTIAL (search, list) | PARTIAL (search only) |

Why they failed, and why no fix followed: in all three, Link put 096c02c8 at hit 1 (with two more of its rows in the top ten), served every read and search it was asked for, and logged every access on both sides. The model then chose `f1b92b09` ("understand:transcript", a subagent of Aaron's October campaign whose job was to digest 096c02c8's transcript) and built its answer from that digest and from the October orchestrator 43a93522. That is the same choice as attempts 6 and 8: given a digest and the original, the model reads the digest. It is a model choice, not a monad bug, and no change to monad that does not steer the model toward the expected answer would alter it, so nothing was committed. The new `session_id` works (attempt 11 used it four times and got scoped results back) but was never pointed at 096c02c8.

One behaviour worth knowing, seen in attempt 11: a multi-word `sessions_search` query matches only rows containing every word (FTS5's implicit AND), so long natural-language queries such as "deferred remaining not fixed dead window alt-screen belief" return 0 hits even inside the right session. It did not cause this failure.

**Run 1: FAIL** (twelve attempts; the criterion "reads the right range of 096c02c8" was never met in full).
