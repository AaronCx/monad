# monad-hook

The webhook receiver. A second binary beside `monadd`, because it has a
different lifetime (long running, network facing) and a different failure
mode (a crash here must not take sessions down).

What it does, and deliberately all it does: verify a delivery's signature,
write it to a durable queue, answer GitHub, then drive `monadd` over the same
authenticated HTTP the CLI uses and render what comes back into a Check Run
and one COMMENT review. Every decision about what runs and what is trusted
lives in `@aaroncx/engine` and `@aaroncx/checks`; a check or a policy added
here is in the wrong package (decision record 0010).

## Running it

```
monad-hook [--port N] [--smee URL] [--max-concurrent N] [--config PATH]
```

- `--port` defaults to 7332, bound to 127.0.0.1 only. Nothing listens on a
  public interface: a tunnel terminates TLS in front of it.
- `--smee <url>` connects a smee.io channel and forwards its deliveries to
  the local port, which needs no inbound port and is the right default for a
  machine behind NAT.
- `--max-concurrent` defaults to 2. Reviews cost vendor tokens and the
  machine is doing other things.

Routes: `POST /webhook` and `GET /healthz`. Nothing else answers.

## Configuration

`~/.monad/github.json`, mode 0600 (monad-hook refuses to start otherwise: the
file holds the webhook secret, which is the only thing standing between the
internet and a review run). `github.example.json` in this directory is the
shape:

| field | meaning |
| --- | --- |
| `appId` | the GitHub App's numeric id, as a string or a number |
| `privateKeyPath` | path to the App's private key PEM. A path, never the key body: an environment variable holding a PEM ends up in the process table and in supervisor logs |
| `webhookSecret` | the App's webhook secret, verified against the raw body before anything is parsed |
| `installations` | `owner/name` to the local checkout reviews of that repository run from. The review playbook fetches `refs/pull/<n>/head` from that checkout's `origin`, so it must be a clone of the repository the delivery names. A repository with no entry here is recorded and not reviewed |

Environment overrides win, for supervisors that inject secrets:
`MONAD_GITHUB_APP_ID`, `MONAD_GITHUB_PRIVATE_KEY_PATH`, `MONAD_WEBHOOK_SECRET`.

The App's permission set, the registration steps, and the exposure choices
are in `docs/github-app.md`.

## The queue

`hook_deliveries` in the same `~/.monad/monad.db` the daemon uses. The
delivery id is the primary key, so a redelivery is a no-op, and the row is
committed before the 202 goes back, so a crash cannot lose a delivery. A
delivery that was running when the process died returns to `queued` on the
next start.

One review at a time per repository and pull request: a push to a PR whose
review is still running cancels that session, marks the delivery superseded,
and reviews the new head, so there are never two reviews for one pull request
and never two Check Runs for one head sha.
