import type { BackendFactory, BackendHooks } from "@aaroncx/engine";
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
}

/**
 * Absolute path of the pinned local claude-agent-acp entry (the file the
 * node_modules/.bin shim points at). Resolving the package directly keeps
 * startup fast and offline-safe; no bunx, no network.
 */
export function resolveClaudeAgentBin(): string {
  return Bun.resolveSync("@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.dir);
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
  return [node, resolveClaudeAgentBin()];
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
      if (record.agentSessionId) {
        if (backend.supportsLoadSession()) {
          try {
            await backend.loadSession(record.agentSessionId);
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
      await backend.newSession();
      return backend;
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
  };
}
