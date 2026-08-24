import { defaultDbPath } from "@aaroncx/engine";
import { createGitHubApp, readPrivateKey } from "@aaroncx/github";
import SmeeClient from "smee-client";
import { loadHookConfig, repoRootFor } from "./config.ts";
import { liveDaemonAccess } from "./daemon.ts";
import { consoleLogger } from "./log.ts";
import { DeliveryQueue } from "./queue.ts";
import { createHookHandler } from "./server.ts";
import { DEFAULT_MAX_CONCURRENT, HookWorker } from "./worker.ts";

/**
 * monad-hook: the webhook receiver, beside monadd rather than inside it.
 *
 * Separate on purpose. It is long running and network facing, monadd is
 * neither, and a crash here must not take live sessions down with it. The
 * two share exactly one thing, ~/.monad/monad.db, and even there they own
 * different tables.
 *
 * Loopback only. Whatever exposes this to GitHub (a smee channel, a
 * Cloudflare tunnel, a Tailscale funnel) terminates TLS somewhere else and
 * connects to 127.0.0.1, and the signature check is the only thing standing
 * between the internet and a review run.
 */

const VERSION = "0.1.0";
const DEFAULT_PORT = 7332;

interface Flags {
  port: number;
  smee?: string;
  maxConcurrent: number;
  config?: string;
}

function usage(): string {
  return [
    "monad-hook: the GitHub App receiver. Verifies deliveries, queues them,",
    "and drives monadd.",
    "",
    "Usage: monad-hook [--port N] [--smee URL] [--max-concurrent N] [--config PATH]",
    "",
    `  --port N            TCP port on 127.0.0.1 (default ${DEFAULT_PORT})`,
    "  --smee URL          forward a smee.io channel to this port (local delivery)",
    `  --max-concurrent N  reviews running at once (default ${DEFAULT_MAX_CONCURRENT})`,
    "  --config PATH       App config file (default $MONAD_HOME/github.json)",
    "  --version           print the version and exit",
    "",
    "Routes: POST /webhook and GET /healthz. Configuration, the App's",
    "permission set, and how to expose this are in docs/github-app.md.",
  ].join("\n");
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { port: DEFAULT_PORT, maxConcurrent: DEFAULT_MAX_CONCURRENT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const value = argv[++i];
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(`monad-hook: invalid --port ${value ?? "(missing)"}`);
          process.exit(2);
        }
        flags.port = port;
        break;
      }
      case "--smee": {
        const value = argv[++i];
        if (!value) {
          console.error("monad-hook: --smee needs a channel url");
          process.exit(2);
        }
        flags.smee = value;
        break;
      }
      case "--max-concurrent": {
        const value = argv[++i];
        const max = Number(value);
        if (!Number.isInteger(max) || max < 1) {
          console.error(`monad-hook: invalid --max-concurrent ${value ?? "(missing)"}`);
          process.exit(2);
        }
        flags.maxConcurrent = max;
        break;
      }
      case "--config": {
        const value = argv[++i];
        if (!value) {
          console.error("monad-hook: --config needs a path");
          process.exit(2);
        }
        flags.config = value;
        break;
      }
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        console.error(`monad-hook: unknown flag ${arg}\n\n${usage()}`);
        process.exit(2);
    }
  }
  return flags;
}

if (process.argv.includes("--version")) {
  console.log(`monad-hook ${VERSION}`);
  process.exit(0);
}

const flags = parseFlags(process.argv.slice(2));
const log = consoleLogger();

const config = (() => {
  try {
    return loadHookConfig({ path: flags.config });
  } catch (error) {
    // The message names the file and what is missing from it, never a value.
    console.error(`monad-hook: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
})();

const privateKey = await (async () => {
  try {
    return await readPrivateKey(config.privateKeyPath);
  } catch {
    console.error(
      [
        `monad-hook: cannot read the App private key at ${config.privateKeyPath}.`,
        "Download it from the App's settings page and point privateKeyPath at it.",
      ].join(" "),
    );
    process.exit(2);
  }
})();

const app = createGitHubApp({ appId: config.appId, privateKey });
const dbPath = defaultDbPath();
const queue = new DeliveryQueue({ dbPath });
const worker = new HookWorker({
  queue,
  daemon: liveDaemonAccess(),
  octokitFor: (installationId) => app.getInstallationOctokit(installationId),
  repoRootFor: (fullName) => repoRootFor(config, fullName),
  dbPath,
  log,
  maxConcurrent: flags.maxConcurrent,
});

const server = Bun.serve({
  port: flags.port,
  hostname: "127.0.0.1",
  fetch: createHookHandler({
    webhookSecret: config.webhookSecret,
    queue,
    worker,
    log,
    version: VERSION,
  }),
});

worker.start();

const repos = Object.keys(config.installations);
log.info(
  `${VERSION} listening on http://127.0.0.1:${server.port} (app ${config.appId}, ` +
    `${repos.length} repository binding(s), config ${config.source})`,
);
for (const repo of repos) {
  log.info(`bound ${repo} to ${config.installations[repo]?.repoRoot}`);
}

let smee: SmeeClient | undefined;
if (flags.smee !== undefined) {
  smee = new SmeeClient({
    source: flags.smee,
    target: `http://127.0.0.1:${server.port}/webhook`,
    logger: { info: (...args) => log.info(String(args[0])), error: (...args) => log.error(String(args[0])) },
  });
  await smee.start();
  log.info(`forwarding ${flags.smee} to /webhook`);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  await smee?.stop().catch(() => {});
  await server.stop();
  // Deliveries still running stay marked running; the next start finds them
  // and queues them again, which is what recoverRunning is for.
  await worker.stop();
  queue.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
// Survive the terminal that started it going away.
process.on("SIGHUP", () => {});
