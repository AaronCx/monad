# 0010: The App is a trigger, not a second engine

Status: accepted
Date: 2026-08-24
Context: monad M3, `packages/github` and `apps/hook`

## Question

M3 adds a GitHub App: webhooks in, Check Runs and review comments out. LastGate's App did its
own work, which is how it ended up with a check engine, a policy, a dashboard, and a trust story
spread across `apps/web`. What belongs in monad's GitHub layer, and what must not?

The sharper version of the question is the one that matters for 0009: until M3 every review was
one Aaron chose to run, so trust resolution was a safety net. After M3 the trigger is a
stranger's push, and whatever the App decides about trust is the whole boundary.

## Decision

`packages/github` is a trigger and a renderer. It may:

- verify a signature over a raw body;
- narrow a signed payload to a named shape and refuse anything else;
- resolve `trusted` or `untrusted` from fields in that payload;
- turn a `CheckRunResults` and a `ReviewReport` the engine already produced into GitHub's API
  shapes;
- talk to GitHub.

It may not run a check, hold a policy, decide what a session may execute, or re-derive anything
the engine already decided. A check or a policy added to this package is in the wrong package.

`apps/hook` is a second binary (`monad-hook`) beside `monadd`, not a route inside it. It has a
different lifetime (long running, network facing) and a different failure mode (a crash must not
take live sessions down). The two share one thing, `~/.monad/monad.db`, and own different tables
in it.

## What was decided, and what it cost

**Trust comes from the signed payload and nothing else.** The CLI's `resolveTrust` spends a
`gh api` call on the author's collaborator permission because a human is waiting. The App does
not: `pull_request.author_association` and `head.repo.full_name` are both in the payload GitHub
signed, and the App has no `gh` binary in its environment. Both facts must hold to be trusted:
the head is a branch on the base repository itself, AND the author is `OWNER`, `MEMBER`, or
`COLLABORATOR`. The fork check is not redundant with the association check. A pull request Aaron
opens from his own fork of his own repository carries `author_association: OWNER` and is still
untrusted, because the head commit lives in a repository the base repository's collaborators do
not control. What is trusted is the branch, not the person.

**There is no fallback lookup.** Two deliveries in the trigger set carry no pull request at all:
a `check_run` rerequest and an `@monad review` comment. For those, `resolveTrustFromIntent`
answers `untrusted` and says why, and the caller reads the pull request back through the
installation token and resolves again from what it gets. That is an explicit second step in
`apps/hook/src/review.ts`, not a fallback hidden inside the resolver, because a fallback is a
second code path that can only ever widen the answer. When the read fails, the delivery fails;
it does not proceed on a guess.

**`COMMENT` reviews only, at the type level.** `ReviewEvent` is the literal `"COMMENT"` and
`buildReviewPayload` is the only construction site of a `ReviewPayload`. `APPROVE` and
`REQUEST_CHANGES` do not compile. The Check Run conclusion is the signal that can gate a branch,
and it does not claim a human read the code.

**No Contents write, anywhere.** The App's permission set is Checks read and write, Pull requests
read and write, Contents read, Metadata read, Issues read and write. `@monad fix` edits a
detached worktree on the machine running the daemon and commits there; it never pushes. That is
enforced twice: the token has no scope to push, and `monad-hook`'s ACP client rejects every
permission request, so the fix policy's forwarded `git push` is held for whoever runs
`monad attach <id>` rather than being answered by a program.

**Review posting moved down rather than being copied.** `apps/cli/src/post.ts` held `anchorMap`,
`planReviewPost`, `formatComment`, `buildReviewPayload`, `hasMonadReviewForHead`, and
`reviewMarker`. All of it is now `packages/github/src/review-post.ts`, behind a `ReviewTransport`
interface with two implementations: `gh` in `apps/cli` (which is why the shell-out stays there,
since this package must not know a `gh` binary exists) and Octokit in `packages/github`. Two
copies of anchoring logic drift in exactly the way that produces a comment attached to the wrong
line.

## Facts the implementation must honor

1. `packages/github` does not import from `apps/`. Its only workspace dependencies are
   `@aaroncx/checks` and `@aaroncx/protocol`.
2. Everything narrowed from a delivery goes through a zod object schema, so unknown keys are
   stripped rather than carried. GitHub adds fields constantly; monad reading only the ones it
   named means a new field cannot change behavior. A payload that does not match is an ignored
   intent, answered `200`, never a coerced half-object.
3. Anything outside the trigger set is acknowledged with `200` and dropped. A receiver that
   errors on events it did not ask for gets its deliveries disabled by GitHub, which is a worse
   failure than doing nothing.
4. Trust for a webhook-triggered review is `untrusted` unless the signed payload proves
   otherwise. A `head.repo` of `null` (the fork was deleted) reads as a fork, which is the safe
   answer.
5. `@monad fix` is gated on the commenter's `author_association` from the signed payload:
   `OWNER`, `MEMBER`, or `COLLABORATOR`. A refusal is a `-1` reaction, deliberately different
   from the `confused` reaction an unrecognized command gets: "I will not" and "I do not
   understand" are different answers.
6. The command parser does not guess. An unrecognized verb, or `fix` with no instruction,
   resolves to `unknown`. A parser that tries to work out what was meant is a parser that
   eventually runs fix mode because someone wrote the word "fix" in a sentence.
7. No log line carries a token, a private key, or a webhook body. `DeliveryMeta` is the log-safe
   projection (delivery id, event, action, repository, pull request number) and there is
   deliberately no logging helper that takes a payload. The `401` path logs the delivery id and
   the reason.
8. The App private key is read from a file. A `privateKey` field in `github.json` is refused
   rather than honored, and `~/.monad/github.json` must be mode `0600` or `monad-hook` will not
   start.
9. Installation tokens are cached per installation id with their expiry, refreshed at 55 minutes,
   in an LRU on an app handle rather than a module-level global. Neither the key nor the token is
   ever interpolated into a string in `src/app.ts`.
10. Octokit is faked at the request layer in tests (a stub `request(route, params)`), not mocked
    per method, so payloads are asserted exactly as they would be sent. `OctokitLike` is the only
    shape this package needs, and a compile-time assertion pins that the real client satisfies it.
11. A repository with no `installations` binding in `github.json` is recorded and skipped with a
    reason. No Check Run, no GitHub call, no session. Installing the App is not enough on its own,
    on purpose: the installation list is edited in a browser, and the binding file is edited on
    the machine that would run the code.

## Revisit when

The App leaves Aaron's own repositories, at which point `@monad fix`'s `author_association` gate
should become a per-command permission lookup through the API (open decision 2), and the missing
per-repository rate limit stops being theoretical. Also revisit if a second renderer appears
(GitLab, Gitea): the split between "narrow a signed event" and "render a finished report" is
where that seam would go, and nothing in `packages/engine` should have to know either exists.
