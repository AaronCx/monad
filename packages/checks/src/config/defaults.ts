import type { PipelineConfig } from "../types";

export function getDefaultConfig(): PipelineConfig {
  return {
    checks: {
      secrets: {
        enabled: true,
        severity: "fail",
      },
      lint: {
        enabled: true,
        severity: "fail",
      },
      typecheck: {
        enabled: true,
        severity: "fail",
        timeout: 300,
      },
      build: {
        enabled: false,
        severity: "fail",
        timeout: 120,
      },
      test: {
        enabled: false,
        severity: "warn",
        timeout: 600,
      },
      dependencies: {
        enabled: true,
        severity: "warn",
        fail_on: "critical",
      },
      file_patterns: {
        enabled: true,
        severity: "fail",
      },
      agent_patterns: {
        enabled: true,
        severity: "warn",
      },
    },
    review: {
      profile: "fast",
      install: "auto",
      max_findings: 25,
    },
  };
}
