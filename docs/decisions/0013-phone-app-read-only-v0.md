# 0013: The phone app starts read-only, in this repo

Date: 2026-10-18
Status: accepted

## Context

Aaron asked for a monad iPhone app on TestFlight. The roadmap had phone attach late, as "an iOS
ACP client over the control API, pairing, permission approvals", and nothing for it existed.
The control API (`/v1/...`, bearer token) is the only surface a phone could use, and `monadd`
listens on 127.0.0.1 only.

## Decision

- **Where:** `ios/` in this repository, an XcodeGen project (`ios/project.yml`; the generated
  `.xcodeproj` is not committed). It talks to the daemon over the control API, so it lives
  next to the protocol it depends on. Biome ignores `ios/`; `.github/workflows/ios.yml` builds
  and tests it on `macos-26` when `ios/` changes.
- **What v0 does:** read-only. It shows daemon status, the session list (with repos and the
  last handoff), a session's normalized transcript paged by seq, and search, where a hit
  opens its session at the hit's row. It cannot prompt, answer permissions, or change
  anything. Transcripts and search need monad Link (decision record 0012); against a daemon
  without it the list still works and the rest reports "not found".
- **Names:** bundle ID `com.aaroncx.monad`, App Store Connect app `6824323496`. "monad" is
  already taken on the App Store, so the store name is "monad agents"; the name under the
  icon is "monad".
- **The token** is stored in the iOS Keychain (`WhenUnlockedThisDeviceOnly`), never in
  UserDefaults. A Debug-only launch environment (`MONAD_DAEMON_URL`, `MONAD_DAEMON_TOKEN`)
  connects without typing, for driving the app in the Simulator; Release does not compile it.
- **Transport:** plain http only to loopback (the daemon on the same Mac, from the Simulator);
  anything else must be https, since the bearer token is in every request. Requests use an
  ephemeral URLSession: nothing is cached on disk (the default session's cache stored each
  request with its Authorization header). ATS (`NSAllowsLocalNetworking`) is broader than
  this; the app's own check is the narrower one.

## Not decided here: how a phone reaches the daemon

Loopback-only is a security property (decision records 0004 and 0009 lean on it), so widening
the bind is not done for the app. The intended route is HTTPS on the tailnet with
`tailscale serve`, which proxies to 127.0.0.1 and leaves the bind alone; with it the bearer
token becomes the only thing between a tailnet device and the full control API, including
`POST` routes. Whether that is acceptable, or whether the phone needs its own scoped,
read-only token first, is the first question of the phone attach brief.
