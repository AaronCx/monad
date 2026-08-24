import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBearer,
  deriveMountToken,
  ensureAuthToken,
  timingSafeStringEqual,
} from "../src/auth.ts";

let dirs: string[] = [];

function tempTokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "monad-auth-"));
  dirs.push(dir);
  return join(dir, "nested", "token");
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("ensureAuthToken", () => {
  test("creates a 32-byte hex token with mode 0600 on first start", () => {
    const tokenPath = tempTokenPath();
    const token = ensureAuthToken(tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  test("returns the same token on later starts", () => {
    const tokenPath = tempTokenPath();
    const first = ensureAuthToken(tokenPath);
    const second = ensureAuthToken(tokenPath);
    expect(second).toBe(first);
  });
});

describe("checkBearer", () => {
  const token = "a".repeat(64);

  test("accepts exactly Bearer <token>", () => {
    expect(checkBearer(`Bearer ${token}`, token)).toBe(true);
  });

  test("rejects a missing header", () => {
    expect(checkBearer(undefined, token)).toBe(false);
  });

  test("rejects the wrong token", () => {
    expect(checkBearer(`Bearer ${"b".repeat(64)}`, token)).toBe(false);
    expect(checkBearer(`Bearer ${token.slice(0, 63)}`, token)).toBe(false);
    expect(checkBearer(`Bearer ${token}x`, token)).toBe(false);
  });

  test("rejects other schemes and bare tokens", () => {
    expect(checkBearer(`Basic ${token}`, token)).toBe(false);
    expect(checkBearer(token, token)).toBe(false);
    expect(checkBearer(`bearer ${token}`, token)).toBe(false);
  });
});

describe("timingSafeStringEqual", () => {
  test("compares values of any length without throwing", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });
});

describe("deriveMountToken", () => {
  const daemonToken = "a".repeat(64);
  const sessionA = "01a0349e-5ca2-7000-8c96-83988af10447";
  const sessionB = "01a0348d-42e3-7000-8337-4c5d2aa7dd9d";

  test("is deterministic, so a restarted daemon derives the same value", () => {
    expect(deriveMountToken(daemonToken, sessionA)).toBe(deriveMountToken(daemonToken, sessionA));
  });

  test("differs per session", () => {
    expect(deriveMountToken(daemonToken, sessionA)).not.toBe(
      deriveMountToken(daemonToken, sessionB),
    );
  });

  test("differs per daemon token, so rotating the token invalidates every mount", () => {
    expect(deriveMountToken(daemonToken, sessionA)).not.toBe(
      deriveMountToken("b".repeat(64), sessionA),
    );
  });

  test("is a 64 hex char digest that contains neither input", () => {
    const derived = deriveMountToken(daemonToken, sessionA);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain(daemonToken);
    expect(derived).not.toContain(sessionA);
  });

  test("checkBearer accepts the derived token and refuses the daemon token", () => {
    const derived = deriveMountToken(daemonToken, sessionA);
    expect(checkBearer(`Bearer ${derived}`, derived)).toBe(true);
    expect(checkBearer(`Bearer ${daemonToken}`, derived)).toBe(false);
    expect(checkBearer(`Bearer ${deriveMountToken(daemonToken, sessionB)}`, derived)).toBe(false);
  });
});
