import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID_ENV,
  expandHome,
  hookConfigPath,
  loadHookConfig,
  PRIVATE_KEY_PATH_ENV,
  repoRootFor,
  WEBHOOK_SECRET_ENV,
} from "../src/config.ts";

const EXAMPLE = new URL("../github.example.json", import.meta.url).pathname;

const dirs: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "monad-hook-config-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, body: unknown, mode = 0o600): string {
  const path = join(dir, "github.json");
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  chmodSync(path, mode);
  return path;
}

const GOOD = {
  appId: "123456",
  privateKeyPath: "~/.monad/monad-app.private-key.pem",
  webhookSecret: "a webhook secret",
  installations: { "AaronCx/monad": { repoRoot: "~/Developer/github/monad" } },
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadHookConfig", () => {
  test("reads the file under $MONAD_HOME and expands ~ in every path", () => {
    const dir = home();
    writeConfig(dir, GOOD);
    const env = { MONAD_HOME: dir, HOME: "/home/example" };
    expect(hookConfigPath(env)).toBe(join(dir, "github.json"));
    const config = loadHookConfig({ env });
    expect(config.appId).toBe("123456");
    expect(config.privateKeyPath).toBe("/home/example/.monad/monad-app.private-key.pem");
    expect(config.webhookSecret).toBe("a webhook secret");
    expect(repoRootFor(config, "AaronCx/monad")).toBe("/home/example/Developer/github/monad");
    expect(repoRootFor(config, "AaronCx/not-installed")).toBeUndefined();
  });

  test("refuses a config file other users can read", () => {
    const dir = home();
    const path = writeConfig(dir, GOOD, 0o644);
    expect(() => loadHookConfig({ env: { MONAD_HOME: dir } })).toThrow(/mode 0644/);
    expect(() => loadHookConfig({ env: { MONAD_HOME: dir } })).toThrow(
      new RegExp(`chmod 600 ${path}`),
    );
  });

  test("refuses a private key body in the config", () => {
    const dir = home();
    writeConfig(dir, {
      ...GOOD,
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\\nnope\\n-----END RSA PRIVATE KEY-----",
    });
    expect(() => loadHookConfig({ env: { MONAD_HOME: dir } })).toThrow(
      /reads the App key from a file/,
    );
  });

  test("environment overrides win over the file", () => {
    const dir = home();
    writeConfig(dir, GOOD);
    const config = loadHookConfig({
      env: {
        MONAD_HOME: dir,
        HOME: "/home/example",
        [APP_ID_ENV]: "999",
        [PRIVATE_KEY_PATH_ENV]: "/etc/monad/app.pem",
        [WEBHOOK_SECRET_ENV]: "from the supervisor",
      },
    });
    expect(config.appId).toBe("999");
    expect(config.privateKeyPath).toBe("/etc/monad/app.pem");
    expect(config.webhookSecret).toBe("from the supervisor");
  });

  test("the environment alone is a complete configuration", () => {
    const dir = home();
    const config = loadHookConfig({
      env: {
        MONAD_HOME: dir,
        [APP_ID_ENV]: "999",
        [PRIVATE_KEY_PATH_ENV]: "/etc/monad/app.pem",
        [WEBHOOK_SECRET_ENV]: "from the supervisor",
      },
    });
    expect(config.source).toBe("the environment");
    expect(config.installations).toEqual({});
  });

  test("a partial configuration names what is missing, and no value", () => {
    const dir = home();
    writeConfig(dir, { appId: "123456", installations: {} });
    let message = "";
    try {
      loadHookConfig({ env: { MONAD_HOME: dir } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("privateKeyPath");
    expect(message).toContain(WEBHOOK_SECRET_ENV);
    expect(message).not.toContain("123456");
  });

  test("the shipped example config parses", () => {
    // github.example.json is what a human copies into place, so it has to be
    // a config monad-hook actually accepts, not prose shaped like one.
    const dir = home();
    writeConfig(dir, JSON.parse(readFileSync(EXAMPLE, "utf8")));
    const config = loadHookConfig({ env: { MONAD_HOME: dir, HOME: "/home/example" } });
    expect(config.appId).toBe("123456");
    expect(config.privateKeyPath).toBe("/home/example/.monad/monad-app.private-key.pem");
    expect(Object.keys(config.installations)).toEqual(["AaronCx/monad-review-demo"]);
  });
});

describe("expandHome", () => {
  test("expands a leading ~ and leaves everything else alone", () => {
    const env = { HOME: "/home/example" };
    expect(expandHome("~", env)).toBe("/home/example");
    expect(expandHome("~/x/y", env)).toBe("/home/example/x/y");
    expect(expandHome("/absolute", env)).toBe("/absolute");
    expect(expandHome("relative/~", env)).toBe("relative/~");
  });
});
