import type { PolicyPack } from "./types";

/**
 * @lastgate/agent-safety — hardened defaults for repos where AI coding agents
 * open PRs. Strict secret scanning, agent-pattern detection promoted to a
 * failure, and dangerous-file blocks. (The pack's LastGate-era commit_message
 * and semantic entries were dropped with those checks in the monad port.)
 */
export const agentSafety: PolicyPack = {
  name: "@lastgate/agent-safety",
  version: 1,
  description:
    "Hardened defaults for repositories where AI coding agents open PRs: strict secrets, agent-pattern detection as a failure, and dangerous-file blocks.",
  config: {
    checks: {
      secrets: {
        enabled: true,
        severity: "fail",
        entropy_threshold: 4.2,
        entropy_severity: "high",
      },
      agent_patterns: {
        enabled: true,
        severity: "fail",
      },
      file_patterns: {
        enabled: true,
        severity: "fail",
        block: [
          "*.pem",
          "*.key",
          "*.p12",
          "*.pfx",
          "id_rsa",
          "id_ed25519",
          ".env",
          ".env.*",
          "*.sqlite",
          "*.db",
          "dump.sql",
        ],
        allow: [".env.example"],
      },
      dependencies: {
        enabled: true,
        severity: "fail",
        fail_on: "high",
      },
    },
  },
};
