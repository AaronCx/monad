import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSpawnWorktree,
  daemonInfoPath,
  daemonPidPath,
  deriveMountToken,
  deriveSessionsMountToken,
  ensureAuthToken,
  monadStateDir,
  RepoResolver,
  SessionManager,
  SessionStore,
} from "@aaroncx/engine";
import { createAcpHttpServer } from "@aaroncx/engine/transport";
import { backendUnavailable, createClaudeBackend } from "@aaroncx/backends";
import { LinkService, loadLinkConfig } from "@aaroncx/link";
import type { DaemonInfo } from "@aaroncx/protocol";
import { createDaemonAgentFactory } from "./acp-agent.ts";
import { createControlHandler } from "./control.ts";
import { createMcpRoute, isMcpMountPath } from "./mcp.ts";
import { createSessionsMcpRoute, isSessionsMountPath } from "./mcp-sessions.ts";

const VERSION = "0.1.0";

interface Flags {
  port: number;
  db?: string;
  foreground: boolean;
}

function usage(): string {
  return [
    "monadd: the monad daemon. Serves ACP on /acp and the control API on /v1/*.",
    "",
    "Usage: monadd [--port N] [--db PATH] [--foreground]",
    "",
    "  --port N       TCP port on 127.0.0.1 (default 7331; 0 picks a free port)",
    "  --db PATH      SQLite database path (default $MONAD_HOME/monad.db)",
    "  --foreground   run in the foreground (monadd always does; the flag is",
    "                 accepted so supervisors can pass it explicitly)",
    "  --version      print the version and exit",
    "",
    "State lives under $MONAD_HOME (default ~/.monad): monad.db, token,",
    "monadd.pid, monadd.json, logs/.",
  ].join("\n");
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { port: 7331, foreground: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const value = argv[++i];
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(`monadd: invalid --port ${value ?? "(missing)"}`);
          process.exit(2);
        }
        flags.port = port;
        break;
      }
      case "--db": {
        const value = argv[++i];
        if (!value) {
          console.error("monadd: --db needs a path");
          process.exit(2);
        }
        flags.db = value;
        break;
      }
      case "--foreground":
        flags.foreground = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        console.error(`monadd: unknown flag ${arg}\n\n${usage()}`);
        process.exit(2);
    }
  }
  return flags;
}

if (process.argv.includes("--version")) {
  console.log(`monadd ${VERSION}`);
  process.exit(0);
}

const flags = parseFlags(process.argv.slice(2));

const stateDir = monadStateDir();
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const logDir = join(stateDir, "logs");
mkdirSync(logDir, { recursive: true, mode: 0o700 });

const token = ensureAuthToken(join(stateDir, "token"));
const repos = new RepoResolver();
const store = new SessionStore({ dbPath: flags.db ?? join(stateDir, "monad.db"), repoResolver: repos });
// monad Link scope and limits (decision record 0012). Read once at start; a
// malformed file is the defaults plus this warning, never a crash.
const linkConfig = loadLinkConfig();
if (linkConfig.warning) {
  console.warn(`monadd: ${linkConfig.warning} (${linkConfig.path})`);
}
// The manager and Link reference each other (the backend hook asks Link
// whether a session gets the sessions mount); Link is built right after the
// manager, and backends never start before then.
const linkRef: { service?: LinkService } = {};
// The bound port is only known after listen(); backends start later (first
// session/new at the earliest), so the checksMcp thunk is safe by then.
const bound: { port?: number } = {};
const manager = new SessionManager({
  store,
  // MONAD_BACKEND_CMD (read per backend start) overrides the vendor command
  // for tests; CLAUDE_AGENT_LOGS makes the adapter log under $MONAD_HOME.
  createBackend: createClaudeBackend({
    logDir,
    // The vendor gets a per-session mount token, never the daemon token
    // (decision record 0009). Deriving it here keeps the daemon token out of
    // the backend package entirely.
    checksMcp: (sessionId) =>
      bound.port === undefined
        ? undefined
        : { port: bound.port, mountToken: deriveMountToken(token, sessionId) },
    // The monad-sessions mount goes to a session only when Link says so:
    // trusted, Link enabled, in link.json's scope (decision record 0012).
    // Its own derived token, never the daemon token or the checks token.
    sessionsMcp: (record) =>
      bound.port === undefined || !linkRef.service?.mountAllowed(record)
        ? undefined
        : { port: bound.port, mountToken: deriveSessionsMountToken(token, record.id) },
  }),
});
const link = new LinkService({
  manager,
  store,
  config: linkConfig.config,
  repos,
  backendUnavailable: (backend) => backendUnavailable(backend),
  createWorktree: async (cwd, sessionId) => (await createSpawnWorktree({ cwd, sessionId })).path,
});
linkRef.service = link;

