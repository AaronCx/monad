import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { BackendFactory, BackendHooks } from "@aaroncx/engine";
import { monadStateDir } from "@aaroncx/engine";
import type { SessionRecord } from "@aaroncx/protocol";
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
   *
   * The caller derives the session's mount token (decision record 0009); the
   * daemon's own token must never reach this backend, because everything it
   * returns is handed to the vendor agent.
   */
  checksMcp?: (sessionId: string) => { port: number; mountToken: string } | undefined;
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
 * Environment variable naming the minimal home an untrusted vendor session
 * runs under. Defaults to <state dir>/vendor-home.
 */
export const VENDOR_HOME_ENV = "MONAD_VENDOR_HOME";

/** The minimal home for untrusted vendor sessions. */
export function vendorHomeDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[VENDOR_HOME_ENV]?.trim();
  return override ? override : join(monadStateDir(env), "vendor-home");
}

export interface ResolvedVendorHome {
  /** The value to hand the child as HOME. */
  home: string | undefined;
  /** Which one it is, for the vendor_tools event. */
  kind: "user" | "vendor";
  /** Present only when the minimal home was wanted and not used. */
  reason?: string;
  /**
   * True when the fallback says something is wrong on this machine (a real
   * file where the credential link belongs, an unwritable state directory)
   * rather than something expected (no file-based login to link at all, which
   * is every CI runner and any Keychain-only Mac). Only a degraded fallback
   * becomes an error event; the reason is recorded either way.
   */
  degraded: boolean;
}

/**
 * Decide the child's HOME.
 *
 * A trusted session runs under the user's own home, which is the M1 contract
 * and the thing that makes the vendor find its own login (record 0005). An
 * untrusted session is triggered by a stranger's push, so it runs under a
 * minimal home holding nothing but a link to the credential file: no plugins,
 * no agents, no MCP servers with write credentials to other systems.
 *
 * The credential is LINKED, never copied. monad storing a vendor token, even
 * a copy of one, breaks the repo rule that authentication lives inside the
 * vendor, and a copy also goes stale the moment the vendor refreshes it.
 *
 * Two conditions make monad keep the user home instead, both of them
 * "authentication outranks this hardening", which is the M1 rule:
 *
 * - there is no `~/.claude/.credentials.json` to link (the login may live in
 *   the macOS Keychain, where a different HOME is unproven);
 * - something replaced the link with a real file, which means a token copy
 *   monad must neither own nor delete.
 */
export function resolveVendorHome(
  trust: SessionRecord["trust"],
  env: Record<string, string | undefined> = process.env,
): ResolvedVendorHome {
  const userHome = env.HOME;
  if (trust !== "untrusted" || !userHome) {
    return { home: userHome, kind: "user", degraded: false };
  }

  const credentials = join(userHome, ".claude", ".credentials.json");
  if (!existsSync(credentials)) {
    return {
      home: userHome,
      kind: "user",
      reason: `no ${credentials} to link, so the vendor login may not follow a different HOME; authentication outranks this isolation (decision record 0005)`,
      degraded: false,
    };
  }

  const home = vendorHomeDir(env);
  const link = join(home, ".claude", ".credentials.json");
  try {
    mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
    const existing = lstatSync(link, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      return {
        home: userHome,
        kind: "user",
        reason: `${link} is a real file rather than a link to ${credentials}; monad will not own a copy of a vendor credential and will not delete one, so the untrusted session runs under the user home until that file is removed by hand`,
        degraded: true,
      };
    }
    if (existing && readlinkSync(link) !== credentials) {
      unlinkSync(link);
    }
    if (!existsSync(link)) {
      symlinkSync(credentials, link);
    }
  } catch (error) {
    return {
      home: userHome,
      kind: "user",
      reason: `could not prepare ${home}: ${errorMessage(error)}; authentication outranks this isolation`,
      degraded: true,
    };
  }
  return { home, kind: "vendor", degraded: false };
}

/**
 * The deliberate minimal child environment proven in decision record 0005:
 * HOME (the vendor finds its own login under ~/.claude) plus a PATH that
 * contains node >= 22. monad passes no tokens, ever.
 */
function defaultChildEnv(
  options: ClaudeBackendOptions,
  home: string | undefined,
): Record<string, string | undefined> {
  const nodeDir = options.nodeDir ?? DEFAULT_NODE_DIR;
  const env: Record<string, string | undefined> = {
    HOME: home,
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
    // An untrusted session gets monad's minimal home, so the vendor is not
    // handed the plugins, agents, and MCP servers of whoever owns this
    // machine. A fallback is never silent: it becomes an error event.
    const vendorHome = resolveVendorHome(record.trust);
    if (vendorHome.degraded && vendorHome.reason) {
      hooks.onError({
        message: `untrusted session runs under the user home: ${vendorHome.reason}`,
      });
    }
    const env = options.env ?? defaultChildEnv(options, vendorHome.home);
    const backend = await AcpClientBackend.start({
      command,
      cwd: record.cwd,
      env,
      monadSessionId: record.id,
      homeKind: options.env ? "user" : vendorHome.kind,
      ...(options.env ? {} : { homeReason: vendorHome.reason }),
      hooks,
      stderr: options.stderr,
    });
    try {
      // monad-checks injection is gated on the vendor advertising HTTP MCP
      // support in its initialize response (decision record 0006 fact 7).
      let mcpServers: McpServer[] = [];
      const endpoint = options.checksMcp?.(record.id);
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
            // The mcpServers array (URL and mount token included) is part of the
            // vendor's session fingerprint (decision record 0006 fact 3), so
            // the restore MUST pass the same entry the original session/new
            // did. Sharing checksMcpServerEntry with the fresh path keeps
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
