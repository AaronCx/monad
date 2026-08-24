import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeDroppedConfigFields,
  getDefaultConfig,
  LASTGATE_RENAME_NOTICE,
  loadConfig,
  loadConfigAtRef,
  sanitizeUntrustedConfig,
  UNTRUSTED_CONFIG_FIELDS,
} from "../src/index";

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

function gitRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "monad-config-ref-"));
  const run = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  run("init", "-q", "-b", "main");
  return { dir, git: run };
}

describe("loadConfigAtRef", () => {
  test("returns defaults when the base commit has no config file", async () => {
    const { dir, git } = gitRepo();
    writeFileSync(join(dir, "README.md"), "# base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    // The head adds a config; reading at the base must not see it.
    writeFileSync(join(dir, ".monad.yml"), "checks:\n  lint:\n    command: ./pwn.sh\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");

    const loaded = await loadConfigAtRef(dir, baseSha);
    expect(loaded.source).toBe("defaults");
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.checks.lint?.command).toBeUndefined();
    // Same directory, read from the worktree, sees the attacker's command.
    expect((await loadConfig(dir)).config.checks.lint?.command).toBe("./pwn.sh");
  });

  test("returns the base's config when the head deleted it", async () => {
    const { dir, git } = gitRepo();
    writeFileSync(join(dir, ".monad.yml"), "review:\n  max_findings: 7\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    rmSync(join(dir, ".monad.yml"));
    git("add", "-A");
    git("commit", "-q", "-m", "head deletes the config");

    const loaded = await loadConfigAtRef(dir, baseSha);
    expect(loaded.source).toBe(".monad.yml");
    expect(loaded.config.review?.max_findings).toBe(7);
    expect((await loadConfig(dir)).source).toBe("defaults");
  });

  test("falls back to .lastgate.yml at the ref, with the rename notice", async () => {
    const { dir, git } = gitRepo();
    writeFileSync(join(dir, ".lastgate.yml"), "checks:\n  lint:\n    enabled: false\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");

    const loaded = await loadConfigAtRef(dir, baseSha);
    expect(loaded.source).toBe(".lastgate.yml");
    expect(loaded.warnings).toContain(LASTGATE_RENAME_NOTICE);
    expect(loaded.config.checks.lint?.enabled).toBe(false);
  });

  test("a ref that does not resolve throws instead of quietly falling back to defaults", async () => {
    const { dir, git } = gitRepo();
    // The config exists in the working tree but not in any commit: git show
    // would answer "exists on disk, but not in <ref>" for a bad ref, which
    // reads exactly like a genuine absence. The ref check is what separates
    // them, so an unreadable base can never look like "no rules configured".
    writeFileSync(join(dir, ".monad.yml"), "review:\n  max_findings: 7\n");
    writeFileSync(join(dir, "README.md"), "# base\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "base");
    expect(loadConfigAtRef(dir, "0000000000000000000000000000000000000000")).rejects.toThrow(
      /does not resolve/,
    );
    expect(loadConfigAtRef(dir, "nosuchref")).rejects.toThrow(/does not resolve/);
  });

  test("a ref that could be read as a git option is refused", async () => {
    const { dir } = gitRepo();
    expect(loadConfigAtRef(dir, "--upload-pack=touch /tmp/pwned")).rejects.toThrow(
      /not a usable git ref/,
    );
  });
});

describe("sanitizeUntrustedConfig", () => {
  const hostile = () =>
    ({
      version: 1,
      extends: "@lastgate/agent-safety@1",
      allow: ["docs/**"],
      baseline: ".monad-baseline.json",
      protected_branches: ["main"],
      checks: {
        secrets: {
          enabled: true,
          severity: "fail",
          entropy_threshold: 4.2,
          custom_patterns: [{ name: "redos", pattern: "(a+)+$" }],
        },
        lint: { enabled: true, severity: "fail", command: "./pwn.sh" },
        typecheck: { enabled: true, severity: "fail", command: "./pwn.sh", timeout: 300 },
        build: { enabled: true, severity: "fail", command: "./pwn.sh", timeout: 120 },
        test: { enabled: true, severity: "fail", command: "./pwn.sh", timeout: 600 },
        dependencies: { enabled: true, severity: "warn", fail_on: "critical" },
        file_patterns: { enabled: true, severity: "fail", block: ["*.env"] },
        agent_patterns: { enabled: true, severity: "warn" },
      },
      review: { profile: "full", install: "auto", max_findings: 25, prompt: ".monad/review.md" },
    }) as unknown as Parameters<typeof sanitizeUntrustedConfig>[0];

  test("drops every executing field and names each one", () => {
    const { config, dropped } = sanitizeUntrustedConfig(hostile());
    expect(dropped.sort()).toEqual(
      [
        "checks.build.command",
        "checks.lint.command",
        "checks.secrets.custom_patterns",
        "checks.test.command",
        "checks.typecheck.command",
        "extends",
        "review.prompt",
      ].sort(),
    );
    expect(config.checks.lint?.command).toBeUndefined();
    expect(config.checks.typecheck?.command).toBeUndefined();
    expect(config.checks.build?.command).toBeUndefined();
    expect(config.checks.test?.command).toBeUndefined();
    expect(config.checks.secrets?.custom_patterns).toBeUndefined();
    expect(config.review?.prompt).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).extends).toBeUndefined();
    // UNTRUSTED_CONFIG_FIELDS is the documented list; it must match reality.
    expect(([...UNTRUSTED_CONFIG_FIELDS] as string[]).sort()).toEqual(dropped.sort());
  });

  test("leaves everything else identical and never mutates the input", () => {
    const input = hostile();
    const before = structuredClone(input);
    const { config } = sanitizeUntrustedConfig(input);
    expect(input).toEqual(before);

    // The expected value is the input with exactly the dropped LEAF NAMES
    // removed. In this fixture each of those names occurs only where it is
    // meant to, so a JSON replacer builds the expectation without repeating
    // the implementation's own traversal.
    const droppedLeaves = new Set(["command", "custom_patterns", "prompt", "extends"]);
    const strip = (key: string, value: unknown): unknown =>
      droppedLeaves.has(key) ? undefined : value;
    const expected = JSON.parse(JSON.stringify(before, strip as never));
    expect(JSON.parse(JSON.stringify(config))).toEqual(expected);
  });

  test("reports nothing dropped for a config that sets none of them", () => {
    const { config, dropped } = sanitizeUntrustedConfig(getDefaultConfig());
    expect(dropped).toEqual([]);
    expect(config).toEqual(getDefaultConfig());
    expect(describeDroppedConfigFields(dropped)).toBeUndefined();
  });

  test("the dropped-fields note names the fields", () => {
    const { dropped } = sanitizeUntrustedConfig(hostile());
    const note = describeDroppedConfigFields(dropped);
    expect(note).toContain("checks.lint.command");
    expect(note).toContain("review.prompt");
    expect(note).toContain("0009");
  });
});
