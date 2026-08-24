import { describe, expect, test } from "bun:test";
import {
  ACK_REACTION,
  fetchPullRequest,
  postIssueComment,
  reactToComment,
} from "../src/comments.ts";
import { fakeOctokit } from "./fixtures/fake-octokit.ts";
import { HEAD_SHA, pullRequest, REPO } from "./fixtures/payloads.ts";

describe("reactToComment", () => {
  test("posts the reaction on the comment, not on the pull request", async () => {
    const fake = fakeOctokit();
    await reactToComment(fake.octokit, {
      owner: "AaronCx",
      repo: "monad-review-demo",
      commentId: 991,
      content: ACK_REACTION,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.route).toBe(
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
    );
    expect(fake.calls[0]?.params).toEqual({
      owner: "AaronCx",
      repo: "monad-review-demo",
      comment_id: 991,
      content: "eyes",
    });
  });
});

describe("postIssueComment", () => {
  test("replies on the pull request's conversation", async () => {
    const fake = fakeOctokit();
    await postIssueComment(fake.octokit, {
      owner: "AaronCx",
      repo: "monad-review-demo",
      number: 7,
      body: "hello",
    });
    expect(fake.calls[0]?.route).toBe("POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
    expect(fake.calls[0]?.params.issue_number).toBe(7);
  });
});

describe("fetchPullRequest", () => {
  test("narrows what the API returns", async () => {
    const fake = fakeOctokit((route) =>
      route.includes("pulls") ? { status: 200, data: pullRequest() } : undefined,
    );
    const pr = await fetchPullRequest(fake.octokit, {
      owner: "AaronCx",
      repo: "monad-review-demo",
      number: 7,
    });
    expect(pr?.head.sha).toBe(HEAD_SHA);
    expect(pr?.base.repo.full_name).toBe(REPO.full_name);
  });

  test("an answer that is not a pull request is undefined", async () => {
    const fake = fakeOctokit(() => ({ status: 404, data: { message: "Not Found" } }));
    const pr = await fetchPullRequest(fake.octokit, {
      owner: "AaronCx",
      repo: "monad-review-demo",
      number: 7,
    });
    expect(pr).toBeUndefined();
  });
});
