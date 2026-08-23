import { methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";
import {
  ListSessionsResponseSchema,
  REPLAY_COUNT_META_KEY,
  type SessionRecord,
} from "@aaroncx/protocol";
import { connectAcp, InteractiveSession } from "./client.ts";
import {
  authHeaders,
  ensureDaemon,
  fetchStatus,
  findRunningDaemon,
  pidAlive,
  readDaemonInfo,
  startDaemon,
  stopDaemon,
} from "./daemon.ts";
import { Renderer } from "./render.ts";

const VERSION = "0.1.0";

function usage(): string {
  return [
    "monad: sessions that outlive the client that started them.",
    "",
    "Usage: monad <command> [options]",
    "",
    "  run [-p \"prompt\"] [--thoughts]   open a session in the current directory",
    "  attach <id> [--thoughts]         replay a session, then follow it live",
    "  ls                               list sessions",
    "  daemon start|stop|status         manage monadd",
    "  acp-stdio                        stdio<->daemon ACP bridge for editors",
    "  --version                        print the version and exit",
    "",
    "run streams the agent's answer to stdout; each stdin line is a prompt",
    "(ctrl+D exits, ctrl+C cancels the in-flight turn). attach prints the",
    "history with a [replay] prefix, one --- live --- divider, then follows.",
  ].join("\n");
}

function fail(message: string): never {
  console.error(`monad: ${message}`);
  process.exit(1);
}

interface RunFlags {
  prompt?: string;
  thoughts: boolean;
}

function parseRunFlags(argv: string[]): RunFlags {
  const flags: RunFlags = { thoughts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--prompt") {
      const value = argv[++i];
      if (value === undefined) {
        fail(`${arg} needs a prompt string`);
      }
      flags.prompt = value;
    } else if (arg === "--thoughts") {
      flags.thoughts = true;
    } else {
      fail(`unknown flag ${arg}`);
    }
  }
  return flags;
}

async function cmdRun(argv: string[]): Promise<void> {
  const flags = parseRunFlags(argv);
  const handle = await ensureDaemon();
  const renderer = new Renderer({ thoughts: flags.thoughts, divider: false });
  const interactive = new InteractiveSession(renderer);
  const session = await connectAcp(handle, renderer, interactive);
  const created = await session.connection.agent.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`session: ${created.sessionId}`);
  renderer.beginLive(0);
  interactive.bind(session, created.sessionId);
  if (flags.prompt !== undefined) {
    const stopReason = await interactive.sendPrompt(flags.prompt);
    session.connection.close();
    process.exit(stopReason === undefined ? 1 : 0);
  }
  console.log(renderer.dim("type a prompt and press enter (ctrl+D to exit)"));
  await interactive.runLoop();
  session.connection.close();
  process.exit(0);
}

async function fetchSessions(handle: { url: string; token: string }): Promise<SessionRecord[]> {
  const response = await fetch(`${handle.url}/v1/sessions`, {
    headers: authHeaders(handle.token),
  });
  if (!response.ok) {
    fail(`GET /v1/sessions failed with ${response.status}`);
  }
  return ListSessionsResponseSchema.parse(await response.json()).sessions;
}

async function cmdAttach(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id || id.startsWith("-")) {
    fail("attach needs a session id (see monad ls)");
  }
  const flags = parseRunFlags(argv.slice(1));
  const handle = await ensureDaemon();
  const sessions = await fetchSessions(handle);
  const matches = sessions.filter((s) => s.id === id || s.id.startsWith(id));
  if (matches.length === 0) {
    fail(`no session matches ${id} (see monad ls)`);
  }
  if (matches.length > 1) {
    fail(`ambiguous session id ${id}; matches ${matches.map((s) => s.id).join(", ")}`);
  }
  const record = matches[0] as SessionRecord;

  const renderer = new Renderer({ thoughts: flags.thoughts, divider: true });
  const interactive = new InteractiveSession(renderer);
  const session = await connectAcp(handle, renderer, interactive);
  if (session.init.agentCapabilities?.loadSession !== true) {
    fail("daemon does not advertise loadSession; cannot attach");
  }
  const loaded = await session.connection.agent.request(methods.agent.session.load, {
    sessionId: record.id,
    cwd: record.cwd,
    mcpServers: [],
  });
  const rawCount = loaded?._meta?.[REPLAY_COUNT_META_KEY];
  const replayCount = typeof rawCount === "number" && rawCount >= 0 ? rawCount : 0;
  renderer.beginLive(replayCount);
  interactive.bind(session, record.id);
  await interactive.runLoop();
  session.connection.close();
  process.exit(0);
}

