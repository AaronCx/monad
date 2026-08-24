import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monadStateDir } from "./paths.ts";

export function defaultTokenPath(): string {
  return join(monadStateDir(), "token");
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
 * Derives the bearer token for one session's /mcp/<sessionId> mount.
 *
 * Decision record 0009: the daemon token is monad's only credential, and it
 * opens /acp, /v1/*, and every session's mount. Handing it to the vendor
 * agent inside the mcpServers headers gave anything running under that agent
 * the run of the daemon. The vendor now gets this instead: an HMAC of the
 * session id under the daemon token, accepted at that one mount and nowhere
 * else.
 *
 * Nothing is stored. The value is recomputable from the daemon token plus
 * the session id, so it survives a daemon restart for free and stays stable
 * for the session's lifetime, which the vendor's session fingerprint
 * requires (decision record 0006 fact 3).
 */
export function deriveMountToken(daemonToken: string, sessionId: string): string {
  return createHmac("sha256", daemonToken).update(`mcp-mount:${sessionId}`).digest("hex");
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
