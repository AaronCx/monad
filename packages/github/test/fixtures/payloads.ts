/**
 * Webhook payload fixtures, trimmed to the fields monad reads plus a few it
 * deliberately ignores, so the narrowing is exercised against something
 * shaped like a real delivery rather than against the schema's own output.
 */

export const REPO = {
  full_name: "AaronCx/monad-review-demo",
  name: "monad-review-demo",
  owner: { login: "AaronCx" },
  private: false,
  default_branch: "main",
};

export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

export function pullRequest(
  overrides: Record<string, unknown> = {},
  headRepo: string | null = REPO.full_name,
): Record<string, unknown> {
  return {
    number: 7,
    title: "Add a thing",
    body: "It adds the thing.",
    html_url: "https://github.com/AaronCx/monad-review-demo/pull/7",
    draft: false,
    state: "open",
    author_association: "MEMBER",
    user: { login: "AaronCx", type: "User" },
    head: {
      sha: HEAD_SHA,
      ref: "feature",
      repo: headRepo === null ? null : { full_name: headRepo },
    },
    base: {
      sha: "fedcba9876543210fedcba9876543210fedcba98",
      ref: "main",
      repo: { full_name: REPO.full_name },
    },
    ...overrides,
  };
}

export function pullRequestEvent(
  action: string,
  prOverrides: Record<string, unknown> = {},
  headRepo: string | null = REPO.full_name,
): Record<string, unknown> {
  return {
    action,
    number: 7,
    pull_request: pullRequest(prOverrides, headRepo),
    repository: REPO,
    sender: { login: "AaronCx" },
    installation: { id: 4242, node_id: "MDIz" },
  };
}

export function issueCommentEvent(
  body: string,
  overrides: { action?: string; isPr?: boolean; association?: string } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? "created",
    issue: {
      number: 7,
      title: "Add a thing",
      ...(overrides.isPr === false
        ? {}
        : {
            pull_request: {
              url: "https://api.github.com/repos/AaronCx/monad-review-demo/pulls/7",
              html_url: "https://github.com/AaronCx/monad-review-demo/pull/7",
            },
          }),
    },
    comment: {
      id: 991,
      body,
      author_association: overrides.association ?? "MEMBER",
      user: { login: "AaronCx" },
    },
    repository: REPO,
    installation: { id: 4242 },
  };
}

export function checkRunEvent(
  action: string,
  pullRequests: Array<{ number: number }> = [{ number: 7 }],
): Record<string, unknown> {
  return {
    action,
    check_run: {
      id: 55,
      name: "monad",
      head_sha: HEAD_SHA,
      status: "completed",
      pull_requests: pullRequests,
    },
    repository: REPO,
    installation: { id: 4242 },
  };
}