async function cmdLs(): Promise<void> {
  const handle = await ensureDaemon();
  const sessions = await fetchSessions(handle);
  if (sessions.length === 0) {
    console.log("no sessions");
    return;
  }
  for (const s of sessions) {
    console.log(`${s.id}  ${s.status.padEnd(22)}  ${s.cwd}  ${s.updatedAt}`);
  }
}

async function cmdDaemon(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "start": {
      const running = await findRunningDaemon();
      if (running) {
        console.log(`monadd already running (pid ${running.info.pid}, port ${running.info.port})`);
        return;
      }
      const handle = await startDaemon();
      console.log(`monadd started (pid ${handle.info.pid}, port ${handle.info.port})`);
      return;
    }
    case "stop": {
      const stopped = await stopDaemon();
      console.log(stopped ? "monadd stopped" : "monadd is not running");
      return;
    }
    case "status": {
      const info = readDaemonInfo();
      if (!info || !pidAlive(info.pid)) {
        console.log("monadd is not running");
        return;
      }
      const handle = await findRunningDaemon();
      if (!handle) {
        console.log(`monadd process ${info.pid} exists but /v1/status is not answering`);
        process.exit(1);
      }
      const status = await fetchStatus(handle.url, handle.token);
      if (!status) {
        console.log("monadd stopped answering while checking status");
        process.exit(1);
      }
      console.log(`monadd ${status.version} (pid ${info.pid}, port ${info.port})`);
      console.log(`started: ${status.startedAt} (uptime ${Math.round(status.uptimeMs / 1000)}s)`);
      if (status.activeBackends.length === 0) {
        console.log("active backends: none");
      } else {
        for (const backend of status.activeBackends) {
          console.log(`active backend: ${backend.backend} for session ${backend.sessionId}`);
        }
      }
      return;
    }
    default:
      fail("daemon needs one of: start, stop, status");
  }
}

/**
 * The editor bridge: a dumb bidirectional pipe between stdio ndjson and the
 * daemon's HTTP transport. Zero protocol logic; the editor speaks ACP to
 * monadd directly (see docs/editors.md).
 */
async function cmdAcpStdio(): Promise<void> {
  const handle = await ensureDaemon();
  const sink = Bun.stdout.writer();
  const stdoutWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
    close() {
      sink.end();
    },
  });
  const local = ndJsonStream(stdoutWritable, Bun.stdin.stream());
  const remote = createHttpStream(`${handle.url}/acp`, {
    headers: authHeaders(handle.token),
  });
  await Promise.race([
    local.readable.pipeTo(remote.writable).catch(() => {}),
    remote.readable.pipeTo(local.writable).catch(() => {}),
  ]);
  process.exit(0);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(`monad ${VERSION}`);
  process.exit(0);
}

switch (command) {
  case "run":
    await cmdRun(rest);
    break;
  case "attach":
    await cmdAttach(rest);
    break;
  case "ls":
    await cmdLs();
    break;
  case "daemon":
    await cmdDaemon(rest);
    break;
  case "acp-stdio":
    await cmdAcpStdio();
    break;
  case "--help":
  case "-h":
  case "help":
  case undefined:
    console.log(usage());
    process.exit(command === undefined ? 1 : 0);
    break;
  default:
    console.error(`monad: unknown command ${command}\n\n${usage()}`);
    process.exit(2);
}
