# monad

Bun + TypeScript monorepo. Read docs/architecture.md and docs/decisions/ before changing
anything structural.

Rules:
- bun, never npm or pnpm. `bun install --frozen-lockfile` in CI.
- Biome for lint and format. `bun run lint`, `bun run typecheck`, `bun test` must be green
  before any commit. Do not report work complete with a red check.
- Conventional commits. One concern per PR.
- No em dashes in docs, comments, or user-facing strings.
- The daemon speaks ACP on both sides. Do not invent wire formats; extend ACP with a control
  API next to it. Wrap the SDK's experimental transport exports behind packages/engine/src/transport.
- Local-first: SQLite under ~/.monad, loopback only, no telemetry, no cloud dependency.
- Never store or log vendor auth tokens. Vendor agents authenticate inside their own binaries.
- Out of scope until its milestone: checks, review mode, GitHub App, native loop, desktop,
  web, phone. Do not scaffold them early.
