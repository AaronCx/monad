# @aaroncx/github

The GitHub side of monad. A trigger and a renderer, never a second engine.

Ported from LastGate's `apps/web/lib/github/` in Milestone 3, minus everything
dashboard-shaped. What runs and what is trusted is decided in
`@aaroncx/engine` and `@aaroncx/checks`; a check or a policy added here is in
the wrong package. This package does not import from `apps/`.

## What is where

| module | what it does |
| --- | --- |
| `signature.ts` | `verifyWebhookSignature` over the raw body. Constant time, length guarded. |
| `app.ts` | `createGitHubApp` -> `getAppOctokit`, `getInstallationOctokit`, with an LRU of installation tokens renewed at 55 minutes. |
| `events.ts` | zod narrowing of a delivery to a `WebhookIntent`. Everything outside the trigger set is an ignored intent. |
| `trust.ts` | trusted or untrusted, from the signed payload alone. No API call, no `gh`, no fallback. |
| `check-runs.ts` | create, update, and complete a Check Run, paging annotations 50 at a time. |
| `render.ts` | verdict and checks into `output.title`, `output.summary`, `output.text`, and a conclusion. |
| `review-post.ts` | one COMMENT review with inline comments, shared with the CLI through a transport interface. |
| `octokit.ts` | `OctokitLike`, the one shape everything here needs, so tests fake the request layer. |

Not ported from LastGate: `branch-protection.ts` (the repo owner's job),
`commit-comments.ts` and `notifications.ts` (product surface monad is not
rebuilding).

## The rules this package keeps

- A webhook-triggered review is untrusted unless the signed payload proves
  otherwise. A fork PR is untrusted whatever the author's association says.
- `COMMENT` reviews only. `ReviewPayload.event` is the literal `"COMMENT"`,
  so `APPROVE` and `REQUEST_CHANGES` do not compile.
- Nothing logs a token, a private key, or a webhook body. `DeliveryMeta` and
  `describeDelivery` are the log-safe projection: delivery id, event, action,
  repo, PR number.
- Octokit is faked at the request layer in tests, so payloads are asserted as
  they would be sent.
