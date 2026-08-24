import { describe, expect, test } from "bun:test";
import {
  COMMAND_PREFIX,
  describeDelivery,
  parseMonadCommand,
  parsePullRequest,
  resolveWebhookIntent,
  reviewPrInputFromPayload,
  REVIEW_PR_ACTIONS,
} from "../src/events.ts";
import type { CommandIntent, RecordIntent, ReviewIntent } from "../src/events.ts";
import {
  checkRunEvent,
  HEAD_SHA,
  issueCommentEvent,
  pullRequest,
  pullRequestEvent,
  REPO,
} from "./fixtures/payloads.ts";

function intent(event: string, payload: unknown, id = "d-1") {
  return resolveWebhookIntent({ event, deliveryId: id, payload });
}

describe("pull_request narrowing", () => {
  for (const action of REVIEW_PR_ACTIONS) {
    test(`${action} resolves to a review intent`, () => {
      const result = intent("pull_request", pullRequestEvent(action)) as ReviewIntent;
      expect(result.kind).toBe("review");
      expect(result.trigger).toBe("pull_request");
      expect(result.number).toBe(7);
      expect(result.headSha).toBe(HEAD_SHA);
      expect(result.installationId).toBe(4242);
      expect(result.repo).toEqual({
        owner: "AaronCx",
        name: "monad-review-demo",
        fullName: REPO.full_name,
      });
      expect(result.reason).toBe(`pull_request ${action}`);
      expect(result.pullRequest?.head.sha).toBe(HEAD_SHA);
    });
  }

  test("labeled is accepted and dropped", () => {
    const result = intent("pull_request", pullRequestEvent("labeled"));
    expect(result.kind).toBe("ignored");
    expect(result).toMatchObject({ reason: "pull_request labeled does not open a review" });
  });

  test("closed is accepted and dropped", () => {
    const result = intent("pull_request", pullRequestEvent("closed"));
    expect(result.kind).toBe("ignored");
    expect(result).toMatchObject({ reason: "pull_request closed does not open a review" });
  });

  test("a draft PR is skipped on opened", () => {
    const result = intent("pull_request", pullRequestEvent("opened", { draft: true }));
    expect(result.kind).toBe("ignored");
    expect(result).toMatchObject({ reason: expect.stringContaining("draft") });
  });

  test("a draft PR is skipped on synchronize", () => {
    expect(intent("pull_request", pullRequestEvent("synchronize", { draft: true })).kind).toBe(
      "ignored",
    );
  });

  test("ready_for_review reviews it even though the payload still says draft", () => {
    const result = intent("pull_request", pullRequestEvent("ready_for_review", { draft: true }));
    expect(result.kind).toBe("review");
  });

  test("unknown keys are stripped rather than carried", () => {
    const payload = pullRequestEvent("opened");
    (payload.pull_request as Record<string, unknown>).mergeable_state = "clean";
    const result = intent("pull_request", payload) as ReviewIntent;
    expect(result.pullRequest).not.toHaveProperty("mergeable_state");
    expect(Object.keys(result.pullRequest ?? {}).sort()).toEqual([
      "author_association",
      "base",
      "body",
      "draft",
      "head",
      "html_url",
      "number",
      "title",
      "user",
    ]);
  });

  test("a payload missing the head sha is refused as malformed", () => {
    const payload = pullRequestEvent("opened");
    (payload.pull_request as Record<string, unknown>).head = { ref: "feature", repo: null };
    const result = intent("pull_request", payload);
    expect(result).toMatchObject({ kind: "ignored", malformed: true });
  });

  test("a payload with no installation is refused as malformed", () => {
    const payload = pullRequestEvent("opened");
    payload.installation = undefined;
    expect(intent("pull_request", payload)).toMatchObject({ kind: "ignored", malformed: true });
  });
});

