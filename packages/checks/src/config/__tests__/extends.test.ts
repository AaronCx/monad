import { describe, test, expect } from "bun:test";
import { parseConfig } from "../parser";
import { resolveExtends } from "../extends";
import {
  parsePackRef,
  resolveBuiltinPack,
  BUILTIN_PACK_NAMES,
  type PolicyPack,
  type PackResolver,
} from "../packs";
import { validateConfig } from "../schema";

describe("parsePackRef — versioned pack syntax", () => {
  test("parses scoped name with version", () => {
    expect(parsePackRef("@lastgate/agent-safety@1")).toEqual({
      name: "@lastgate/agent-safety",
      version: 1,
      raw: "@lastgate/agent-safety@1",
    });
  });

  test("parses scoped name without version", () => {
    expect(parsePackRef("@lastgate/agent-safety")).toEqual({
      name: "@lastgate/agent-safety",
      version: undefined,
      raw: "@lastgate/agent-safety",
    });
  });

  test("parses bare name with version", () => {
    expect(parsePackRef("solo-dev@1")).toEqual({
      name: "solo-dev",
      version: 1,
      raw: "solo-dev@1",
    });
  });

  test("the leading @ of a scope is not treated as a version separator", () => {
    expect(parsePackRef("@lastgate/secrets-strict").name).toBe(
      "@lastgate/secrets-strict",
    );
  });

  test("rejects a non-numeric version suffix", () => {
    expect(() => parsePackRef("@lastgate/agent-safety@latest")).toThrow(
      /version must be a major-version integer/,
    );
  });
});

describe("extends — single pack resolution", () => {
  test("extends a single pack and merges its config over defaults", () => {
    const cfg = parseConfig('extends: "@lastgate/agent-safety@1"');
    // Pack promotes agent_patterns to a failure...
    expect(cfg.checks.agent_patterns?.severity).toBe("fail");
    // ...and tightens the secret entropy threshold.
    expect(cfg.checks.secrets?.entropy_threshold).toBe(4.2);
    // Unspecified-by-pack checks still get engine defaults.
    expect(cfg.checks.typecheck?.enabled).toBe(true);
  });

  test("the bare (unscoped) pack name resolves identically", () => {
    const scoped = parseConfig('extends: "@lastgate/agent-safety"');
    const bare = parseConfig("extends: agent-safety");
    expect(bare.checks.agent_patterns?.severity).toBe(
      scoped.checks.agent_patterns?.severity,
    );
  });

  test("extends: agent-safety alone produces a fully valid PipelineConfig", () => {
    const cfg = parseConfig("extends: agent-safety");
    // Re-validating the produced config must not throw — every required field
    // is present and in-range.
    expect(() => validateConfig(cfg)).not.toThrow();
    expect(cfg.checks.secrets?.enabled).toBe(true);
    expect(cfg.checks.lint?.enabled).toBeDefined();
  });
});

describe("extends — merge order and local override", () => {
  test("the local file overrides the pack", () => {
    const cfg = parseConfig(`
extends: "@lastgate/agent-safety@1"
checks:
  agent_patterns:
    severity: warn
`);
    // Pack set fail; local downgrades to warn — local wins.
    expect(cfg.checks.agent_patterns?.severity).toBe("warn");
    // A field the local file did not touch keeps the pack value.
    expect(cfg.checks.dependencies?.severity).toBe("fail");
  });

  test("multiple packs merge in order, later packs override earlier", () => {
    const cfg = parseConfig(
      'extends: ["@lastgate/solo-dev", "@lastgate/secrets-strict"]',
    );
    // solo-dev sets entropy 5.0; secrets-strict (later) overrides to 3.5.
    expect(cfg.checks.secrets?.entropy_threshold).toBe(3.5);
    expect(cfg.checks.secrets?.entropy_severity).toBe("critical");
    // A check only solo-dev configures survives (secrets-strict is silent on it).
    expect(cfg.checks.lint?.severity).toBe("warn");
  });

  test("local override beats even the last pack in the list", () => {
    const cfg = parseConfig(`
extends: ["@lastgate/solo-dev", "@lastgate/secrets-strict"]
checks:
  secrets:
    entropy_threshold: 6.0
`);
    expect(cfg.checks.secrets?.entropy_threshold).toBe(6.0);
  });

  test("array overrides replace, they do not concatenate", () => {
    const cfg = parseConfig(`
extends: "@lastgate/secrets-strict"
checks:
  file_patterns:
    block:
      - "*.custom"
`);
    expect(cfg.checks.file_patterns?.block).toEqual(["*.custom"]);
  });
});

describe("extends — error handling", () => {
  test("unknown pack errors with a clear, actionable message", () => {
    expect(() => parseConfig('extends: "@lastgate/does-not-exist"')).toThrow(
      /Unknown policy pack/,
    );
    expect(() => parseConfig("extends: nope")).toThrow(
      new RegExp(BUILTIN_PACK_NAMES[0]),
    );
  });

  test("a pinned version that does not match the bundled pack errors", () => {
    expect(() => parseConfig('extends: "@lastgate/agent-safety@9"')).toThrow(
      /version 9 is not available/,
    );
  });

  test("non-string extends entry errors", () => {
    expect(() => parseConfig("extends:\n  - 123")).toThrow(
      /must be a string pack reference/,
    );
  });

  test("circular extends is detected and reported with the cycle", () => {
    // Use a custom resolver to construct a cycle (built-ins are acyclic).
    const a: PolicyPack = {
      name: "@lastgate/cycle-a",
      version: 1,
      description: "a",
      config: { extends: "@lastgate/cycle-b" },
    };
    const b: PolicyPack = {
      name: "@lastgate/cycle-b",
      version: 1,
      description: "b",
      config: { extends: "@lastgate/cycle-a" },
    };
    const registry = new Map([
      [a.name, a],
      [b.name, b],
    ]);
    const resolver: PackResolver = (ref) => registry.get(ref.name);
    expect(() =>
      resolveExtends({ extends: "@lastgate/cycle-a" }, resolver),
    ).toThrow(/Circular extends detected/);
  });

  test("a pack that extends itself is circular", () => {
    const selfish: PolicyPack = {
      name: "@lastgate/selfish",
      version: 1,
      description: "self",
      config: { extends: "@lastgate/selfish" },
    };
    const resolver: PackResolver = (ref) =>
      ref.name === selfish.name ? selfish : undefined;
    expect(() =>
      resolveExtends({ extends: "@lastgate/selfish" }, resolver),
    ).toThrow(/Circular extends detected/);
  });
});

describe("built-in packs — each is internally valid", () => {
  test("every built-in pack name parses and resolves", () => {
    for (const name of BUILTIN_PACK_NAMES) {
      const pack = resolveBuiltinPack(parsePackRef(name));
      expect(pack).toBeDefined();
      expect(pack?.name).toBe(name);
    }
  });

  test("each built-in pack produces a schema-valid config when extended", () => {
    for (const name of BUILTIN_PACK_NAMES) {
      const cfg = parseConfig(`extends: "${name}"`);
      expect(() => validateConfig(cfg)).not.toThrow();
    }
  });
});

describe("extends — no-op when absent", () => {
  test("config without extends behaves exactly as before", () => {
    const cfg = parseConfig(`
checks:
  secrets:
    enabled: false
`);
    expect(cfg.checks.secrets?.enabled).toBe(false);
    expect(cfg.checks.lint?.enabled).toBe(true);
  });
});
