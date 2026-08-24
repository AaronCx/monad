import type { AddedLine, ChangedFile, CheckContext, CheckResult, FindingSeverity, SecretCheckConfig } from "../types";
import { SECRET_PATTERNS, type SecretPattern } from "../scanners/regex-patterns";
import { calculateEntropy, extractTokens } from "../scanners/entropy";
import { parseAddedLines } from "../diff/parse";
import { statusFromFindings } from "./status";
import { fingerprint, isLineIgnored, isPathAllowed } from "../config/allowlist";

const DEFAULT_ENTROPY_THRESHOLD = 4.8;
const DEFAULT_ENTROPY_SEVERITY: FindingSeverity = "medium";

/**
 * Effective entropy floor for a token, scaled to its character set. The default
 * threshold (4.8) exceeds the maximum Shannon entropy of a hex string
 * (log2(16) = 4.0), so a pure-hex secret — a hex API key or a 32+ char token —
 * could NEVER trip the entropy fallback; a genuine 40-char AWS secret access
 * key (base64-ish) scores ~4.71, also under 4.8. Lower the floor for those two
 * charset classes so real secrets are caught. Short hex (colors, sha fragments)
 * stays under the 20-char length gate in extractTokens. The floor is capped by
 * the configured threshold so a stricter user/pack setting still wins.
 */
function effectiveEntropyFloor(token: string, configured: number): number {
  // Pure hex, long enough to be key-like (max entropy is only 4.0).
  if (/^[0-9a-fA-F]+$/.test(token)) {
    return token.length >= 32 ? Math.min(configured, 3.0) : configured;
  }
  // base64 / base64url alphabet (also the shape of an AWS secret access key).
  if (/^[A-Za-z0-9+/=_-]+$/.test(token) && token.length >= 32) {
    return Math.min(configured, 4.0);
  }
  return configured;
}

// Guards for untrusted custom patterns sourced from the PR's .lastgate.yml.
const MAX_CUSTOM_PATTERN_LENGTH = 256;
const MAX_CUSTOM_PATTERN_LINE_LENGTH = 4096;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pyc", ".pyo", ".class", ".o", ".obj",
  ".sqlite", ".db", ".lock",
]);

function isBinaryFile(filename: string): boolean {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return false;
  const ext = filename.substring(dotIndex).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function redact(value: string): string {
  if (value.length <= 12) {
    return `${value.substring(0, 2)}***${value.substring(value.length - 2)}`;
  }
  return `${value.substring(0, 4)}***${value.substring(value.length - 4)}`;
}

interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
  severity: FindingSeverity;
}

