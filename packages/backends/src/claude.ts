import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { BackendFactory, BackendHooks } from "@aaroncx/engine";
import { monadStateDir } from "@aaroncx/engine";
import { AcpClientBackend } from "./acp-client.ts";

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
   */
  checksMcp?: () => { port: number; token: string } | undefined;
}

/**
 * The one place the monad-checks mcpServers entry is constructed, shared by
 * the fresh-session and restore paths so both hand the vendor the identical
 * array. `headers` is required by the ACP schema (McpServerHttp).
 */
export function checksMcpServerEntry(input: {
  port: number;
  token: string;
  sessionId: string;
}): McpServer {
  return {
    type: "http",
    name: "monad-checks",
    url: `http://127.0.0.1:${input.port}/mcp/${input.sessionId}`,
    headers: [{ name: "Authorization", value: `Bearer ${input.token}` }],
  };
}

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
 * and either creates a fresh vendor session (session/new with
 * { cwd, mcpServers: [] }) or, when the record carries an agentSessionId
 * from before a daemon restart, restores it via vendor session/load.
 *
 * A failed or unsupported restore is never silent: an error event is
 * appended through hooks.onError saying context was not restored, then a
 * fresh vendor session is started so the user can keep working.
 */
export function createClaudeBackend(options: ClaudeBackendOptions = {}): BackendFactory {
  return async (record, hooks: BackendHooks) => {
    const command =
      options.command ?? resolveBackendCommand(process.env, options.nodeDir ?? DEFAULT_NODE_DIR);
    const backend = await AcpClientBackend.start({
      command,
      cwd: record.cwd,
      env: options.env ?? defaultChildEnv(options),
      monadSessionId: record.id,
      hooks,
      stderr: options.stderr,
    });
    try {
      // monad-checks injection is gated on the vendor advertising HTTP MCP
      // support in its initialize response (decision record 0006 fact 7).
      let mcpServers: McpServer[] = [];
      const endpoint = options.checksMcp?.();
      if (endpoint) {
        const mcpCapabilities = backend.initializeResponse.agentCapabilities?.mcpCapabilities;
        if (mcpCapabilities?.http === true) {
          mcpServers = [checksMcpServerEntry({ ...endpoint, sessionId: record.id })];
        } else {
          console.log(
            `monadd: vendor did not advertise mcpCapabilities.http; monad-checks tools are not injected for session ${record.id}`,
          );
        }
      }
      // Review sessions layer vendor plan mode over monad's policy; fix and
      // interactive run the vendor default. Applied right after session/new
      // or session/load per decision 0007.
      const applyVendorMode = async () => {
        if (record.mode !== "interactive") {
          await backend.setSessionMode(record.mode);
        }
      };
      if (record.agentSessionId) {
        if (backend.supportsLoadSession()) {
          try {
            // The mcpServers array (URL and token included) is part of the
            // vendor's session fingerprint (decision record 0006 fact 3), so
            // the restore MUST pass the same entry the original session/new
            // did. Sharing checksMcpServerEntry with the fresh path keeps
            // them identical while the daemon's port and token are stable.
            // Honest limitation: if the daemon restarts on a DIFFERENT port
            // (or with a rotated token), the entry's URL changes, the
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