const startedAt = new Date();
// A client that dies without an HTTP DELETE (SIGKILL, network drop) is
// detected by the transport's SSE liveness reaper and torn down through the
// SDK's DELETE path, so held permission requests fall through to the policy
// waiting path exactly like a graceful disconnect. MONAD_SSE_GRACE_MS
// shortens the reconnect grace window in tests.
const sseGraceEnv = Number(process.env.MONAD_SSE_GRACE_MS ?? "");
// Non-ACP paths: /mcp/<sessionId> and /mcp-sessions/<sessionId> first
// (per-session MCP mounts, each authenticating itself against its own
// derived token and refusing the daemon token), then the authenticated
// /v1/* control API.
const mcpRoute = createMcpRoute({ manager, daemonToken: token });
const sessionsRoute = createSessionsMcpRoute({ manager, link, daemonToken: token });
const controlHandler = createControlHandler({ manager, link, version: VERSION, startedAt });
const server = createAcpHttpServer(createDaemonAgentFactory({ manager, version: VERSION }), {
  authToken: token,
  // The mount route does its own bearer check; the blanket daemon-token
  // check must not run in front of it (decision record 0009).
  selfAuthenticated: (pathname) => isMcpMountPath(pathname) || isSessionsMountPath(pathname),
  fallback: (req, res) => {
    if (mcpRoute(req, res) || sessionsRoute(req, res)) {
      return;
    }
    controlHandler(req, res);
  },
  ...(Number.isFinite(sseGraceEnv) && sseGraceEnv > 0 ? { sseGraceMs: sseGraceEnv } : {}),
  onConnectionDead: (connectionId) => {
    console.log(`monadd: client connection ${connectionId} vanished without DELETE; reaped`);
  },
});

// Loopback only in M1; exposing the daemon beyond 127.0.0.1 is a later,
// deliberate decision, not a flag.
const { port } = await server.listen(flags.port, "127.0.0.1");
bound.port = port;
// A previous daemon that died mid-turn (SIGKILL, crash, power loss) left
// running or waiting_for_permission on the record; nothing is in flight in
// this process, so those are stale. Put them back to idle (with an error
// event each) first, or their peer queues, sessions_wait and spawned-session
// slots stay stuck. This runs after listen so a drain it enables starts its
// backend with the mounts' port known.
const recovered = manager.recoverInterruptedTurns();
if (recovered.length > 0) {
  console.log(`monadd: ${recovered.length} session(s) were mid-turn when the last daemon stopped; set to idle`);
}
// Peer messages queued before a restart are still in the log; idle targets
// get their oldest one now, the rest at later turn boundaries.
manager.resumePeerQueues();

const infoPath = daemonInfoPath();
const pidPath = daemonPidPath();
const info: DaemonInfo = { port, pid: process.pid, startedAt: startedAt.toISOString() };
writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });

console.log(`monadd ${VERSION} listening on http://127.0.0.1:${port} (state: ${stateDir})`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`monadd: ${signal} received, shutting down`);
  try {
    // Cancel in-flight turns (this also resolves held permission requests
    // with a cancelled outcome) before closing backends.
    for (const record of manager.list()) {
      if (record.status === "running" || record.status === "waiting_for_permission") {
        await manager.cancel(record.id).catch(() => {});
      }
    }
    await manager.shutdown().catch(() => {});
    await server.close().catch(() => {});
    store.close();
  } finally {
    rmSync(infoPath, { force: true });
    rmSync(pidPath, { force: true });
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
// Survive the spawning terminal going away; the CLI starts monadd detached.
process.on("SIGHUP", () => {});
