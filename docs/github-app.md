# The monad GitHub App

M3 turns `monad review` into something that fires by itself. A GitHub App receives pull request
webhooks, `monad-hook` verifies and queues them, `monadd` runs the same review session the CLI
runs, and the result comes back as a Check Run with annotations plus one `COMMENT` review with
inline comments.

The App is a trigger and a renderer. It reads the payload GitHub signed, resolves trust from it,
and turns a finished `ReviewReport` into GitHub's API shapes. It runs no checks, holds no policy,
and decides nothing about what a session may execute. That all stays in `packages/engine` and
`packages/checks` (decision records 0009 and 0010).

## The permission set

Repository permissions:

| permission | access | why |
| --- | --- | --- |
| Checks | read and write | the Check Run named `monad` is the whole result surface, and a `rerequested` event is how a human asks for another pass |
| Pull requests | read and write | read the PR (head sha, base ref, author association, fork or not) and post one `COMMENT` review with inline comments |
| Contents | **read** | the review needs to see the code; the local checkout fetches `refs/pull/<n>/head` |
| Metadata | read | mandatory for every App |
| Issues | read and write | comment reactions (`eyes`, `rocket`, `confused`, `-1`) and the one reply `@monad status` and `@monad fix` post |

Subscribe to exactly three events:

- **Pull request** (`opened`, `reopened`, `synchronize`, `ready_for_review` open a review; every
  other action is acknowledged and dropped)
- **Issue comment** (`created`, on a pull request, body starting with `@monad`)
- **Check run** (`rerequested`)

`installation` and `installation_repositories` arrive whether or not they are subscribed; monad
records them and opens no review on them.

### Not requested, deliberately

**Contents write. Workflows. Administration. Secrets.**

Write access to code is the permission this product does not need and must not hold. Everything
monad produces is commentary: a Check Run, a review, a reaction. The one place it writes code at
all is `@monad fix`, and that writes into a detached worktree on the machine running the daemon,
never to a branch on GitHub. An unattended agent holding a push credential to your repository is
a different product with a different threat model, and M3 is not it. The absence of the
permission is what makes that a fact rather than a promise: even a compromised `monad-hook`
cannot push, because the installation token it holds was never minted with the scope.

`monad-hook` also holds up its end from the other side. Fix mode runs with nobody attached, and
the M2 policy forwards a command it cannot decide (`git push` above all) to the attached human.
`monad-hook` answers no permission request at all: its ACP client rejects, the daemon treats
that like a client that vanished, and the request is held for whoever runs `monad attach <id>`.

## Registering the App

Seven steps, at <https://github.com/settings/apps/new>. Everything here is on the App's own
settings page; nothing needs a deploy.

1. **Name and homepage.** `monad-review` (or any name free across GitHub), homepage
   `https://github.com/AaronCx/monad`. The name becomes the bot's identity on every review, so
   pick the one you want to see on pull requests.
2. **Webhook URL.** The smee channel from <https://smee.io/new>, or your tunnel's public URL
   ending in `/webhook`. Leave **Active** checked.
3. **Webhook secret.** Generate one and keep it (`openssl rand -hex 32`). This is the only thing
   standing between the internet and a review run, so it goes straight into
   `~/.monad/github.json` and nowhere else.
4. **Repository permissions.** Set exactly the five in the table above: Checks read and write,
   Pull requests read and write, Contents **read**, Metadata read, Issues read and write. Leave
   every other permission at **No access**, Contents write above all.
5. **Subscribe to events.** Pull request, Issue comment, Check run. Nothing else.
6. **Where can this App be installed.** "Only on this account" unless you mean to share it.
   Create the App.
7. **Private key and installation.** On the App's settings page, **Generate a private key**; the
   browser downloads a `.pem`. Move it to `~/.monad/monad-app.private-key.pem` and
   `chmod 600` it. Note the numeric **App ID** at the top of the page. Then **Install App** and
   pick the repositories to install it on.

There is a faster path: GitHub's App manifest flow (`POST https://github.com/settings/apps/new`
with a `manifest` form field) pre-fills all of the above and hands back the app id, the PEM, and
the webhook secret in one exchange, so the human step collapses to a single confirm click. That
is a convenience, not a different App: it produces the same permission set, and the permission
set above is what to check on the settings page afterwards either way.

## Configuration

`~/.monad/github.json`, mode `0600`. `monad-hook` refuses to start if any other user on the
machine can read it, because it holds the webhook secret.

