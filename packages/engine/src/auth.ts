import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultTokenPath(): string {
  return join(homedir(), ".monad", "token");
}

/**
 * Reads the daemon's bearer token, creating it on first start: 32 random
 * bytes, hex encoded, written 0600. The CLI reads the same file, which is
 * the whole trust model in M1 (loopback only, same user).
 */
export function ensureAuthToken(tokenPath = defaultTokenPath()): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on creation; enforce it regardless.
  chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * Constant-time string comparison. Both sides are hashed first so inputs of
 * different lengths take the same time as equal-length ones.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Validates an Authorization header value against the daemon token.
 * Accepts exactly "Bearer <token>".
 */
export function checkBearer(authorization: string | undefined, token: string): boolean {
  if (typeof authorization !== "string") {
    return false;
  }
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) {
    return false;
  }
  return timingSafeStringEqual(authorization.slice(prefix.length), token);
}
