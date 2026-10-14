import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { BackendFactory, BackendHooks } from "@aaroncx/engine";
import { monadStateDir } from "@aaroncx/engine";
import {
  type BackendId,
  SESSIONS_MCP_SERVER_NAME,
  type SessionMode,
  type SessionRecord,
} from "@aaroncx/protocol";
import { AcpClientBackend, CODEX_VENDOR_MODE_FOR, VENDOR_MODE_FOR } from "./acp-client.ts";

/**
 * claude-agent-acp backend wiring: command-line resolution, fresh-session
 * creation, and the restore-on-restart path (vendor session/load with the
 * stored agentSessionId). Spike facts this honors live in decision record
 * 0005: the vendor bin is dist/index.js with a `#!/usr/bin/env node` shebang
 * and engines node >= 22, so the child needs a modern node; on this Mac that
 * lives in /opt/homebrew/bin, which a launchd default PATH does not include.
 */

/** Directory holding a node >= 22 binary on the Mac Mini (see record 0005). */
export const DEFAULT_NODE_DIR = "/opt/homebrew/bin";

/**
 * Environment variable that overrides the whole backend command line, split
 * on whitespace. The daemon and its tests use it to swap in a fake agent
 * ("bun /path/to/fake-agent.ts"); paths with spaces need the programmatic
 * `command` option instead.
 */
export const BACKEND_CMD_ENV = "MONAD_BACKEND_CMD";

/**
 * Environment variable naming the codex-acp command line (split on
 * whitespace), for Link's cross-vendor spawn. Checked before PATH and the
 * provisioned vendor tree.
 */
export const CODEX_CMD_ENV = "MONAD_CODEX_CMD";

export interface ClaudeBackendOptions {
  /** Full argv override. Wins over MONAD_BACKEND_CMD and bin resolution. */
  command?: string[];
  /** Child environment override. Default: minimal HOME + PATH (plus logDir). */
  env?: Record<string, string | undefined>;
  /** Directory prepended to PATH searches for node >= 22. */
  nodeDir?: string;
  /** Sets CLAUDE_AGENT_LOGS so the adapter appends to <logDir>/agent.log. */
  logDir?: string;
  /** Where child stderr goes; default inherit (adapter logs there). */
  stderr?: "inherit" | "ignore";
  /**
   * Late-bound daemon HTTP endpoint for the per-session monad-checks MCP
   * mount. Returns undefined until the daemon's listener is bound (backends
   * only start after that, but the factory is constructed earlier).
   *
   * The caller derives the session's mount token (decision record 0009); the
   * daemon's own token must never reach this backend, because everything it
   * returns is handed to the vendor agent.
   */
  checksMcp?: (sessionId: string) => { port: number; mountToken: string } | undefined;
  /**
   * Late-bound endpoint for the session's monad-sessions mount (monad Link,
   * decision record 0012), or undefined when this session must not get one.
   * The caller decides with the whole record in hand (trust level, link.json
   * scope) and derives the sessions-mount token; this package never sees
   * the daemon token. The backend independently refuses to inject it for
   * anything but a trusted record, so a caller bug cannot hand an untrusted
   * session the mount.
   */
  sessionsMcp?: (record: SessionRecord) => { port: number; mountToken: string } | undefined;
}

/**
 * The one place the monad-checks mcpServers entry is constructed, shared by
 * the fresh-session and restore paths so both hand the vendor the identical
 * array. `headers` is required by the ACP schema (McpServerHttp).
 */
export function checksMcpServerEntry(input: {
  port: number;
  /**
   * The session's mount token, NOT the daemon token. It opens
   * /mcp/<sessionId> and nothing else, which is the whole point: this value
   * is handed to a vendor process monad does not control.
   */
  mountToken: string;
  sessionId: string;
}): McpServer {
  return {
    type: "http",
    name: "monad-checks",
    url: `http://127.0.0.1:${input.port}/mcp/${input.sessionId}`,
    headers: [{ name: "Authorization", value: `Bearer ${input.mountToken}` }],
  };
}