describe("issue_comment narrowing", () => {
  test("@monad review resolves to a review intent", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad review")) as ReviewIntent;
    expect(result.kind).toBe("review");
    expect(result.trigger).toBe("issue_comment");
    expect(result.number).toBe(7);
    expect(result.comment?.id).toBe(991);
    // The comment payload carries no PR object, so trust cannot be proven here.
    expect(result.pullRequest).toBeUndefined();
    expect(result.headSha).toBeUndefined();
  });

  test("@monad fix resolves to a command intent carrying the instruction", () => {
    const result = intent(
      "issue_comment",
      issueCommentEvent("@monad fix drop the unused import"),
    ) as CommandIntent;
    expect(result.kind).toBe("command");
    expect(result.command).toEqual({ name: "fix", instruction: "drop the unused import" });
    expect(result.comment.author_association).toBe("MEMBER");
  });

  test("@monad status resolves to a command intent", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad status")) as CommandIntent;
    expect(result.command).toEqual({ name: "status" });
  });

  test("@monad nonsense resolves to an unknown command, never to a review", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad nonsense")) as CommandIntent;
    expect(result.kind).toBe("command");
    expect(result.command).toEqual({ name: "unknown", verb: "nonsense" });
  });

  test("a comment that does not address monad is dropped", () => {
    const result = intent("issue_comment", issueCommentEvent("looks good to me"));
    expect(result.kind).toBe("ignored");
    expect(result).toMatchObject({ reason: `the comment does not start with ${COMMAND_PREFIX}` });
  });

  test("a comment on an issue that is not a PR is dropped", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad review", { isPr: false }));
    expect(result.kind).toBe("ignored");
    expect(result).toMatchObject({ reason: "the comment is on an issue, not a pull request" });
  });

  test("an edited comment is dropped", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad review", { action: "edited" }));
    expect(result.kind).toBe("ignored");
  });
});

describe("parseMonadCommand", () => {
  test("leading whitespace and case do not matter", () => {
    expect(parseMonadCommand("  @Monad Review")).toEqual({ name: "review" });
  });

  test("a word starting with @monad is not a command", () => {
    expect(parseMonadCommand("@monadic thoughts on this")).toBeUndefined();
  });

  test("a mention in the middle of a sentence is not a command", () => {
    expect(parseMonadCommand("cc @monad review")).toBeUndefined();
  });

  test("fix with no instruction is unknown, not a fix", () => {
    expect(parseMonadCommand("@monad fix")).toEqual({ name: "unknown", verb: "fix" });
  });

  test("a bare mention is unknown", () => {
    expect(parseMonadCommand("@monad")).toEqual({ name: "unknown", verb: "" });
  });

  test("review with trailing words is unknown rather than guessed at", () => {
    expect(parseMonadCommand("@monad review the second half only")).toEqual({
      name: "unknown",
      verb: "review",
    });
  });

  test("a multi-line fix instruction keeps its whole body", () => {
    expect(parseMonadCommand("@monad fix rename x to y\nand update the test")).toEqual({
      name: "fix",
      instruction: "rename x to y\nand update the test",
    });
  });
});

describe("check_run narrowing", () => {
  test("rerequested resolves to a review intent at the run's head", () => {
    const result = intent("check_run", checkRunEvent("rerequested")) as ReviewIntent;
    expect(result.kind).toBe("review");
    expect(result.trigger).toBe("check_run");
    expect(result.number).toBe(7);
    expect(result.headSha).toBe(HEAD_SHA);
    expect(result.pullRequest).toBeUndefined();
  });

  test("created and completed are dropped", () => {
    expect(intent("check_run", checkRunEvent("created")).kind).toBe("ignored");
    expect(intent("check_run", checkRunEvent("completed")).kind).toBe("ignored");
  });

  test("a rerequest naming no pull request is dropped", () => {
    const result = intent("check_run", checkRunEvent("rerequested", []));
    expect(result).toMatchObject({
      kind: "ignored",
      reason: "the rerequested check run names no pull request",
    });
  });
});

