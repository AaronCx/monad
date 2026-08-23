import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LASTGATE_RENAME_NOTICE, loadConfig } from "../src/index";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "monad-config-"));
}

describe("loadConfig", () => {
  test("returns defaults when no config file exists", async () => {
    const dir = tmpRepo();
    const loaded = await loadConfig(dir);
    expect(loaded.source).toBe("defaults");
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.checks.secrets?.enabled).toBe(true);
  });

  test("reads .monad.yml when present", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".monad.yml"), "checks:\n  secrets:\n    enabled: true\n    severity: warn\n");
    const loaded = await loadConfig(dir);
    expect(loaded.source).toBe(".monad.yml");
    expect(loaded.config.checks.secrets?.severity).toBe("warn");
    expect(loaded.warnings).toEqual([]);
  });

  test(".monad.yml wins over .lastgate.yml when both exist", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".monad.yml"), "checks:\n  secrets:\n    enabled: true\n    severity: warn\n");
    writeFileSync(join(dir, ".lastgate.yml"), "checks:\n  secrets:\n    enabled: false\n    severity: fail\n");
    const loaded = await loadConfig(dir);
    expect(loaded.source).toBe(".monad.yml");
    expect(loaded.config.checks.secrets?.enabled).toBe(true);
    expect(loaded.config.checks.secrets?.severity).toBe("warn");
    expect(loaded.warnings).not.toContain(LASTGATE_RENAME_NOTICE);
  });

  test(".lastgate.yml fallback emits the rename notice", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".lastgate.yml"), "checks:\n  lint:\n    enabled: false\n    severity: fail\n");
    const loaded = await loadConfig(dir);
    expect(loaded.source).toBe(".lastgate.yml");
    expect(loaded.warnings).toContain(LASTGATE_RENAME_NOTICE);
    expect(LASTGATE_RENAME_NOTICE).toBe("reading .lastgate.yml; rename it to .monad.yml");
    expect(loaded.config.checks.lint?.enabled).toBe(false);
  });

  test("removed LastGate keys are ignored with a warning naming them", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, ".lastgate.yml"),
      [
        "checks:",
        "  secrets:",
        "    enabled: true",
        "  commit_message:",
        "    enabled: true",
        "  duplicates:",
        "    enabled: true",
        "notifications:",
        "  slack_webhook: https://example.invalid/hook",
        "agent_feedback:",
        "  format: structured",
        "",
      ].join("\n"),
    );
    const loaded = await loadConfig(dir);
    const joined = loaded.warnings.join("\n");
    expect(joined).toContain('"checks.commit_message" was removed');
    expect(joined).toContain('"checks.duplicates" was removed');
    expect(joined).toContain('"notifications" was removed');
    expect(joined).toContain('"agent_feedback" was removed');
    // The removed keys do not survive into the parsed config.
    expect((loaded.config as unknown as Record<string, unknown>).notifications).toBeUndefined();
    expect((loaded.config.checks as Record<string, unknown>).commit_message).toBeUndefined();
  });

  test("unknown keys anywhere warn with the key name instead of being silently stripped", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, ".monad.yml"),
      [
        "wibble: 1",
        "checks:",
        "  secrets:",
        "    enabled: true",
        "    frobnicate: true",
        "  semantic:",
        "    enabled: true",
        "review:",
        "  max_findings: 10",
        "  colour: blue",
        "",
      ].join("\n"),
    );
    const loaded = await loadConfig(dir);
    const joined = loaded.warnings.join("\n");
    expect(joined).toContain('unknown config key "wibble"');
    expect(joined).toContain('unknown config key "checks.secrets.frobnicate"');
    expect(joined).toContain('unknown config key "checks.semantic"');
    expect(joined).toContain('unknown config key "review.colour"');
    // Known siblings still parse.
    expect(loaded.config.review?.max_findings).toBe(10);
  });

  test("extends and built-in packs keep working through loadConfig", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".monad.yml"), 'extends: "@lastgate/agent-safety@1"\n');
    const loaded = await loadConfig(dir);
    expect(loaded.config.checks.agent_patterns?.severity).toBe("fail");
    expect(loaded.config.checks.secrets?.entropy_threshold).toBe(4.2);
  });

  test("the review block parses with defaults applied", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, ".monad.yml"),
      "review:\n  profile: full\n  install: symlink\n  prompt: .monad/review.md\n",
    );
    const loaded = await loadConfig(dir);
    expect(loaded.config.review?.profile).toBe("full");
    expect(loaded.config.review?.install).toBe("symlink");
    expect(loaded.config.review?.max_findings).toBe(25);
    expect(loaded.config.review?.prompt).toBe(".monad/review.md");
  });
});