/**
 * The monad-sessions mcpServers entry (monad Link). Same shape as the checks
 * entry; its own path and its own credential, the session's sessions-mount
 * token, which opens /mcp-sessions/<sessionId> and nothing else.
 */
export function sessionsMcpServerEntry(input: {
  port: number;
  mountToken: string;
  sessionId: string;
}): McpServer {
  return {
    type: "http",
    name: SESSIONS_MCP_SERVER_NAME,
    url: `http://127.0.0.1:${input.port}/mcp-sessions/${input.sessionId}`,
    headers: [{ name: "Authorization", value: `Bearer ${input.mountToken}` }],
  };
}

/**
 * The one builder of the mcpServers array a vendor session is handed, shared
 * by the fresh-session and restore paths so both pass the identical array
 * (it is part of the vendor's session fingerprint, record 0006 fact 3).
 *
 * monad-checks: every session, when the vendor speaks HTTP MCP.
 * monad-sessions: only a TRUSTED session, and only when the caller's
 * sessionsMcp hook says so (Link enabled, in scope). For an untrusted
 * session the entry is absent, not present-and-refused: a tool the vendor
 * was never told about cannot be talked into a call (decision record 0012).
 */
export function vendorMcpServers(
  record: SessionRecord,
  options: Pick<ClaudeBackendOptions, "checksMcp" | "sessionsMcp">,
  mcpCapabilities: { http?: boolean } | undefined,
): { mcpServers: McpServer[]; skipped?: string } {
  const checks = options.checksMcp?.(record.id);
  const sessions = record.trust === "trusted" ? options.sessionsMcp?.(record) : undefined;
  if (!checks && !sessions) {
    return { mcpServers: [] };
  }
  if (mcpCapabilities?.http !== true) {
    return {
      mcpServers: [],
      skipped: `vendor did not advertise mcpCapabilities.http; monad MCP tools are not injected for session ${record.id}`,
    };
  }
  const mcpServers: McpServer[] = [];
  if (checks) {
    mcpServers.push(checksMcpServerEntry({ ...checks, sessionId: record.id }));
  }
  if (sessions) {
    mcpServers.push(sessionsMcpServerEntry({ ...sessions, sessionId: record.id }));
  }
  return { mcpServers };
}

/**
 * Resolves the codex-acp command line, for Link's cross-vendor spawn:
 * MONAD_CODEX_CMD, then `codex-acp` on PATH (the daemon's, plus the node
 * directory), then the provisioned vendor tree's
 * node_modules/.bin/codex-acp. Throws a message naming everything it tried
 * and what IS installed, so a spawn refusal says how to fix it.
 */
export function resolveCodexCommand(
  env: Record<string, string | undefined> = process.env,
  nodeDir: string = DEFAULT_NODE_DIR,
): string[] {
  const override = env[CODEX_CMD_ENV]?.trim();
  if (override) {
    return override.split(/\s+/);
  }
  const path = `${nodeDir}:${env.PATH ?? "/usr/bin:/bin"}`;
  const onPath = Bun.which("codex-acp", { PATH: path });
  if (onPath) {
    return [onPath];
  }
  const vendorBin = join(monadStateDir(env), "vendor", "node_modules", ".bin", "codex-acp");
  if (existsSync(vendorBin)) {
    return [vendorBin];
  }
  let claude = "claude-acp";
  try {
    resolveBackendCommand(env, nodeDir);
  } catch {
    claude = "none";
  }
  throw new Error(
    `codex-acp is not installed: ${CODEX_CMD_ENV} is unset, codex-acp is not on PATH, and ${vendorBin} does not exist. ` +
      `Installed backends: ${claude}. Provision it with: cd ${join(monadStateDir(env), "vendor")} && bun add @zed-industries/codex-acp ` +
      `(or set ${CODEX_CMD_ENV} to a full command line)`,
  );
}

/**
 * Why a backend cannot start on this daemon, or undefined when it can. Link
 * asks this before a spawn creates a record, so a missing adapter is a clear
 * refusal rather than a session that dies at its first turn.
 */
