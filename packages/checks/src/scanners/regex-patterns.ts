export interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium" | "low";
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  {
    name: "AWS Access Key ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    severity: "critical",
  },
  {
    name: "AWS Secret Access Key",
    pattern: /(?:aws_secret_access_key|aws_secret)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/i,
    severity: "critical",
  },

  // GitHub tokens
  {
    name: "GitHub Personal Access Token",
    pattern: /\bghp_[A-Za-z0-9]{36,}\b/,
    severity: "critical",
  },
  {
    name: "GitHub OAuth Token",
    pattern: /\bgho_[A-Za-z0-9]{36,}\b/,
    severity: "critical",
  },
  {
    name: "GitHub Server Token",
    pattern: /\bghs_[A-Za-z0-9]{36,}\b/,
    severity: "critical",
  },
  {
    name: "GitHub Refresh Token",
    pattern: /\bghr_[A-Za-z0-9]{36,}\b/,
    severity: "critical",
  },
  {
    name: "GitHub Fine-grained PAT",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    severity: "critical",
  },

  // OpenAI
  {
    name: "OpenAI API Key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
    severity: "critical",
  },
  {
    name: "OpenAI Project Key",
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
    severity: "critical",
  },

  // Anthropic
  {
    name: "Anthropic API Key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    severity: "critical",
  },

  // Supabase
  {
    name: "Supabase JWT",
    pattern: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    severity: "high",
  },

  // Stripe
  {
    name: "Stripe Live Secret Key",
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/,
    severity: "critical",
  },
  {
    name: "Stripe Test Secret Key",
    pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/,
    severity: "medium",
  },

  // Generic secret assignments
  {
    name: "Generic Password Assignment",
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']/i,
    severity: "high",
  },
  {
    name: "Generic Secret Assignment",
    pattern: /(?:secret)\s*[=:]\s*["'][^"']{8,}["']/i,
    severity: "high",
  },
  {
    name: "Generic Token Assignment",
    pattern: /(?:token)\s*[=:]\s*["'][^"']{8,}["']/i,
    severity: "high",
  },
  {
    name: "Generic API Key Assignment",
    pattern: /(?:apikey|api_key|api-key)\s*[=:]\s*["'][^"']{8,}["']/i,
    severity: "high",
  },

  // Private keys
  {
    name: "Private Key Header",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: "critical",
  },

  // Connection strings
  {
    name: "MongoDB Connection String",
    pattern: /mongodb(?:\+srv)?:\/\/[^\s"']+/i,
    severity: "high",
  },
  {
    name: "PostgreSQL Connection String",
    pattern: /postgres(?:ql)?:\/\/[^\s"']+/i,
    severity: "high",
  },
  {
    name: "MySQL Connection String",
    pattern: /mysql:\/\/[^\s"']+/i,
    severity: "high",
  },
  {
    name: "Redis Connection String",
    pattern: /redis:\/\/[^\s"']+/i,
    severity: "high",
  },
];
