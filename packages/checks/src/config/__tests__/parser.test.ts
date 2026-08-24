import { describe, test, expect } from "bun:test";
import { parseConfig } from "../parser";

describe("YAML Parser", () => {
  test("parses complete valid .lastgate.yml", () => {
    const yaml = `
checks:
  secrets:
    enabled: true
    severity: fail
    custom_patterns:
      - name: Internal Key
        pattern: "INTERNAL_[A-Z]+_KEY=.+"
        severity: critical
  typecheck:
    enabled: true
    severity: fail
    timeout: 200
  lint:
    enabled: true
    severity: fail
    command: "bunx biome check ."
  build:
    enabled: true
    severity: fail
    command: "bun run build"
    timeout: 180
  dependencies:
    enabled: true
    severity: warn
    fail_on: high
  file_patterns:
    enabled: true
    severity: fail
    block:
      - "*.sqlite"
    allow:
      - ".env.test"
  test:
    enabled: true
    severity: warn
    timeout: 120
  agent_patterns:
    enabled: true
    severity: warn
protected_branches:
  - main
  - production
`;
    const config = parseConfig(yaml);
    expect(config.checks.secrets?.enabled).toBe(true);
    expect(config.checks.secrets?.custom_patterns?.length).toBe(1);
    expect(config.checks.typecheck?.timeout).toBe(200);
    expect(config.checks.lint?.command).toBe("bunx biome check .");
    expect(config.checks.build?.timeout).toBe(180);
    expect(config.checks.dependencies?.fail_on).toBe("high");
    expect(config.checks.file_patterns?.block).toContain("*.sqlite");
    expect(config.checks.file_patterns?.allow).toContain(".env.test");
    expect(config.checks.test?.timeout).toBe(120);
    expect(config.protected_branches).toContain("main");
  });

  test("parses minimal config (version only fallback)", () => {
    const config = parseConfig("version: 1");
    // Should merge with defaults
    expect(config.checks.secrets?.enabled).toBe(true);
    expect(config.checks.lint?.enabled).toBe(true);
    expect(config.checks.build?.enabled).toBe(false);
  });

  test("applies defaults for missing fields", () => {
    const yaml = `
checks:
  secrets:
    enabled: false
`;
    const config = parseConfig(yaml);
    expect(config.checks.secrets?.enabled).toBe(false);
    // Other checks should get defaults
    expect(config.checks.lint?.enabled).toBe(true);
    expect(config.checks.build?.enabled).toBe(false);
    expect(config.checks.typecheck?.timeout).toBe(300);
  });

  test("parses custom block and allow patterns in file_patterns", () => {
    const yaml = `
checks:
  file_patterns:
    enabled: true
    block:
      - "*.sqlite"
      - "*.bak"
    allow:
      - ".env.test"
      - ".env.ci"
`;
    const config = parseConfig(yaml);
    expect(config.checks.file_patterns?.block).toEqual(["*.sqlite", "*.bak"]);
    expect(config.checks.file_patterns?.allow).toEqual([".env.test", ".env.ci"]);
  });

  test("parses custom_patterns in secrets config", () => {
    const yaml = `
checks:
  secrets:
    enabled: true
    custom_patterns:
      - name: Internal Token
        pattern: "INT_TOKEN_[A-Za-z0-9]{32}"
        severity: high
      - name: Service Key
        pattern: "SVC_[A-Z]{4}_KEY=.+"
`;
    const config = parseConfig(yaml);
    expect(config.checks.secrets?.custom_patterns?.length).toBe(2);
    expect(config.checks.secrets?.custom_patterns?.[0].name).toBe("Internal Token");
  });

  test("returns defaults for invalid YAML (syntax error)", () => {
    const config = parseConfig("{{{{invalid yaml::::}}}}");
    // Should not crash, should return defaults
    expect(config.checks.secrets?.enabled).toBe(true);
  });

  test("returns defaults for empty input", () => {
    const config = parseConfig("");
    expect(config.checks.secrets?.enabled).toBe(true);
    expect(config.checks.lint?.enabled).toBe(true);
  });
});
