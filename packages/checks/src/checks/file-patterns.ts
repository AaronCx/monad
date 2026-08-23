import type { ChangedFile, CheckResult, FilePatternCheckConfig } from "../types";
import { statusFromFindings } from "./status";

// Directory artifact patterns are prefixed with `**/` so they match at ANY
// depth — `**/dist/**` blocks both `dist/x` and `packages/app/dist/x`. A bare
// `dist/**` compiles to `^dist/.*$`, which silently misses every sub-package
// copy (the common case in a monorepo — LastGate is itself one).
const DEFAULT_BLOCKED_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "**/node_modules/**",
  "**/__pycache__/**",
  ".DS_Store",
  "*.log",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/.claude/**",
];

/**
 * Simple glob matching without external dependencies.
 * Supports: *, **, ?, and basic character patterns.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === ".") {
      regex += "\\.";
      i++;
    } else if (ch === "/" && i === pattern.length - 1) {
      regex += "/.*";
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

function matchesPattern(filepath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    return filepath.startsWith(pattern) || filepath === pattern.slice(0, -1);
  }

  // Exact match for dotfiles like .env
  if (pattern === ".env") {
    const basename = filepath.split("/").pop() ?? filepath;
    return basename === ".env";
  }

  // Pattern like .env.* should match .env.local, .env.production, etc.
  if (pattern.startsWith(".env.") && pattern.includes("*")) {
    const basename = filepath.split("/").pop() ?? filepath;
    const regex = globToRegex(pattern);
    return regex.test(basename);
  }

  // For patterns without path separators, match against the basename
  if (!pattern.includes("/")) {
    const basename = filepath.split("/").pop() ?? filepath;
    const regex = globToRegex(pattern);
    if (regex.test(basename)) return true;
  }

  // Match against full path
  const regex = globToRegex(pattern);
  return regex.test(filepath);
}

export async function checkFilePatterns(
  files: ChangedFile[],
  config: FilePatternCheckConfig,
): Promise<CheckResult> {
  const findings: Array<{ file: string; pattern: string }> = [];

  const blockedPatterns: string[] = [...DEFAULT_BLOCKED_PATTERNS];
  if (config.block) {
    blockedPatterns.push(...config.block);
  }

  const allowPatterns: string[] = [];
  const actualBlocked: string[] = [];

  for (const p of blockedPatterns) {
    if (p.startsWith("!")) {
      allowPatterns.push(p.slice(1));
    } else {
      actualBlocked.push(p);
    }
  }

  if (config.allow) {
    allowPatterns.push(...config.allow);
  }

  for (const file of files) {
    if (file.status === "removed") continue;

    const filepath = file.path;

    const isAllowed = allowPatterns.some((pattern) =>
      matchesPattern(filepath, pattern),
    );
    if (isAllowed) continue;

    for (const pattern of actualBlocked) {
      if (matchesPattern(filepath, pattern)) {
        findings.push({ file: filepath, pattern });
        break;
      }
    }
  }

  // file_patterns findings are always high-severity (committing .env / *.pem /
  // a private key file is a real safety issue), so they propagate via the
  // shared statusFromFindings: with severity=fail (default) → fail; with
  // severity=warn → warn (the user opted out).
  const severitySources = findings.map(() => ({ severity: "high" as const }));
  return {
    type: "file_patterns",
    status: statusFromFindings(severitySources, { severity: config.severity }),
    title: "File Pattern Guard",
    summary: findings.length === 0
      ? "No blocked file patterns detected"
      : `Found ${findings.length} file(s) matching blocked patterns`,
    details: {
      findings: findings.map((f) => ({
        file: f.file,
        message: `Blocked file pattern: ${f.pattern}`,
        blockedBy: f.pattern,
      })),
      count: findings.length,
      checked: actualBlocked.slice(0, 10),
    },
  };
}
