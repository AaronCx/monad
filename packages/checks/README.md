# @aaroncx/checks

Deterministic check engine ported from LastGate's packages/engine in Milestone 2:
secret scanning, file pattern guard, lint, typecheck, build, test, dependency review,
and agent-pattern smells, diff-scoped where that makes sense.

Public API: `runChecks(input)`, `listChecks(config)`, `loadConfig(cwd)`, plus the git
diff helpers `diffBetween`, `getBranchDiff`, `getStagedDiff`.

Config comes from `.monad.yml` (with `.lastgate.yml` fallback and a rename notice).
Unknown or removed keys warn instead of being silently dropped.
