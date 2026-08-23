# monad

One daemon for agentic coding and PR review.

monad runs coding-agent sessions that outlive the client that started them. Open a session
from the CLI, an editor, or (later) a phone; attach to it from anywhere else. Review sessions
open from GitHub pull requests, run diff-scoped checks, and are the same sessions you talk to
when something fails.

**Status: pre-alpha. Milestone 1 landed: `monadd` + `monad` (run, attach, ls, acp-stdio),
Claude via `claude-agent-acp`, sessions persisted in SQLite.** Interfaces and storage are
still unstable, there are no packaged releases yet (build from source with `bun run build`),
and everything past M1 on the roadmap does not exist. See `docs/architecture.md`.

## How it works

- The daemon (`monadd`) speaks the [Agent Client Protocol](https://agentclientprotocol.com) on
  both sides. Toward vendor agents it is an ACP client, spawning `claude-agent-acp`, `codex-acp`,
  or Gemini CLI per session. Toward its own clients it is an ACP agent over HTTP.
- Sessions are an append-only event log in SQLite. Attaching is a replay plus a live subscription.
- Vendor auth stays inside the vendor binaries. monad never stores or forwards an API token for
  subscription-backed agents. API keys and self-hosted models go through a native loop (M2).
- Local-first: one SQLite file under `~/.monad`, loopback only, zero telemetry, MIT.

## Roadmap

1. M1 (landed): daemon, CLI (`run`, `attach`, `ls`), Claude via `claude-agent-acp`, stdio bridge for Zed
2. M2: checks as tools (typecheck, lint, test, secrets, build), `review <pr>` run locally
3. M3: GitHub App trigger, Check Runs and review comments
4. M4: Codex and Gemini backends, native loop for API-key and self-hosted models
5. Later: desktop (Tauri sidecar), web, phone attach

## Lineage

monad replaces [Forge](https://github.com/AaronCx/Forge) (its provider-neutral agent loop and
test suite are the engine spec) and [LastGate](https://github.com/AaronCx/LastGate) (its check
engine and GitHub App plumbing are being ported). Both repos are archived.

## License

MIT
