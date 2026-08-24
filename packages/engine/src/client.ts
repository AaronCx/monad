import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ClientConnection,
  client,
  type InitializeResponse,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  CancelSessionResponseSchema,
  DaemonInfoSchema,
  DaemonStatusSchema,
  ERROR_NOTIFICATION_METHOD,
  ListSessionsResponseSchema,
  type DaemonInfo,
  type DaemonStatus,
  type EventRecord,
  type MonadErrorNotification,
  MonadErrorNotificationSchema,
  ReviewStreamLineSchema,
  type ReviewStreamLine,
  type SessionMode,
  type SessionRecord,
  SetModeResponseSchema,
} from "@aaroncx/protocol";
import { daemonInfoPath, monadStateDir } from "./paths.ts";
import { createHttpStream } from "./transport/index.ts";

/**
 * The client half of monad: how a process that is not the daemon finds the
 * daemon, starts it, and talks to it.
 *
 * This was apps/cli/src/daemon.ts plus the two client pieces that sat beside
 * it (the review stream and the ACP connection). It moved down here in M3
 * because apps/hook drives exactly the same daemon over exactly the same
 * authenticated HTTP, and a second client would be a second set of answers
 * to "is monadd running", "how do I start it", and "what does a review
 * stream look like". There is one client; the CLI and the App differ only in
 * what they do with it.
 *
 * Loopback and the bearer token from $MONAD_HOME/token are the whole auth
 * story (M1). Nothing here logs the token.
 */

/** Overrides the monadd executable a client spawns (integration tests). */
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

/** GET /v1/sessions: every session the daemon knows, across repos. */
export async function fetchSessions(handle: DaemonHandle): Promise<SessionRecord[]> {
  const response = await fetch(`${handle.url}/v1/sessions`, {
    headers: authHeaders(handle.token),
  });
  if (!response.ok) {
    throw new Error(`GET /v1/sessions failed with ${response.status}`);
  }
  return ListSessionsResponseSchema.parse(await response.json()).sessions;
}

/**
 * POST /v1/sessions/<id>/mode: switches the stored mode, swaps the policy,
 * and re-layers the vendor mode on a live backend. The mode-switch user
 * prompt is the caller's job (it goes over ACP, so it lands as a prompt
 * event on the session's log).
 */
export async function setSessionMode(
  handle: DaemonHandle,
  sessionId: string,
  mode: SessionMode,
): Promise<SessionRecord> {
  const response = await fetch(`${handle.url}/v1/sessions/${sessionId}/mode`, {
    method: "POST",
    headers: { ...authHeaders(handle.token), "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/sessions/${sessionId}/mode failed with ${response.status}`);
  }
  return SetModeResponseSchema.parse(await response.json()).session;
}

/**
 * POST /v1/sessions/<id>/cancel: cancels the in-flight turn (and resolves
 * any held permission request as cancelled), leaving the session idle and
 * open. This is what the App calls when a new head supersedes a review that
 * is still running.
 */
export async function cancelSession(
  handle: DaemonHandle,
  sessionId: string,
): Promise<SessionRecord> {
  const response = await fetch(`${handle.url}/v1/sessions/${sessionId}/cancel`, {
    method: "POST",
    headers: authHeaders(handle.token),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/sessions/${sessionId}/cancel failed with ${response.status}`);
  }
  return CancelSessionResponseSchema.parse(await response.json()).session;
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
 * next to this executable (compiled dist, which is how monad and monad-hook
 * are installed), then the daemon's main.ts run under bun (development
 * checkout, resolved relative to this package rather than to the caller).
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
  const devMain = join(import.meta.dir, "..", "..", "..", "apps", "daemon", "src", "main.ts");
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
  throw new Error(
    `monadd did not come up within ${START_TIMEOUT_MS / 1000}s; see ${join(stateDir, "monadd.log")}`,
  );
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

/** The one result line of a review stream. */
export type ReviewResultLine = Extract<ReviewStreamLine, { type: "result" }>;

/**
 * Streams POST /v1/review, handing every event to onEvent as it arrives and
 * returning the single result line. An error line becomes a thrown error.
 *
 * The response is held open for the whole review (a minute or more), which
 * is why the App answers GitHub with 202 first and runs this afterwards.
 */
export async function streamReview(
  handle: DaemonHandle,
  body: unknown,
  onEvent: (event: EventRecord) => void,
): Promise<ReviewResultLine> {
  const response = await fetch(`${handle.url}/v1/review`, {
    method: "POST",
    headers: { ...authHeaders(handle.token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    throw new Error(`POST /v1/review failed with ${response.status}`);
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let result: ReviewResultLine | undefined;
  const consume = (line: string): void => {
    if (line.trim().length === 0) {
      return;
    }
    const parsed = ReviewStreamLineSchema.parse(JSON.parse(line));
    if (parsed.type === "event") {
      onEvent(parsed.event);
    } else if (parsed.type === "result") {
      result = parsed;
    } else {
      throw new Error(parsed.message);
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffered);
  if (result === undefined) {
    throw new Error("the daemon closed the review stream without a result");
  }
  return result;
}

/** The one user prompt a switch into fix mode sends (ACP has no system channel). */
export const FIX_MODE_PROMPT =
  "Mode switched to fix. You may now edit files inside this worktree to address the " +
  "review findings. Commit when done; do not push.";

export interface AcpSession {
  connection: ClientConnection;
  init: InitializeResponse;
}

/**
 * What a client does with the traffic the daemon sends it. requestPermission
 * is the load-bearing one: a caller that answers it IS the human the fix
 * policy forwards to, and a caller that rejects (apps/hook) leaves the
 * request held for whoever attaches later.
 */
export interface AcpClientHandlers {
  onUpdate?(params: SessionNotification): void;
  onError?(params: MonadErrorNotification): void;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/**
 * Opens one ACP connection to the daemon (one connection per client is the
 * transport's model: each SSE mailbox has a single receiver).
 */
export async function connectAcp(
  handle: DaemonHandle,
  handlers: AcpClientHandlers,
  options: { name?: string } = {},
): Promise<AcpSession> {
  const stream = createHttpStream(`${handle.url}/acp`, {
    headers: authHeaders(handle.token),
  });
  const connection = client({ name: options.name ?? "monad-client" })
    .onNotification(methods.client.session.update, (ctx) => {
      handlers.onUpdate?.(ctx.params);
    })
    .onNotification(ERROR_NOTIFICATION_METHOD, MonadErrorNotificationSchema, (ctx) => {
      handlers.onError?.(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      handlers.requestPermission(ctx.params),
    )
    .connect(stream);
  const init = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return { connection, init };
}
