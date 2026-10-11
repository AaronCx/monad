import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMountToken, deriveSessionsMountToken, SessionManager, SessionStore } from "@aaroncx/engine";
import type { SessionRecord } from "@aaroncx/protocol";
import {
  backendUnavailable,
  CODEX_CMD_ENV,
  createClaudeBackend,
  resolveCodexCommand,
  sessionsMcpServerEntry,
  vendorMcpServers,
} from "../src/claude.ts";

/**
 * Which monad MCP mounts a vendor session is handed (decision records 0009
 * and 0012). The monad-sessions entry is a reach into every other session's
 * history, so it is handed to trusted sessions only, and for an untrusted
 * session it is ABSENT, not present-and-refused.
 */

const daemonToken = "d".repeat(64);
const FIXTURE = new URL("./fixtures/fake-agent.ts", import.meta.url).pathname;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: Bun.randomUUIDv7(),
    cwd: "/tmp/repo",
    backend: "claude-acp",
    mode: "interactive",
    status: "idle",
    trust: "trusted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const hooks = {
  checksMcp: (id: string) => ({ port: 7331, mountToken: deriveMountToken(daemonToken, id) }),
  sessionsMcp: (r: SessionRecord) => ({ port: 7331, mountToken: deriveSessionsMountToken(daemonToken, r.id) }),
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("vendorMcpServers", () => {
  test("a trusted session gets monad-checks and monad-sessions, each with its own token", () => {
    const r = record();
    const { mcpServers } = vendorMcpServers(r, hooks, { http: true });
    expect(mcpServers.map((s) => s.name)).toEqual(["monad-checks", "monad-sessions"]);
    expect(mcpServers[1]).toEqual(
      sessionsMcpServerEntry({ port: 7331, mountToken: deriveSessionsMountToken(daemonToken, r.id), sessionId: r.id }),
    );
    expect(mcpServers[1]).toMatchObject({ url: `http://127.0.0.1:7331/mcp-sessions/${r.id}` });
    expect(JSON.stringify(mcpServers)).not.toContain(daemonToken);
  });

  test("an untrusted session has no monad-sessions entry, even if the hook would give one", () => {
    for (const mode of ["interactive", "review", "fix"] as const) {
      const { mcpServers } = vendorMcpServers(record({ trust: "untrusted", mode }), hooks, { http: true });
      expect(mcpServers.map((s) => s.name)).toEqual(["monad-checks"]);
    }
  });

  test("the hook saying no (Link off, out of scope) means no entry", () => {
    const { mcpServers } = vendorMcpServers(record(), { ...hooks, sessionsMcp: () => undefined }, { http: true });
    expect(mcpServers.map((s) => s.name)).toEqual(["monad-checks"]);
  });

  test("a vendor without HTTP MCP gets nothing, and says why", () => {
    const result = vendorMcpServers(record(), hooks, undefined);
    expect(result.mcpServers).toEqual([]);
    expect(result.skipped).toContain("mcpCapabilities.http");
  });
});

describe("codex-acp resolution", () => {
  test("MONAD_CODEX_CMD wins", () => {
    expect(resolveCodexCommand({ [CODEX_CMD_ENV]: "bun /x/fake.ts --flag" })).toEqual(["bun", "/x/fake.ts", "--flag"]);
  });

  test("then PATH, then the provisioned vendor tree", () => {
    const bin = tempDir("monad-codex-bin-");
    writeFileSync(join(bin, "codex-acp"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex-acp"), 0o755);
    expect(resolveCodexCommand({ PATH: bin, MONAD_HOME: tempDir("monad-codex-home-") }, "/nonexistent")).toEqual([
      join(bin, "codex-acp"),
    ]);

    const home = tempDir("monad-codex-home-");
    const vendorBin = join(home, "vendor", "node_modules", ".bin");
    mkdirSync(vendorBin, { recursive: true });
    writeFileSync(join(vendorBin, "codex-acp"), "#!/bin/sh\n");
    expect(resolveCodexCommand({ PATH: "/nonexistent", MONAD_HOME: home }, "/nonexistent")).toEqual([
      join(vendorBin, "codex-acp"),
    ]);
  });

  test("absent everywhere: a clear error naming what was tried and what is installed", () => {
    const env = { PATH: "/nonexistent", MONAD_HOME: tempDir("monad-codex-none-"), MONAD_BACKEND_CMD: "bun x.ts" };
    expect(() => resolveCodexCommand(env, "/nonexistent")).toThrow(
      /codex-acp is not installed: MONAD_CODEX_CMD is unset, codex-acp is not on PATH, and .* does not exist\. Installed backends: claude-acp\./,
    );
    expect(backendUnavailable("codex-acp", env, "/nonexistent")).toContain("codex-acp is not installed");
    expect(backendUnavailable("claude-acp", env, "/nonexistent")).toBeUndefined();
    expect(backendUnavailable("import:codex", env)).toContain("never run");
  });
});

describe("a codex-acp session end to end with a fake adapter", () => {
  test("the factory starts the codex command and layers its own vendor mode", async () => {
    const cwd = tempDir("monad-codex-session-");
    const previous = process.env[CODEX_CMD_ENV];
    process.env[CODEX_CMD_ENV] = `${process.execPath} ${FIXTURE}`;
    const store = new SessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store, createBackend: createClaudeBackend({ sessionsMcp: hooks.sessionsMcp, checksMcp: hooks.checksMcp }) });
    try {
      const created = manager.createRecord({ cwd, backend: "codex-acp", mode: "review", trust: "trusted" });
      await manager.activate(created.id);
      const modes = readFileSync(join(cwd, "fake-agent-modes.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(modes[0] ?? "{}").modeId).toBe("read-only");
      expect(existsSync(join(cwd, "fake-agent-mcp.jsonl"))).toBe(true);
      const recorded = JSON.parse(readFileSync(join(cwd, "fake-agent-mcp.jsonl"), "utf8").trim().split("\n")[0] ?? "{}");
      expect(recorded.mcpServers.map((s: { name: string }) => s.name)).toEqual(["monad-checks", "monad-sessions"]);
    } finally {
      await manager.shutdown();
      store.close();
      if (previous === undefined) {
        delete process.env[CODEX_CMD_ENV];
      } else {
        process.env[CODEX_CMD_ENV] = previous;
      }
    }
  }, 20_000);
});
