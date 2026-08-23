import type { PolicyPack } from "./types";

/**
 * @lastgate/secrets-strict — maximum-sensitivity secret scanning. Blocks on a
 * low entropy threshold (catches shorter high-entropy strings), treats
 * entropy-only findings as critical, and blocks key/credential files. Use when
 * leaking a credential is the worst thing that can happen to this repo.
 */
export const secretsStrict: PolicyPack = {
  name: "@lastgate/secrets-strict",
  version: 1,
  description:
    "Maximum-sensitivity secret scanning: low entropy threshold, entropy findings treated as critical, and key/credential files blocked.",
  config: {
    checks: {
      secrets: {
        enabled: true,
        severity: "fail",
        entropy_threshold: 3.5,
        entropy_severity: "critical",
      },
      file_patterns: {
        enabled: true,
        severity: "fail",
        block: [
          "*.pem",
          "*.key",
          "*.p12",
          "*.pfx",
          "*.keystore",
          "*.jks",
          "id_rsa",
          "id_dsa",
          "id_ecdsa",
          "id_ed25519",
          ".env",
          ".env.*",
          "*.tfstate",
          "credentials.json",
          "service-account*.json",
        ],
        allow: [".env.example"],
      },
      dependencies: {
        enabled: true,
        severity: "warn",
        fail_on: "critical",
      },
    },
  },
};
