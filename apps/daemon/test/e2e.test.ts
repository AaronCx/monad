import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";

/**
 * Real Claude end to end: monadd drives the actual claude-agent-acp using
 * the Claude Code login already present on this machine. Local only, gated
 * by MONAD_E2E=1, never in CI (no Claude auth there and it spends real
 * usage). Everything else in the suite runs against the fake agent.
 *
 *   MONAD_E2E=1 bun test apps/daemon/test/e2e.test.ts
 */

const E2E = process.env.MONAD_E2E === "1";

const DAEMON_MAIN = new URL("../src/main.ts", import.meta.url).pathname;

let home = "";
let cwd = "";
let port = 0;
let token = "";
let daemon: Subprocess<"ignore", "pipe", "pipe"> | undefined;

async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  if (!E2E) {
    return;
  }
  home = mkdtempSync(join(tmpdir(), "monad-e2e-home-"));
  cwd = mkdtempSync(join(tmpdir(), "monad-e2e-repo-"));
  // The real backend, not the fake: make sure no test override leaks in.
  const env: Record<string, string | undefined> = {
    ...process.env,
    MONAD_HOME: home,
    MONAD_BACKEND_CMD: undefined,
  };
  daemon = Bun.spawn([process.execPath, DAEMON_MAIN, "--port", "0", "--foreground"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(join(home, "monadd.json")), "monadd.json to appear");
  port = (JSON.parse(readFileSync(join(home, "monadd.json"), "utf8")) as { port: number }).port;
  token = readFileSync(join(home, "token"), "utf8").trim();
});

afterAll(async () => {
  if (!E2E) {
    return;
  }
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("real Claude through monadd (MONAD_E2E=1)", () => {
  test.skipIf(!E2E)(
    "session/new plus one prompt streams an answer and ends the turn",
    async () => {
      const updates: SessionNotification[] = [];
      const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const connection = client({ name: "monad-e2e" })
        .onNotification(methods.client.session.update, (ctx) => {
          updates.push(ctx.params);
        })
        .onRequest(methods.client.session.requestPermission, (ctx) => ({
          outcome: {
            outcome: "selected" as const,
            optionId: ctx.params.options[0]?.optionId ?? "",
          },
        }))
        .connect(stream);

      const init = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(init.agentCapabilities?.loadSession).toBe(true);

      // The vendor takes several seconds on session/new alone (decision
      // record 0005), so the whole turn gets a generous budget.
      const created = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      const response = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Reply with the single word: pong" }],
      });
      expect(response.stopReason).toBe("end_turn");

      await waitFor(
        () => updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
        "an agent_message_chunk from the real vendor",
      );
      const text = updates
        .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
        .map((u) =>
          u.update.sessionUpdate === "agent_message_chunk" && u.update.content.type === "text"
            ? u.update.content.text
            : "",
        )
        .join("");
      expect(text.toLowerCase()).toContain("pong");
      connection.close();
    },
    180_000,
  );
});