describe("installation events are recorded, never reviewed", () => {
  test("installation created records the id", () => {
    const result = intent("installation", {
      action: "created",
      installation: { id: 4242 },
      repositories: [{ full_name: "AaronCx/monad" }],
    }) as RecordIntent;
    expect(result.kind).toBe("record");
    expect(result.installationId).toBe(4242);
    expect(result.repositories).toEqual(["AaronCx/monad"]);
  });

  test("installation_repositories records both sides of the change", () => {
    const result = intent("installation_repositories", {
      action: "added",
      installation: { id: 4242 },
      repositories_added: [{ full_name: "AaronCx/a" }],
      repositories_removed: [{ full_name: "AaronCx/b" }],
    }) as RecordIntent;
    expect(result.repositories).toEqual(["AaronCx/a", "AaronCx/b"]);
  });
});

describe("everything else", () => {
  test("an unsubscribed event is dropped by name", () => {
    const result = intent("push", { ref: "refs/heads/main" });
    expect(result).toMatchObject({
      kind: "ignored",
      reason: "monad does not subscribe to push",
    });
  });

  test("a ping is dropped", () => {
    expect(intent("ping", { zen: "Anything added dilutes everything else." }).kind).toBe("ignored");
  });
});

describe("describeDelivery", () => {
  test("names the delivery, the event, the action, the repo, and the PR", () => {
    const result = intent("pull_request", pullRequestEvent("opened"), "abc-123");
    expect(describeDelivery(result.delivery)).toBe(
      "delivery=abc-123 event=pull_request action=opened repo=AaronCx/monad-review-demo pr=7",
    );
  });

  test("carries nothing from the body", () => {
    const result = intent("issue_comment", issueCommentEvent("@monad fix leak this please"));
    expect(describeDelivery(result.delivery)).not.toContain("leak this");
  });
});

describe("reviewPrInputFromPayload", () => {
  const repo = { owner: "AaronCx", name: "monad-review-demo", fullName: REPO.full_name };

  test("a same-repo branch is not cross-repository", () => {
    const parsed = (
      intent("pull_request", pullRequestEvent("opened")) as ReviewIntent
    ).pullRequest;
    const input = reviewPrInputFromPayload(repo, parsed!);
    expect(input).toMatchObject({
      repo: REPO.full_name,
      number: 7,
      headSha: HEAD_SHA,
      baseRef: "main",
      isCrossRepository: false,
      authorLogin: "AaronCx",
      isDraft: false,
    });
  });

  test("a fork head is cross-repository", () => {
    const parsed = (
      intent("pull_request", pullRequestEvent("opened", {}, "stranger/monad-review-demo")) as ReviewIntent
    ).pullRequest;
    expect(reviewPrInputFromPayload(repo, parsed!).isCrossRepository).toBe(true);
  });

  test("a deleted fork head (repo: null) is cross-repository", () => {
    const parsed = (
      intent("pull_request", pullRequestEvent("opened", {}, null)) as ReviewIntent
    ).pullRequest;
    expect(reviewPrInputFromPayload(repo, parsed!).isCrossRepository).toBe(true);
  });

  test("the fixture's own shape survives a round trip", () => {
    const raw = pullRequest();
    expect(raw.number).toBe(7);
  });
});

describe("parsePullRequest", () => {
  test("narrows a pull request fetched through the API", () => {
    const parsed = parsePullRequest(pullRequest());
    expect(parsed?.number).toBe(7);
    expect(parsed?.head.sha).toBe(HEAD_SHA);
    expect(parsed?.author_association).toBe("MEMBER");
  });

  test("an answer that is not a pull request is undefined, never half read", () => {
    expect(parsePullRequest({ message: "Not Found" })).toBeUndefined();
    expect(parsePullRequest(undefined)).toBeUndefined();
  });
});