export function backendUnavailable(
  backend: BackendId,
  env: Record<string, string | undefined> = process.env,
  nodeDir: string = DEFAULT_NODE_DIR,
): string | undefined {
  try {
    if (backend === "claude-acp") {
      resolveBackendCommand(env, nodeDir);
      return undefined;
    }
    if (backend === "codex-acp") {
      resolveCodexCommand(env, nodeDir);
      return undefined;
    }
    return `${backend} sessions are imported logs and never run`;
  } catch (error) {
    return errorMessage(error);
  }
}

/** The command line for a record's backend. */
function commandFor(record: SessionRecord, options: ClaudeBackendOptions): string[] {
  if (options.command) {
    return options.command;
  }
  const nodeDir = options.nodeDir ?? DEFAULT_NODE_DIR;
  switch (record.backend) {
    case "claude-acp":
      return resolveBackendCommand(process.env, nodeDir);
    case "codex-acp":
      return resolveCodexCommand(process.env, nodeDir);
    default:
      throw new Error(`session ${record.id} is an imported ${record.backend} log and cannot run`);
  }
}

const VENDOR_MODES: Record<"claude-acp" | "codex-acp", Record<SessionMode, string>> = {
  "claude-acp": VENDOR_MODE_FOR,
  "codex-acp": CODEX_VENDOR_MODE_FOR,
};

/**
 * Absolute path of the pinned local claude-agent-acp entry (the file the
 * node_modules/.bin shim points at). Resolving the package directly keeps
 * startup fast and offline-safe; no bunx, no network. Resolution order:
 * a checkout (import.meta.dir works there), the process working directory,
 * then the provisioned vendor tree under the monad state dir. A compiled
 * monadd running in an arbitrary repo hits the last one; provision it once
 * with: mkdir -p ~/.monad/vendor && cd ~/.monad/vendor &&
 * bun add @agentclientprotocol/claude-agent-acp@0.70.0
 */
export function resolveClaudeAgentBin(
  env: Record<string, string | undefined> = process.env,
): string {
  const entry = "@agentclientprotocol/claude-agent-acp/dist/index.js";
  try {
    return Bun.resolveSync(entry, import.meta.dir);
  } catch {
    // fall through to the next root
  }
  try {
    return Bun.resolveSync(entry, process.cwd());
  } catch {
    // fall through to the provisioned vendor tree
  }
  const vendorRoot = join(monadStateDir(env), "vendor");
  try {
    return Bun.resolveSync(entry, vendorRoot);
  } catch {
    throw new Error(
      `claude-agent-acp is not installed anywhere monadd can see. Provision it once with: mkdir -p ${vendorRoot} && cd ${vendorRoot} && bun add @agentclientprotocol/claude-agent-acp@0.70.0 (or set ${BACKEND_CMD_ENV} to a full backend command line)`,
    );
  }
}

/**
 * Resolves the backend argv: MONAD_BACKEND_CMD if set, otherwise an
 * absolutely resolved node >= 22 running the pinned local adapter entry.
 * Running `<abs node> <abs entry>` sidesteps the shebang's env lookup, so a
 * launchd-started daemon works even with a bare PATH.
 */
export function resolveBackendCommand(
  env: Record<string, string | undefined> = process.env,
  nodeDir: string = DEFAULT_NODE_DIR,
): string[] {
  const override = env[BACKEND_CMD_ENV]?.trim();
  if (override) {
    return override.split(/\s+/);
  }
  const node = Bun.which("node", { PATH: `${nodeDir}:${env.PATH ?? "/usr/bin:/bin"}` });
  if (!node) {
    throw new Error(
      `claude-agent-acp needs node >= 22 and none was found in ${nodeDir} or on PATH; ` +
        `install node or set ${BACKEND_CMD_ENV}`,
    );
  }
  return [node, resolveClaudeAgentBin(env)];
}

/**
 * The deliberate minimal child environment proven in decision record 0005:
 * HOME (the vendor finds its own login under ~/.claude) plus a PATH that
 * contains node >= 22. monad passes no tokens, ever.
 */
