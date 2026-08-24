# 0008: Dependency install strategy for review worktrees

Status: accepted
Date: 2026-08-23
Context: monad M2, Phase 0 spike 0c

## Question

A review worktree (detached checkout of the PR head) needs a working
node_modules before checks can run. Do we pay for a fresh install per
worktree, or symlink the main checkout's node_modules when the
worktree's bun.lock is byte-identical to the repo root's?

## Decision

Always run `bun install --frozen-lockfile` in the review worktree.
The symlink fast path is rejected and the auto strategy must never
select it, even when lockfiles are byte-identical.

## Evidence (spike, 2026-08-23, commit f5e7486, bun 1.3.x, M4 Mac Mini)

- Warm-cache `bun install --frozen-lockfile` in a fresh detached
  worktree: 66 to 104 ms wall clock across three runs (224 packages,
  APFS clonefile from bun's global cache). node_modules: 434 MB.
- Root-only symlink (`ln -s <main>/node_modules node_modules`): 18 ms,
  but `bun test` collapses to 17 pass / 9 fail / 9 errors with only
  26 of 81 tests even collected ("Cannot find module
  '@agentclientprotocol/sdk'", "Cannot find module '@aaroncx/engine'").
  Baseline with a real install: 80 pass / 1 skip / 0 fail.

## Why the symlink is structurally broken here

1. bun 1.3 uses the isolated linker: runtime deps live in
   `node_modules/.bun/<pkg>@<version>/` and are exposed to each
   workspace through per-workspace `node_modules` directories
   containing relative symlinks (for example
   `packages/engine/node_modules/zod ->
   ../../../node_modules/.bun/zod@4.4.3/node_modules/zod`).
   The root `node_modules` top level holds only the root devDeps.
   A fresh worktree has no per-workspace directories, so a root-only
   symlink leaves every workspace import unresolvable. Lockfile
   identity is irrelevant to this failure.
2. Partial success is deceptive: `bunx tsc --version` and
   `bun run lint` (root devDeps, hoisted to root top level) both work
   through the symlink, and `bun test` still "runs" a subset. Any
   shallow verification would wrongly bless the symlink.
3. Cross-workspace deps are relative symlinks
   (`@aaroncx/protocol -> ../../../protocol`). Any variant that
   resolves through the main checkout's real paths (including
   symlinking per-workspace node_modules) would make dependents
   resolve sibling packages from the MAIN checkout's sources, not the
   worktree under review. A review harness must never test code other
   than the code in the worktree.
4. The donor can be stale: at spike time the main checkout's
   node_modules held 9 store entries versus 113 for a correct install.
   A symlink silently inherits whatever state the main checkout is in.

## Consequences

- Per-worktree cost is 434 MB of clonefile-backed node_modules
  (near-zero incremental disk on APFS) and roughly 0.1 s wall clock
  with a warm cache. This is below measurement noise for a review run;
  no fast path is worth the correctness risk.
- Cold-cache installs (first run after a cache wipe or new dependency
  set) will be slower; this is accepted and not special-cased.
- If the PR's bun.lock differs from what `--frozen-lockfile` allows,
  the install fails loudly; the review harness surfaces that as a
  finding rather than falling back to a mutated install.
- Revisit only if bun's linker layout changes or install times regress
  by orders of magnitude; any future fast path must pass the full
  `bun test` suite count check (expected tests collected, not just
  exit code) before being trusted.
