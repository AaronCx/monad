# Checks

`packages/checks` is monad's deterministic half: the checks that either pass or fail without
asking a model anything. They run in three places, all from the same functions:

- `monad checks` in a repo, with no daemon and no session (this document).
- the `monad review <pr>` playbook, diff-scoped to the PR inside its own worktree.
- the `monad-checks` MCP server injected into every session, so the agent can call `run_checks`
  itself (decision record 0006).

## monad checks

```
monad checks [--staged | --base <ref>] [--only a,b] [--full] [--json]
```

- Default scope is `--base` of the repo's default branch (origin's HEAD symref, else `main`,
  else `master`): the diff of `HEAD` against the merge base, exactly what a PR would show.
- `--staged` scopes to the git index instead, which is what a pre-commit hook wants.
- `--only` takes a comma-separated subset of `secrets`, `file_patterns`, `agent_patterns`,
  `lint`, `typecheck`, `dependencies`, `build`, `test`.
- `--full` runs the `full` profile (adds `build` and `test` when they are enabled); the default
  `fast` profile keeps a run under a minute on most repos.
- `--json` prints the whole `CheckRunResults` object instead of the table.
- Exit code is 1 when any check fails, 0 otherwise. Warnings do not fail the run.

Configuration comes from `.monad.yml` in the current directory, else `.lastgate.yml` with a
one-line rename notice, else the built-in defaults. Unknown and removed keys warn on stderr
naming the key; they are never silently dropped.

## The pre-commit hook

`monad checks --staged` is the LastGate CLI replacement. Put this in `.git/hooks/pre-commit`
and `chmod +x` it:

```sh
#!/bin/sh
# Fail the commit when a staged change trips a check. Skip with: git commit --no-verify
exec monad checks --staged --only secrets,file_patterns
```

The full set is usually too slow for every commit; `secrets,file_patterns` is the pair worth
paying for on each one. Run the rest in CI, or on a pre-push hook:

```sh
#!/bin/sh
exec monad checks --base "$(git rev-parse --abbrev-ref origin/HEAD)"
```

`monad checks` needs no daemon, so a hook cannot be blocked by monadd being down. It does need
the repo's dependencies installed for `lint`, `typecheck`, `build`, and `test`: without them
those commands fail, and a failing command is a failing check, not a skipped one. In your own
checkout that is your normal install; inside a review worktree it is what `review.install`
handles (decision record 0008).

## What non-JS repos get

Every repo, whatever the language, gets the checks that read the diff itself:

| check | what it needs |
|---|---|
| `secrets` | nothing; scans added lines with real file line numbers |
| `file_patterns` | nothing; blocks paths like `.env` by pattern |
| `dependencies` | a manifest it recognizes in the diff |
| `agent_patterns` | the commit range only |

The tool-driven checks depend on what is in the repo:

- `lint` covers biome (`biome.json`), eslint (`.eslintrc*`, `eslint.config.*`), ruff
  (`pyproject.toml`), and swiftlint (`.swiftlint.yml`), scoped to the lintable changed files.
- `typecheck` covers a `typecheck` or `type-check` package script, else `tsconfig.json` via
  `tsc --noEmit`, else pyright or mypy when `pyproject.toml` is present and one of them is on
  PATH. It is not diff-scoped: type errors propagate out of the diff.
- `build` and `test` detect package scripts first, then `Package.swift` (`swift build`,
  `swift test`), then Python. Both are off by default and only run in the `full` profile.

So a Swift repo such as a+Terminal gets secrets, file patterns, dependency review, agent
patterns, and swiftlint; a Python repo gets those plus ruff and pyright or mypy.

## Extension points

Two functions decide what a repo's toolchain is. Both are plain detectors over the worktree,
so adding a tool is a small edit plus a test, not a new plugin system.

- **Linters: `detectLinter(cwd)` in `packages/checks/src/checks/lint.ts`.** It returns
  `{ kind, commandPrefix }` for the first config file it finds, and the check appends the
  changed lintable files to the prefix. To add a linter, add its config-file probe and command
  prefix there, and add the file extensions it owns to `LINTABLE_EXTENSIONS` in the same file.
  Detection order is the order of the probes, so put the more specific config first.
- **Type checkers: `detectTypechecker(cwd)` in
  `packages/checks/src/checks/typecheck.ts`.** It returns a command to run or a skip note, in
  the order package script, `tsconfig.json`, pyright or mypy. Output is parsed by
  `parseTscOutput`, which understands the `file(line,col): error TSxxxx:` shape; a checker that
  prints something else needs its own parser beside it.

Any repo can skip detection entirely by setting the command in `.monad.yml`:

```yaml
checks:
  lint:
    command: mise run lint
  typecheck:
    command: make typecheck
    timeout: 600
```

A configured command wins over detection, runs in the repo root (or the review worktree), and
its non-zero exit is the check's failure.