function defaultChildEnv(options: ClaudeBackendOptions): Record<string, string | undefined> {
  const nodeDir = options.nodeDir ?? DEFAULT_NODE_DIR;
  const env: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    PATH: `${nodeDir}:/usr/bin:/bin`,
  };
  if (options.logDir) {
    env.CLAUDE_AGENT_LOGS = options.logDir;
  }
  return env;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * BackendFactory for SessionManager. Per session it spawns the vendor agent
 * the record names (claude-agent-acp, or codex-acp for a Link spawn that
 * asked for it) and either creates a fresh vendor session (session/new with
 * the shared mcpServers array) or, when the record carries an agentSessionId
 * from before a daemon restart, restores it via vendor session/load.
 *
 * A failed or unsupported restore is never silent: an error event is
 * appended through hooks.onError saying context was not restored, then a
 * fresh vendor session is started so the user can keep working.
 */
export function createClaudeBackend(options: ClaudeBackendOptions = {}): BackendFactory {
  return async (record, hooks: BackendHooks) => {
    const command = commandFor(record, options);
    const codex = record.backend === "codex-acp";
    const backend = await AcpClientBackend.start({
      command,
      cwd: record.cwd,
      env: options.env ?? defaultChildEnv(options),
      monadSessionId: record.id,
      hooks,
      stderr: options.stderr,
      vendorModes: VENDOR_MODES[codex ? "codex-acp" : "claude-acp"],
    });
    try {
      // Injection is gated on the vendor advertising HTTP MCP support in its
      // initialize response (decision record 0006 fact 7), and the sessions
      // mount on the record's trust level (decision record 0012).
      const { mcpServers, skipped } = vendorMcpServers(
        record,
        options,
        backend.initializeResponse.agentCapabilities?.mcpCapabilities,
      );
      if (skipped) {
        console.log(`monadd: ${skipped}`);
      }
      // Review sessions layer vendor plan mode over monad's policy; fix and
      // interactive run the vendor default. Applied right after session/new
      // or session/load per decision 0007. codex-acp's mode ids are not
      // measured on this machine, so a refusal there is logged, not fatal.
      const applyVendorMode = async () => {
        if (record.mode === "interactive") {
          return;
        }
        if (!codex) {
          await backend.setSessionMode(record.mode);
          return;
        }
        try {
          await backend.setSessionMode(record.mode);
        } catch (error) {
          hooks.onError({
            message: `codex-acp did not accept its ${record.mode} vendor mode; monad's ${record.mode} policy still applies: ${errorMessage(error)}`,
          });
        }
      };
      if (record.agentSessionId) {
        if (backend.supportsLoadSession()) {
          try {
            // The mcpServers array (URL and mount token included) is part of the
            // vendor's session fingerprint (decision record 0006 fact 3), so
            // the restore MUST pass the same entry the original session/new
            // did. Sharing vendorMcpServers with the fresh path keeps
            // them identical while the daemon's port and token are stable.
            // Honest limitation: if the daemon restarts on a DIFFERENT port
            // (or with a rotated daemon token, which changes every derived
            // mount token), the entry changes, the
            // fingerprint no longer matches, and the vendor recreates its
            // Claude Code subprocess instead of resuming it, so restored
            // context may be rebuilt rather than resumed. The default fixed
            // port 7331 makes this the exception, not the rule.
            await backend.loadSession(record.agentSessionId, mcpServers);
            await applyVendorMode();
            return backend;
          } catch (error) {
            hooks.onError({
              message: `vendor session/load failed; previous context was NOT restored, starting a fresh session: ${errorMessage(error)}`,
              agentSessionId: record.agentSessionId,
            });
          }
        } else {
          hooks.onError({
            message:
              "vendor agent does not support session/load; previous context was NOT " +
              "restored, starting a fresh session",
            agentSessionId: record.agentSessionId,
          });
        }
      }
      await backend.newSession(mcpServers);
      await applyVendorMode();
      return backend;
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
  };
}
