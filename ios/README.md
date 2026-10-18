# monad for iPhone

A read-only client for `monadd`'s control API: daemon status, sessions, transcripts and
search. See decision record 0013 for scope and what it does not do yet.

## Build and test

Needs Xcode 26.5 and XcodeGen (`brew install xcodegen`).

```sh
make test                     # generate the project, run unit tests (the live UI test skips)
make test-live                # drive the app against a running monadd on 127.0.0.1:7331
make test-live DAEMON_URL=http://127.0.0.1:7341 DAEMON_TOKEN_FILE=~/.monad-link/token
```

`make test-live` hands the daemon token to the test runner, and the Simulator's system log keeps
the launch environment, so run it against a throwaway daemon (its own `MONAD_HOME`) or rotate
that daemon's token afterwards.

## Connecting

- **Simulator on the daemon's Mac:** `http://127.0.0.1:7331` and the contents of
  `~/.monad/token`.
- **iPhone:** the daemon must be reachable over HTTPS, for example with `tailscale serve`
  on the Mac (decision record 0013 explains why this is not set up by default).

## TestFlight

`scripts/upload-testflight.sh` archives, uploads and waits for processing (app
`6824323496`, bundle ID `com.aaroncx.monad`). It runs only on Aaron's Mac mini, which holds
the signing identity and App Store Connect key. Bump `CURRENT_PROJECT_VERSION` in
`project.yml` before each upload.
