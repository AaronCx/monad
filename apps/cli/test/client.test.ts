import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { describePromptError } from "../src/client.ts";

describe("describePromptError", () => {
  test("maps the vendor's auth_required to the login command", () => {
    const message = describePromptError(RequestError.authRequired());
    expect(message).toContain("Claude login is required");
    expect(message).toContain("--cli auth login --claudeai");
    // The daemon never proxies vendor auth; the user runs the vendor binary.
    expect(message).toContain("never stores or forwards vendor tokens");
  });

  test("maps the prompt-in-flight code to a wait message", () => {
    const error = new RequestError(-32001, "a prompt is already in flight");
    expect(describePromptError(error)).toContain("already in flight");
  });

  test("falls back to the error message for anything else", () => {
    expect(describePromptError(new Error("boom"))).toBe("error: boom");
  });
});
