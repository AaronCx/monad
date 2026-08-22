# 0003: Sessions persist as an append-only SQLite event log

Status: accepted, 2026-08-22

## Context

Sessions must outlive the client that started them and survive daemon restarts. Attaching from
a second terminal (later an editor or a phone) needs the full conversation so far plus a live
feed. The ACP HTTP transport does not replay messages emitted while a client was disconnected,
and vendor agents differ in whether they can restore context at all.

## Decision

Every session is an append-only event log in SQLite (`~/.monad/monad.db`, WAL mode): a
`sessions` table and an `events` table with a monotonically increasing `seq`. Raw ACP
`session/update` notification params are stored verbatim as `update` events alongside
`prompt`, `permission_requested`, `permission_resolved`, `turn_ended`, `error`, and lifecycle
events. Attach is `replay(sessionId, fromSeq)` plus a live subscription.

## Consequences

- Replay is exact and ordered; two clients attaching to the same session see identical history.
- The log is the audit trail for review sessions later (M2+); no second storage design needed.
- Storing updates verbatim couples stored payloads to ACP's update shapes; version skew is
  handled by keeping events opaque to the store and interpreting them only at the edges.
- Local-first stays true: one file under `~/.monad`, no cloud dependency, and deleting that
  file is a complete, honest reset.