export async function checkSecrets(
  files: ChangedFile[],
  config: SecretCheckConfig,
  context?: CheckContext,
): Promise<CheckResult> {
  const findings: Finding[] = [];
  const allowGlobs = [...(context?.allow ?? []), ...(config.allow ?? [])];
  const baseline = context?.baseline;

  const isSuppressed = (
    file: ChangedFile,
    lineNo: number,
    text: string,
    rule: string,
    redactedMatch: string,
  ): boolean => {
    if (isPathAllowed(file.path, allowGlobs)) return true;
    const contentLines = file.content ? file.content.split("\n") : [];
    if (isLineIgnored(lineNo, contentLines, text)) return true;
    if (baseline && baseline.size > 0) {
      const fp = fingerprint({ check: "secrets", file: file.path, rule, redactedMatch });
      if (baseline.has(fp)) return true;
    }
    return false;
  };

  // Compile custom patterns if any. Patterns come from the PR branch's
  // .lastgate.yml, so treat them as untrusted: cap their length and skip any
  // that fail to compile instead of crashing the whole check.
  const customPatterns: Array<SecretPattern & { custom: true }> = [];
  for (const p of config.custom_patterns ?? []) {
    if (typeof p.pattern !== "string" || p.pattern.length > MAX_CUSTOM_PATTERN_LENGTH) continue;
    try {
      customPatterns.push({
        name: p.name,
        pattern: new RegExp(p.pattern, "gi"),
        severity: (p.severity ?? "high") as "critical" | "high",
        custom: true,
      });
    } catch {
      // Invalid regex — skip it rather than failing the scan
    }
  }

  const allPatterns: Array<SecretPattern & { custom?: boolean }> = [
    ...SECRET_PATTERNS,
    ...customPatterns,
  ];

  for (const file of files) {
    if (file.status === "removed") continue;
    if (isBinaryFile(file.path)) continue;

    // Scan only added lines, with REAL file line numbers. Never scan the patch as content —
    // that would flag context, removed lines, and diff metadata (index/@@/+++).
    const scanLines: AddedLine[] = file.addedLines
      ?? (file.patch ? parseAddedLines(file.patch) : addedLinesFromFullContent(file.content));

    for (const { lineNo, text } of scanLines) {
      const line = text;
      const lineNum = lineNo;

      // Check against all regex patterns
      for (const sp of allPatterns) {
        // Untrusted custom patterns are not run against very long lines to
        // bound worst-case (ReDoS-prone) regex execution time.
        if (sp.custom && line.length > MAX_CUSTOM_PATTERN_LINE_LENGTH) continue;
        const pattern = new RegExp(sp.pattern.source, `${sp.pattern.flags.replace("g", "")}g`);
        let match: RegExpExecArray | null = pattern.exec(line);
        while (match !== null) {
          const redactedMatch = redact(match[0]);
          match = pattern.exec(line);
          if (isSuppressed(file, lineNum, line, sp.name, redactedMatch)) continue;
          findings.push({
            file: file.path,
            line: lineNum,
            pattern: sp.name,
            match: redactedMatch,
            severity: sp.severity,
          });
        }
      }

      // Entropy-based detection — skip lines that are clearly code, not secrets
      const trimmedLine = line.trim();
      const isCodeLine =
        trimmedLine.startsWith("import ") ||
        trimmedLine.startsWith("import{") ||
        trimmedLine.startsWith("export ") ||
        trimmedLine.startsWith("from ") ||
        trimmedLine.startsWith("require(") ||
        trimmedLine.startsWith("//") ||
        trimmedLine.startsWith("/*") ||
        trimmedLine.startsWith("* ") ||
        trimmedLine.startsWith("className=") ||
        trimmedLine.startsWith("class=") ||
        /^\s*\*/.test(trimmedLine) ||
        /^[\s})\];,]*$/.test(trimmedLine);

      if (!isCodeLine) {
        const entropyThreshold = config.entropy_threshold ?? DEFAULT_ENTROPY_THRESHOLD;
        const entropySeverity = config.entropy_severity ?? DEFAULT_ENTROPY_SEVERITY;
        const tokens = extractTokens(line);
        for (const token of tokens) {
          const entropy = calculateEntropy(token);
          if (entropy > effectiveEntropyFloor(token, entropyThreshold)) {
            const alreadyFound = findings.some(
              (f) => f.file === file.path && f.line === lineNum,
            );
            if (!alreadyFound) {
              const redactedMatch = redact(token);
              if (isSuppressed(file, lineNum, line, "High Entropy String", redactedMatch)) continue;
              findings.push({
                file: file.path,
                line: lineNum,
                pattern: "High Entropy String",
                match: redactedMatch,
                severity: entropySeverity,
              });
            }
          }
        }
      }
    }
  }

  return buildResult(findings, config);
}

function buildResult(findings: Finding[], config: SecretCheckConfig): CheckResult {
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasHigh = findings.some((f) => f.severity === "high");

  const summary = findings.length === 0
    ? "No secrets detected"
    : `Found ${findings.length} potential secret(s)${hasCritical ? " including CRITICAL" : hasHigh ? " including HIGH severity" : ""}`;

  return {
    type: "secrets",
    status: statusFromFindings(findings, { severity: config.severity }),
    title: "Secret Scanner",
    summary,
    details: {
      findings,
      count: findings.length,
    },
  };
}

function addedLinesFromFullContent(content: string): AddedLine[] {
  if (!content) return [];
  return content.split("\n").map((text, i) => ({ lineNo: i + 1, text }));
}