```json
{
  "appId": "123456",
  "privateKeyPath": "~/.monad/monad-app.private-key.pem",
  "webhookSecret": "SET ME",
  "installations": {
    "AaronCx/monad-review-demo": { "repoRoot": "~/code/monad-review-demo" }
  }
}
```

| field | meaning |
| --- | --- |
| `appId` | the App's numeric id, as a string or a number |
| `privateKeyPath` | path to the PEM. A path, always. A `privateKey` field holding the key body is refused rather than quietly honored: an environment variable or a JSON field carrying a PEM ends up in the process table of everything that inherits it, in supervisor logs, and in crash reports. A path does not |
| `webhookSecret` | the secret from step 3, verified against the raw request body before anything is parsed |
| `installations` | `owner/name` to the local checkout that repository's review worktrees are created from |

`installations` is the binding that says monad may review a repository at all. The review
playbook fetches `refs/pull/<n>/head` from that checkout's `origin`, so `repoRoot` must be a
clone of the repository the delivery names. A repository with no entry is recorded and skipped
with a reason: no Check Run, no GitHub call, no session. Installing the App on a repository is
therefore not enough on its own, and that is deliberate: the App's installation list is edited
in a browser, and this file is edited on the machine that would run the code.

Environment overrides win over the file, for supervisors that inject secrets:
`MONAD_GITHUB_APP_ID`, `MONAD_GITHUB_PRIVATE_KEY_PATH`, `MONAD_WEBHOOK_SECRET`. The file becomes
optional when all three are set, but `installations` still comes from it.

Nothing in this path is ever logged. Every log line about a delivery is built from the delivery
id, the event, the action, the repository, and the pull request number, and there is no logging
helper that takes a payload. A delivery whose signature does not verify logs the delivery id and
the words "signature did not verify", and nothing else.

## Running it

```
monad-hook [--port N] [--smee URL] [--max-concurrent N] [--config PATH]
```

- `--port` defaults to 7332, bound to `127.0.0.1` only.
- `--max-concurrent` defaults to 2. Reviews cost vendor tokens and the machine is doing other
  things.
- Routes: `POST /webhook` and `GET /healthz`. Nothing else answers.

### smee, the default

```
monad-hook --smee https://smee.io/<channel>
```

`smee-client` opens an outbound connection to the channel and replays every delivery to
`http://127.0.0.1:<port>/webhook`. It needs no inbound port and no DNS, which is the right
default for a machine behind NAT and for M3, whose job is proving the pipeline rather than
running a service. The channel URL is a capability: anyone who has it can post to it, which is
exactly why the signature check does not care where a delivery came from.

### A tunnel, the alternative

Either works, and both replace `--smee` rather than joining it:

```
tailscale funnel 7332
cloudflared tunnel --url http://127.0.0.1:7332
```

Then set the App's webhook URL to the public hostname plus `/webhook`.

**Whatever you use terminates TLS somewhere that is not monad.** smee terminates it at smee.io,
Tailscale at the funnel ingress, Cloudflare at its edge. `monad-hook` sees plain HTTP on
loopback from something it cannot authenticate. The HMAC signature over the raw body is the only
thing between the internet and a review run: it is what makes a forged delivery a 401 instead of
a session on your machine. Rotating the webhook secret is the whole revocation story, and it
means editing the App's settings page and `~/.monad/github.json` together.

## What a review looks like from the pull request

1. The delivery is verified, written to `hook_deliveries` in `~/.monad/monad.db`, and answered
   `202`. The delivery id is the idempotency key, so a redelivery starts nothing.
2. A Check Run named `monad` appears on the head sha with status `queued`, within seconds.
3. It moves to `in_progress` with a one-line summary naming the trust level and what it costs
   ("untrusted PR: install, build, and test do not run").
4. The review session opens on `monadd` with the trust level passed explicitly. The daemon never
   re-derives it.
5. The Check Run completes: `failure` when a check failed or the verdict is `needs_changes`,
   `neutral` for `comment` with no failures, `success` for `looks_good` with none,
   `action_required` when the report could not be parsed. Annotations page 50 at a time.
6. One `COMMENT` review is posted with inline comments. Never `APPROVE`, never
   `REQUEST_CHANGES`: the Check Run conclusion is the signal that can gate a branch, and it does
   not claim a human read the code.
7. The session is left open and idle, and its id is in the review footer, so
   `monad attach <id>` picks the conversation up from a+Terminal.

