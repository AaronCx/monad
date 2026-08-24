import { describe, expect, test } from "bun:test";
import { deriveMountToken } from "@aaroncx/engine";
import { checksMcpServerEntry } from "../src/claude.ts";

/**
 * The mcpServers entry is the one structure monad hands to a vendor process
 * it does not control, so what it carries is a trust boundary (decision
 * record 0009). It must carry the session's mount token and nothing else
 * credential shaped.
 */
describe("checksMcpServerEntry", () => {
  const daemonToken = "d".repeat(64);
  const sessionId = "01a0349e-5ca2-7000-8c96-83988af10447";

  test("carries the session's mount token, never the daemon token", () => {
    const mountToken = deriveMountToken(daemonToken, sessionId);
    const entry = checksMcpServerEntry({ port: 7331, mountToken, sessionId });
    expect(entry).toEqual({
      type: "http",
      name: "monad-checks",
      url: `http://127.0.0.1:7331/mcp/${sessionId}`,
      headers: [{ name: "Authorization", value: `Bearer ${mountToken}` }],
    });
    expect(JSON.stringify(entry)).not.toContain(daemonToken);
  });

  test("two sessions get different credentials", () => {
    const other = "01a0348d-42e3-7000-8337-4c5d2aa7dd9d";
    const a = checksMcpServerEntry({
      port: 7331,
      mountToken: deriveMountToken(daemonToken, sessionId),
      sessionId,
    });
    const b = checksMcpServerEntry({
      port: 7331,
      mountToken: deriveMountToken(daemonToken, other),
      sessionId: other,
    });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toContain(deriveMountToken(daemonToken, other));
  });
});
