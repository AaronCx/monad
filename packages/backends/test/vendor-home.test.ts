import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVendorHome, VENDOR_HOME_ENV, vendorHomeDir } from "../src/index.ts";

/**
 * Pre-flight B, decision records 0005 and 0006 fact 8: the vendor session
 * inherits the user's global Claude configuration through HOME. Under M3 that
 * session is triggered by a stranger, so an untrusted one runs under a minimal
 * home holding a link to the credential file and nothing else.
 */

const created: string[] = [];

function scratch(): { home: string; vendorHome: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "vendor-home-"));
  created.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const vendorHome = join(root, "vendor-home");
  return { home, vendorHome, env: { HOME: home, [VENDOR_HOME_ENV]: vendorHome } };
}

function withLogin(home: string): string {
  const credentials = join(home, ".claude", ".credentials.json");
  writeFileSync(credentials, '{"pretend":"credential"}');
  return credentials;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveVendorHome", () => {
  test("a trusted session keeps the user home, which is the M1 contract", () => {
    const { home, env } = scratch();
    withLogin(home);
    const resolved = resolveVendorHome("trusted", env);
    expect(resolved).toEqual({ home, kind: "user", degraded: false });
  });

  test("an untrusted session gets the minimal home with the credential linked, not copied", () => {
    const { home, vendorHome, env } = scratch();
    const credentials = withLogin(home);

    const resolved = resolveVendorHome("untrusted", env);
    expect(resolved.kind).toBe("vendor");
    expect(resolved.home).toBe(vendorHome);
    expect(resolved.degraded).toBe(false);

    const link = join(vendorHome, ".claude", ".credentials.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(credentials);
  });

  test("the minimal home holds nothing but the credential link", () => {
    const { home, vendorHome, env } = scratch();
    withLogin(home);
    writeFileSync(join(home, ".claude", "settings.json"), '{"mcpServers":{"secret":{}}}');
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });

    resolveVendorHome("untrusted", env);

    expect(readdirSync(vendorHome)).toEqual([".claude"]);
    expect(readdirSync(join(vendorHome, ".claude"))).toEqual([".credentials.json"]);
  });

  test("a stale link is repointed at the real credential file", () => {
    const { home, vendorHome, env } = scratch();
    const credentials = withLogin(home);
    const link = join(vendorHome, ".claude", ".credentials.json");
    mkdirSync(join(vendorHome, ".claude"), { recursive: true });
    symlinkSync(join(home, "somewhere-else.json"), link);

    const resolved = resolveVendorHome("untrusted", env);
    expect(resolved.kind).toBe("vendor");
    expect(readlinkSync(link)).toBe(credentials);
  });

  test("no file-based login means the user home, and that is expected, not degraded", () => {
    const { home, env } = scratch();
    const resolved = resolveVendorHome("untrusted", env);
    expect(resolved.kind).toBe("user");
    expect(resolved.home).toBe(home);
    expect(resolved.degraded).toBe(false);
    expect(String(resolved.reason)).toContain(".credentials.json");
  });

  test("a real file where the link belongs is a degraded fallback, and monad never deletes it", () => {
    const { home, vendorHome, env } = scratch();
    withLogin(home);
    const link = join(vendorHome, ".claude", ".credentials.json");
    mkdirSync(join(vendorHome, ".claude"), { recursive: true });
    writeFileSync(link, '{"a":"copy monad must not own"}');

    const resolved = resolveVendorHome("untrusted", env);
    expect(resolved.kind).toBe("user");
    expect(resolved.home).toBe(home);
    expect(resolved.degraded).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });

  test("the directory defaults under the state dir and MONAD_VENDOR_HOME overrides it", () => {
    expect(vendorHomeDir({ MONAD_HOME: "/tmp/state-dir" })).toBe("/tmp/state-dir/vendor-home");
    expect(vendorHomeDir({ [VENDOR_HOME_ENV]: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });
});
