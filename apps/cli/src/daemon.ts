import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonInfoPath, monadStateDir } from "@aaroncx/engine";
import { DaemonInfoSchema, DaemonStatusSchema, type DaemonInfo, type DaemonStatus } from "@aaroncx/protocol";

/**
 * Daemon discovery and lifecycle for the CLI. The daemon writes
 * $MONAD_HOME/monadd.json ({ port, pid, startedAt }) on startup; the CLI
 * reads it, verifies the pid is alive and /v1/status answers, and spawns
 * monadd detached when it is not.
 */

/** Overrides the monadd executable the CLI spawns (integration tests). */
export const DAEMON_BIN_ENV = "MONAD_DAEMON_BIN";

const DEFAULT_PORT = 7331;
const START_TIMEOUT_MS = 15_000;

export interface DaemonHandle {
  url: string;
  token: string;
  info: DaemonInfo;
}

export function readDaemonInfo(): DaemonInfo | undefined {
  try {
    const raw = readFileSync(daemonInfoPath(), "utf8");
    return DaemonInfoSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function readToken(): string | undefined {
  try {
    const token = readFileSync(join(monadStateDir(), "token"), "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function fetchStatus(
  url: string,
  token: string,
  timeoutMs = 2_000,
): Promise<DaemonStatus | undefined> {
  try {
    const response = await fetch(`${url}/v1/status`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return undefined;
    }
    return DaemonStatusSchema.parse(await response.json());
  } catch {
    return undefined;
  }
}

function daemonUrl(info: DaemonInfo): string {
  return `http://127.0.0.1:${info.port}`;
}

/** A handle to the running daemon, or undefined when none is alive. */
export async function findRunningDaemon(): Promise<DaemonHandle | undefined> {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) {
    return undefined;
  }
  const token = readToken();
  if (!token) {
    return undefined;
  }
  const url = daemonUrl(info);
  const status = await fetchStatus(url, token);
  return status ? { url, token, info } : undefined;
}

/**
 * Resolves what to exec for monadd: MONAD_DAEMON_BIN, then a monadd binary
 * next to this executable (compiled dist), then the daemon's main.ts run
 * under bun (development checkout).
 */
export function resolveDaemonCommand(): string[] {
  const override = process.env[DAEMON_BIN_ENV]?.trim();
  if (override) {
    return override.split(/\s+/);
  }
  const sibling = join(dirname(process.execPath), "monadd");
  if (existsSync(sibling)) {
    return [sibling];
  }
  const devMain = join(import.meta.dir, "..", "..", "daemon", "src", "main.ts");
  if (existsSync(devMain)) {
    // In development process.execPath is bun itself.
    return [process.execPath, devMain];
  }
  throw new Error(
    "cannot find the monadd executable; place monadd next to monad or set MONAD_DAEMON_BIN",
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawns monadd detached and waits until it serves /v1/status. */
export async function startDaemon(port = DEFAULT_PORT): Promise<DaemonHandle> {
  const stateDir = monadStateDir();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A stale info file from a dead daemon confuses discovery; clear it.
  const stale = readDaemonInfo();
  if (stale && !pidAlive(stale.pid)) {
    rmSync(daemonInfoPath(), { force: true });
  }

  const command = resolveDaemonCommand();
  const logFd = openSync(join(stateDir, "monadd.log"), "a");
  // detached puts monadd (and the vendor agents it spawns) in its own
  // process group, so closing the terminal or tmux window that started it
  // cannot HUP the daemon tree. monadd ignoring SIGHUP is not enough: the
  // vendor node child dies on SIGHUP by default, which killed an in-flight
  // turn during acceptance testing.
  const [bin, ...args] = command;
  const proc = spawn(bin as string, [...args, "--port", String(port), "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  proc.unref();
  let exited: number | null = null;
  proc.on("exit", (code) => {
    exited = code ?? -1;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    const token = readToken();
    if (info && info.pid === proc.pid && token) {
      const url = daemonUrl(info);
      if (await fetchStatus(url, token)) {
        return { url, token, info };
      }
    }
    if (exited !== null) {
      throw new Error(
        `monadd exited with code ${exited} during startup; see ${join(stateDir, "monadd.log")}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`monadd did not come up within ${START_TIMEOUT_MS / 1000}s; see ${join(stateDir, "monadd.log")}`);
}

/** Returns a live daemon handle, starting monadd when necessary. */
export async function ensureDaemon(): Promise<DaemonHandle> {
  const running = await findRunningDaemon();
  if (running) {
    return running;
  }
  return await startDaemon();
}

/** SIGTERMs the daemon and waits for it to exit. Returns false if none ran. */
export async function stopDaemon(): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) {
    if (info) {
      rmSync(daemonInfoPath(), { force: true });
    }
    return false;
  }
  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(info.pid)) {
      return true;
    }
    await sleep(100);
  }
  throw new Error(`monadd (pid ${info.pid}) did not exit within 10s after SIGTERM`);
}
