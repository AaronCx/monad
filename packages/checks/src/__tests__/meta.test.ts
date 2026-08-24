import { describe, test, expect } from "bun:test";
import { runCheckPipeline, resolveMeta, formatMetaFooter } from "../pipeline";
import { ENGINE_VERSION } from "../version";
import type { PipelineInput } from "../pipeline";

const baseInput: PipelineInput = {
  files: [{ path: "README.md", content: "# hi", status: "added" }],
  commits: [{ sha: "abc1234", message: "docs: hi", author: "a", timestamp: "" }],
};

describe("check run meta", () => {
  test("runCheckPipeline stamps engine version + resolved entropy threshold", async () => {
    const result = await runCheckPipeline(baseInput);
    expect(result.meta.engineVersion).toBe(ENGINE_VERSION);
    expect(result.meta.entropyThreshold).toBe(4.8); // default
    expect(result.meta.inlineIgnore).toBe(true);
  });

  test("meta reflects a configured entropy threshold", async () => {
    const result = await runCheckPipeline({
      ...baseInput,
      config: { checks: { secrets: { enabled: true, severity: "fail", entropy_threshold: 5.2 } } },
    });
    expect(result.meta.entropyThreshold).toBe(5.2);
  });

  test("the summary carries the provenance footer", async () => {
    const result = await runCheckPipeline(baseInput);
    expect(result.summary).toContain(`engine v${ENGINE_VERSION}`);
    expect(result.summary).toContain("inline-ignore on");
  });

  test("resolveMeta + formatMetaFooter format", () => {
    const meta = resolveMeta(undefined);
    expect(formatMetaFooter(meta)).toBe(`engine v${ENGINE_VERSION} · entropy 4.8 · inline-ignore on`);
  });
});
