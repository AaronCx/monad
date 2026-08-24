import { describe, expect, test } from "bun:test";
import type { Annotation } from "@aaroncx/checks";
import {
  annotationTruncationNote,
  CHECK_RUN_NAME,
  clampSummary,
  completeCheckRun,
  createCheckRun,
  MAX_ANNOTATIONS_PER_REQUEST,
  MAX_ANNOTATIONS_TOTAL,
  MAX_SUMMARY_LENGTH,
  updateCheckRun,
} from "../src/check-runs.ts";
import { fakeOctokit } from "./fixtures/fake-octokit.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = () => new Date("2026-08-24T12:00:00.000Z");

function annotations(count: number): Annotation[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: "warning" as const,
    message: `finding ${index}`,
    title: `rule ${index}`,
  }));
}

function outputsOf(calls: Array<{ params: Record<string, unknown> }>) {
  return calls.map((call) => call.params.output as { title: string; summary: string; annotations: Annotation[] });
}

describe("createCheckRun", () => {
  test("posts a queued run named monad on the head sha", async () => {
    const fake = fakeOctokit();
    const created = await createCheckRun(fake.octokit, {
      owner: "AaronCx",
      repo: "monad-review-demo",
      headSha: HEAD_SHA,
      now: NOW,
    });
    expect(created.id).toBe(4242);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.route).toBe("POST /repos/{owner}/{repo}/check-runs");
    expect(fake.calls[0]?.params).toEqual({
      owner: "AaronCx",
      repo: "monad-review-demo",
      name: CHECK_RUN_NAME,
      head_sha: HEAD_SHA,
      status: "queued",
      started_at: "2026-08-24T12:00:00.000Z",
      output: undefined,
    });
  });

  test("the name and the status are overridable", async () => {
    const fake = fakeOctokit();
    await createCheckRun(fake.octokit, {
      owner: "AaronCx",
      repo: "monad",
      headSha: HEAD_SHA,
      name: "monad (staging)",
      status: "in_progress",
      now: NOW,
    });
    expect(fake.calls[0]?.params).toMatchObject({ name: "monad (staging)", status: "in_progress" });
  });
});

describe("updateCheckRun", () => {
  test("in_progress carries the trust line and no completed_at", async () => {
    const fake = fakeOctokit();
    await updateCheckRun(fake.octokit, {
      owner: "AaronCx",
      repo: "monad",
      checkRunId: 55,
      status: "in_progress",
      output: {
        title: "reviewing",
        summary: "untrusted PR: install, build, and test do not run",
      },
      now: NOW,
    });
    expect(fake.calls[0]?.route).toBe("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");
    expect(fake.calls[0]?.params).toMatchObject({
      check_run_id: 55,
      status: "in_progress",
      completed_at: undefined,
      conclusion: undefined,
    });
    expect(outputsOf(fake.calls)[0]?.summary).toContain("install, build, and test do not run");
  });

  test("completed stamps completed_at", async () => {
    const fake = fakeOctokit();
    await updateCheckRun(fake.octokit, {
      owner: "AaronCx",
      repo: "monad",
      checkRunId: 55,
      status: "completed",
      conclusion: "success",
      now: NOW,
    });
    expect(fake.calls[0]?.params).toMatchObject({
      completed_at: "2026-08-24T12:00:00.000Z",
      conclusion: "success",
    });
  });
});

describe("completeCheckRun annotation paging", () => {
  const base = {
    owner: "AaronCx",
    repo: "monad-review-demo",
    checkRunId: 55,
    conclusion: "failure" as const,
    title: "needs_changes: 3 findings",
    summary: "the summary",
    now: NOW,
  };

  test("no annotations is one request", async () => {
    const fake = fakeOctokit();
    const result = await completeCheckRun(fake.octokit, { ...base, annotations: [] });
    expect(result).toEqual({ requests: 1, annotationsSent: 0, dropped: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(outputsOf(fake.calls)[0]?.annotations).toEqual([]);
  });

  test("exactly 50 annotations is one request", async () => {
    const fake = fakeOctokit();
    const result = await completeCheckRun(fake.octokit, {
      ...base,
      annotations: annotations(MAX_ANNOTATIONS_PER_REQUEST),
    });
    expect(result.requests).toBe(1);
    expect(outputsOf(fake.calls)[0]?.annotations).toHaveLength(50);
  });

  test("60 annotations page across two update calls", async () => {
    const fake = fakeOctokit();
    const all = annotations(60);
    const result = await completeCheckRun(fake.octokit, { ...base, annotations: all });

    expect(result).toEqual({ requests: 2, annotationsSent: 60, dropped: 0 });
    expect(fake.calls).toHaveLength(2);

    const outputs = outputsOf(fake.calls);
    expect(outputs[0]?.annotations).toHaveLength(50);
    expect(outputs[1]?.annotations).toHaveLength(10);
    // In order, complete, and nothing repeated across the pages.
    expect([...(outputs[0]?.annotations ?? []), ...(outputs[1]?.annotations ?? [])]).toEqual(all);
    // Both calls leave the run in the same completed state.
    for (const call of fake.calls) {
      expect(call.params).toMatchObject({
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-24T12:00:00.000Z",
      });
    }
    for (const output of outputs) {
      expect(output.title).toBe(base.title);
      expect(output.summary).toBe(base.summary);
    }
  });

  test("more than 200 annotations truncates and says so in the summary", async () => {
    const fake = fakeOctokit();
    const result = await completeCheckRun(fake.octokit, { ...base, annotations: annotations(243) });

    expect(result).toEqual({ requests: 4, annotationsSent: MAX_ANNOTATIONS_TOTAL, dropped: 43 });
    const outputs = outputsOf(fake.calls);
    expect(outputs.map((output) => output.annotations.length)).toEqual([50, 50, 50, 50]);
    for (const output of outputs) {
      expect(output.summary).toContain(annotationTruncationNote(243));
      expect(output.summary).toContain("Showing the first 200 of 243 annotations");
      expect(output.summary).toContain("The remaining 43");
    }
  });

  test("exactly 200 annotations does not claim truncation", async () => {
    const fake = fakeOctokit();
    const result = await completeCheckRun(fake.octokit, {
      ...base,
      annotations: annotations(MAX_ANNOTATIONS_TOTAL),
    });
    expect(result.dropped).toBe(0);
    expect(outputsOf(fake.calls)[0]?.summary).toBe(base.summary);
  });
});

describe("clampSummary", () => {
  test("a summary under the limit is untouched", () => {
    expect(clampSummary("short")).toBe("short");
  });

  test("a summary over the limit is cut and says it was cut", () => {
    const clamped = clampSummary("x".repeat(MAX_SUMMARY_LENGTH + 1000));
    expect(clamped.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(clamped).toContain("summary truncated");
  });

  test("createCheckRun and updateCheckRun both clamp", async () => {
    const fake = fakeOctokit();
    const long = "y".repeat(MAX_SUMMARY_LENGTH + 10);
    await createCheckRun(fake.octokit, {
      owner: "a",
      repo: "b",
      headSha: HEAD_SHA,
      output: { title: "t", summary: long },
      now: NOW,
    });
    await updateCheckRun(fake.octokit, {
      owner: "a",
      repo: "b",
      checkRunId: 1,
      status: "completed",
      conclusion: "neutral",
      output: { title: "t", summary: long },
      now: NOW,
    });
    for (const output of outputsOf(fake.calls)) {
      expect(output.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    }
  });
});