Pushing to a pull request whose review is still running cancels that session, closes its Check
Run as `cancelled`, and reviews the new head. Two reviews for one pull request never exist.

## Comment commands

Comments whose body starts with `@monad`:

- `@monad review` re-runs the review at the current head.
- `@monad fix <instruction>` attaches to that pull request's existing session, switches it to
  fix mode, and prompts with the instruction. It requires the commenter's `author_association`
  to be `OWNER`, `MEMBER`, or `COLLABORATOR`. Anyone else gets a `-1` reaction and nothing else.
  This is the check that matters most in M3, because fix mode edits files.
- `@monad status` replies with the session id, mode, and last event.
- Anything else gets a `confused` reaction and no reply. There is no command parser that guesses.

Accepted commands are acknowledged with `eyes` before the work and `rocket` after. That is the
whole progress UI and it costs two API calls.

`@monad fix` never pushes. monad commits inside the worktree and the reply says how to get the
branch: `monad attach <id>` and approve the push, or pull the branch out of the worktree by
hand.

## Troubleshooting

**A pull request gets no Check Run and the log says "has no local checkout in github.json".**
The repository has no `installations` entry, so monad recorded the delivery and skipped it. Add
`"owner/name": { "repoRoot": "/path/to/clone" }` and restart `monad-hook`. `GET /healthz` counts
deliveries by status, and a `skipped` row with that reason is what this looks like from the
database.

**Deliveries are 401.** The webhook secret in `~/.monad/github.json` does not match the App's.
Reset it on the App settings page and in the file together. A proxy that rewrites or re-encodes
the body also breaks this, correctly: the signature covers the exact bytes GitHub sent.

**`monad-hook` refuses to start naming a file mode.** `chmod 600 ~/.monad/github.json`.

**Deliveries queue and never run.** `monadd` is not reachable, so the rows sit behind an
exponential backoff (2 s doubling to a 5 minute cap, 8 attempts). Nothing is lost; start the
daemon and they drain.

## Honest limitations

- **The Mini is the deployment.** A tunnel plus a laptop-class machine reviewing public pull
  requests is fine for your own repositories and is not a hosted product. Nothing here is
  multi-tenant, there is no supervision beyond whatever starts the binary, and a reboot loses
  nothing but delays everything until it comes back.
- **Every fork pull request spends your vendor tokens.** There is no rate limit in M3 beyond the
  concurrency cap of 2, and `@monad review` from a stranger is a valid trigger. Watch it, and add
  a per-repository daily cap the first time it matters.
- **Untrusted reviews are weaker on purpose**, and today on this machine they are weaker than the
  design intends: an untrusted run resolves lint and typecheck binaries from `PATH` only, never
  from the worktree, and none of `biome`, `tsc`, `ruff`, `swiftlint`, or `pyright` is on the Mac
  Mini's `PATH` (they are all repository-local devDependencies). So an untrusted review on this
  host skips lint and typecheck entirely and says so, on top of never installing, building, or
  testing. A monad-owned toolchain directory on the daemon's `PATH` is what turns them back on.
- **Annotations are capped.** GitHub accepts 50 per request; monad pages them and stops at 200,
  saying so in the summary. A very noisy diff is truncated.
- **Prompt injection through the diff is unchanged from M2.** The App does not make it worse
  technically, and it widens who can attempt it from "pull requests you chose to review" to
  "anyone who can open a pull request". The containment is the policy layer and the untrusted
  default, which is exactly why the hardening in decision record 0009 had to land first.
- **`author_association` is the gate on `@monad fix`.** It is what GitHub signed and it costs no
  API call, but it is coarser than asking for the commenter's actual permission level. If the
  App ever leaves your own repositories, upgrade it to a per-command permission lookup.

## Retiring the LastGate App

Only after M3 runs green on real pull requests for a week:

1. Install the monad App on `AaronCx/Portfolio` first, since that is where `.lastgate.yml` lives,
   and rename it to `.monad.yml` in the same pull request (the loader has read it with a notice
   since M2).
2. Run both apps side by side on the next few pull requests and compare. Where they disagree,
   monad is usually right: the M2 config loader fixed LastGate's silent unknown-key stripping.
3. Uninstall the LastGate App per repository, then shut down its deployment, then
   `npm deprecate lastgate` pointing at monad.
4. Update the archived `AaronCx/LastGate` README callout to say the successor is live.
