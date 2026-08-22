# 0002: Bun + TypeScript monorepo

Status: accepted, 2026-08-22

## Context

The ACP SDK and every vendor adapter are TypeScript. The predecessor projects were TypeScript
(LastGate, on Bun) and Python (Forge). The daemon needs a subprocess-heavy runtime, built-in
SQLite, fast startup, and a path to single-file binaries for distribution without a package
manager.

## Decision

Bun and TypeScript everywhere: `bun install` workspaces, `bun:sqlite` for the event log,
`bun test` for tests, `bun build --compile` for the `monad` and `monadd` binaries. Turbo runs
the task pipeline; Biome lints and formats. npm and pnpm are not used.

## Consequences

- One toolchain from dev to shipped binary; no Node version management and no bundler config.
- `bun:sqlite` removes a native-module dependency that has broken CI elsewhere in this
  portfolio (Python 3.14 wheel breakage in sibling repos was the cautionary tale).
- The ACP SDK's node HTTP adapter must be proven under Bun's `node:http` shim before M1 code
  lands on it; decision 0004 records the spike result and the `Bun.serve` fallback if needed.
- Workspace packages use the `@aaroncx/*` scope because the unscoped `monad` npm name has been
  taken since 2015. Nothing is published to npm in M1.
