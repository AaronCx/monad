import { describe, expect, test } from "bun:test";
import { resolveWebhookIntent } from "../src/events.ts";
import type { NarrowedPullRequest, ReviewIntent } from "../src/events.ts";
import {
  commenterMayRunFix,
  hasWriteAccess,
  isForkPullRequest,
  resolveTrustFromIntent,
  resolveTrustFromPullRequest,
  WRITE_ASSOCIATIONS,
} from "../src/trust.ts";
import { checkRunEvent, issueCommentEvent, pullRequestEvent } from "./fixtures/payloads.ts";

/**
 * Trust from the signed payload only. Every case here goes through the real
 * narrowing first, so what is asserted is the decision made on the shape a
 * delivery actually produces.
 */

function prFrom(
  action: string,
  overrides: Record<string, unknown> = {},
  headRepo: string | null = "AaronCx/monad-review-demo",
): NarrowedPullRequest {
  const intent = resolveWebhookIntent({
    event: "pull_request",
    deliveryId: "d-1",
    payload: pullRequestEvent(action, overrides, headRepo),
  }) as ReviewIntent;
  if (intent.pullRequest === undefined) {
    throw new Error("the fixture did not produce a pull request");
  }
  return intent.pullRequest;
}

describe("hasWriteAccess", () => {
  for (const association of WRITE_ASSOCIATIONS) {
    test(`${association} has write access`, () => {
      expect(hasWriteAccess(association)).toBe(true);
    });
  }

  for (const association of [
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "MANNEQUIN",
    "NONE",
    "owner",
    "",
  ]) {
    test(`${association || "an empty association"} does not`, () => {
      expect(hasWriteAccess(association)).toBe(false);
    });
  }

  test("a missing association does not", () => {
    expect(hasWriteAccess(undefined)).toBe(false);
    expect(hasWriteAccess(null)).toBe(false);
  });
});

describe("resolveTrustFromPullRequest", () => {
  test("a same-repo branch from a MEMBER is trusted", () => {
    const decision = resolveTrustFromPullRequest(
      prFrom("opened", { author_association: "MEMBER" }),
    );
    expect(decision.trust).toBe("trusted");
    expect(decision.reason).toContain("MEMBER");
    expect(decision.reason).toContain("AaronCx/monad-review-demo");
  });

  test("a same-repo branch from an OWNER is trusted", () => {
    expect(resolveTrustFromPullRequest(prFrom("opened", { author_association: "OWNER" })).trust).toBe(
      "trusted",
    );
  });

  test("a same-repo branch from a CONTRIBUTOR is untrusted", () => {
    const decision = resolveTrustFromPullRequest(
      prFrom("opened", { author_association: "CONTRIBUTOR" }),
    );
    expect(decision.trust).toBe("untrusted");
    expect(decision.reason).toContain("not write access");
  });

  test("a fork PR from a CONTRIBUTOR is untrusted", () => {
    const decision = resolveTrustFromPullRequest(
      prFrom("opened", { author_association: "CONTRIBUTOR", user: { login: "stranger" } }, "stranger/monad-review-demo"),
    );
    expect(decision.trust).toBe("untrusted");
    expect(decision.reason).toContain("fork");
  });

  test("a fork PR from an OWNER is untrusted, because the fork's head is not the repo's", () => {
    const decision = resolveTrustFromPullRequest(
      prFrom("opened", { author_association: "OWNER" }, "AaronCx/my-own-fork"),
    );
    expect(decision.trust).toBe("untrusted");
    expect(decision.reason).toBe(
      "the pull request head is on AaronCx/my-own-fork, a fork of AaronCx/monad-review-demo",
    );
  });

  test("a head whose fork was deleted is untrusted", () => {
    const decision = resolveTrustFromPullRequest(prFrom("opened", { author_association: "OWNER" }, null));
    expect(decision.trust).toBe("untrusted");
    expect(decision.reason).toContain("no longer exists");
  });

  test("isForkPullRequest is the head/base comparison and nothing else", () => {
    expect(isForkPullRequest(prFrom("opened"))).toBe(false);
    expect(isForkPullRequest(prFrom("opened", {}, "stranger/monad-review-demo"))).toBe(true);
    expect(isForkPullRequest(prFrom("opened", {}, null))).toBe(true);
  });
});

describe("resolveTrustFromIntent", () => {
  test("a pull_request delivery decides from the payload", () => {
    const intent = resolveWebhookIntent({
      event: "pull_request",
      deliveryId: "d-2",
      payload: pullRequestEvent("synchronize"),
    }) as ReviewIntent;
    expect(resolveTrustFromIntent(intent).trust).toBe("trusted");
  });

  test("an @monad review comment is untrusted, because that payload proves nothing", () => {
    const intent = resolveWebhookIntent({
      event: "issue_comment",
      deliveryId: "d-3",
      payload: issueCommentEvent("@monad review"),
    }) as ReviewIntent;
    const decision = resolveTrustFromIntent(intent);
    expect(decision.trust).toBe("untrusted");
    expect(decision.reason).toContain("no pull request payload");
  });

  test("a check_run rerequest is untrusted for the same reason", () => {
    const intent = resolveWebhookIntent({
      event: "check_run",
      deliveryId: "d-4",
      payload: checkRunEvent("rerequested"),
    }) as ReviewIntent;
    expect(resolveTrustFromIntent(intent).trust).toBe("untrusted");
  });
});

describe("commenterMayRunFix", () => {
  function comment(association: string) {
    const intent = resolveWebhookIntent({
      event: "issue_comment",
      deliveryId: "d-5",
      payload: issueCommentEvent("@monad fix drop the import", { association }),
    });
    if (intent.kind !== "command") {
      throw new Error("the fixture did not produce a command");
    }
    return intent.comment;
  }

  test("a MEMBER may run fix", () => {
    expect(commenterMayRunFix(comment("MEMBER"))).toBe(true);
  });

  test("a COLLABORATOR may run fix", () => {
    expect(commenterMayRunFix(comment("COLLABORATOR"))).toBe(true);
  });

  test("a CONTRIBUTOR may not", () => {
    expect(commenterMayRunFix(comment("CONTRIBUTOR"))).toBe(false);
  });

  test("NONE may not", () => {
    expect(commenterMayRunFix(comment("NONE"))).toBe(false);
  });
});
