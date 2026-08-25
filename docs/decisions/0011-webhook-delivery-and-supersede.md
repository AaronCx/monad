# 0011: Webhook delivery, supersede, and what a crash is allowed to cost

Status: accepted
Date: 2026-08-24
Context: monad M3, `apps/hook` (`monad-hook`)

## Context and question

GitHub's delivery timeout is measured in seconds; a review takes a minute or more. So the work
cannot happen inside the request, which means every hard question in M3 is a queueing question:
what happens when the same delivery arrives twice, when three commits land on one pull request in
a minute, when `monadd` is down, and when the receiver dies mid-review.

The failure modes are asymmetric and that shapes every answer below. A lost delivery is a pull
request that silently never gets reviewed. A duplicated delivery is two reviews racing for one
Check Run, two sessions on one worktree lineage, and twice the vendor tokens. Neither is
acceptable, and the machine running this is a Mac Mini that is also doing other things.

## Decision

A SQLite queue in the daemon's own database, one worker per pull request, a global concurrency
cap, and supersede-then-cancel when a newer head arrives.

**`hook_deliveries` lives in `~/.monad/monad.db`**, the same file `monadd` keeps sessions in, in
WAL mode with a 5 second busy timeout because there are two writers on that file. `monad-hook`
owns this table and nothing else in there.

**The delivery id is the primary key.** That is the whole idempotency story: GitHub retrying, or
a human pressing Redeliver, inserts nothing and starts nothing. The receiver answers the second
copy exactly as fast as the first (`202` with `duplicate: true`, which makes the no-op visible
from the GitHub delivery page rather than only in the log) and does one review.

**The row is committed before the `202`.** A crash between the answer and the work loses nothing.

**What is stored is the narrowed intent**, the zod output from `packages/github`, not the raw
delivery. The narrowing already dropped everything monad does not read, so the queue
structurally cannot hold a field nobody named.

**One review at a time per `repo#number`.** A `synchronize` storm on one pull request is several
deliveries about the same thing. When a review delivery arrives for a pull request whose review
is still running, that delivery supersedes it.

**A global cap** (`--max-concurrent`, default 2), because every review costs vendor tokens.

**A dead `monadd` loses nothing.** It is not a delivery failure: the row returns to `queued`
behind an exponential backoff and is tried again. Only after `maxAttempts` (8) does a delivery
fail for good, with the reason on the row.

## Facts the implementation must honor

1. **The delivery id is the idempotency key, and it is required.** A delivery that verifies but
   carries no `X-GitHub-Delivery` is refused with `400` rather than queued, because without it a
   redelivery would run a second review. The signature is checked against the raw body before
   anything is parsed and before the id is consulted.

2. **One worker per pull request, keyed on `repo#number`.** The pump skips a ready row whose key
   is already busy. Two reviews for one pull request never exist, and neither do two Check Runs
   for one head sha within a delivery chain.

3. **Supersede runs before the concurrency cap is consulted.** The pump makes two passes over the
   ready rows: the first supersedes every stale running review, the second starts what fits in a
   free slot. A newer head makes a running review stale whether or not there is room to start its
   replacement yet, and the earlier draft had this backwards: with the cap full, the cancel would
   have waited for a slot, which is the storm this design exists to collapse.

4. **The ordering is supersede, then cancel.** The delivery row is marked `superseded` with the
   reason naming the arriving delivery, and only then is `manager.cancel` sent for the session.
   The row is the durable record, the cancel is a best-effort network call, and doing them the
   other way round means a cancel that succeeds against a row that still says `running`. A cancel
   that fails is a warning, not a failure: the superseding review is already what counts.

5. **A session that does not exist yet is cancelled the moment it does.** A `synchronize` can land
   while the previous review is still creating its worktree, so `JobControl.onSession` fires the
   instant the `session_created` event arrives and cancels if the job was already superseded.
   Waiting out a whole review to notice would defeat the point.

6. **A running COMMAND is never superseded.** `@monad fix` is a person asking for something
   specific; a push landing while it works does not make it unwanted. Only a review supersedes a
   review.

7. **A superseded job's own outcome is discarded.** The supersede path already wrote the terminal
   state; `finishRow` returns early on `superseded` so the row records why it stopped rather than
   whatever its last write happened to be. Its Check Run is completed with conclusion `cancelled`
   and a title saying so, rather than being left hanging `in_progress`.

8. **`monadd` is checked before the Check Run is created.** `daemon.ensure()` runs first, so a
   daemon that is down leaves the delivery queued for a retry rather than leaving a second queued
   Check Run on the same head sha behind every attempt. This is the rule that keeps "one Check Run
   per head sha" true across retries, and it is why the ordering in `runReviewJob` is
   ensure, then acknowledge, then create.

9. **The backoff is exponential from 2 seconds, capped at 5 minutes, 8 attempts.** A retry keeps
   the same delivery id and the same row, so the attempt count is durable. The timer that wakes
   the pump when the soonest backoff expires is `unref`'d: a backoff never holds the process open.

10. **Crash recovery re-queues, it does not resume.** A row still marked `running` when the
    process starts is one whose review died with the process. There is nothing to resume, so it
    goes back to `queued` and is run again. The delivery id is what keeps that from becoming a
    second review of something already reported: the re-run creates one Check Run on that head,
    and the same-head marker in the review body means `postReview` posts nothing twice. The
    recovered row's attempt count includes the attempt that died, which is how the log shows a
    crash happened.

11. **Shutdown is graceful and honest.** `SIGTERM` and `SIGINT` stop the smee client, stop the
    server, await in-flight jobs, and close the queue. Anything still running stays marked
    `running` so the next start finds it. `SIGHUP` is ignored, so the terminal that started it
    going away does not.

12. **`GET /healthz` reports counts by status and the version, and carries no secret.**

## Consequences worth naming

- A `@monad fix` whose agent asks for a permission nobody will answer stays `running` forever, by
  design: the request is held for a human, and the delivery row is the thing holding a
  concurrency slot and that pull request's key while it waits. Cancelling the session (or
  attaching and answering) releases it. This is the correct behavior and it is also a way to
  wedge one of two slots, so it is worth watching on the first real fix.
- `check_run rerequested` and `@monad review` each create a fresh Check Run on the head sha,
  which is what GitHub's re-run flow expects. "One Check Run per head sha" is a property of a
  delivery chain, not of the head sha across all time: a human asking for another pass gets
  another run, and the review body is not posted twice because of the same-head marker.
- The queue is durable and unbounded. Nothing prunes `hook_deliveries`, so it grows with
  traffic. At the Mini's volume that is a non-issue and it is the record of what happened; a
  retention policy belongs with the per-repository rate limit, not before it.

## Revisit when

A per-repository daily cap becomes necessary (the first time a fork pull request storm spends
real money), or when `monad-hook` needs to run more than one instance, at which point the
"pump reads ready rows" model needs a claim that is atomic in SQL rather than a single process
holding the invariant.
