import { methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";
import {
  REPLAY_COUNT_META_KEY,
  type SessionMode,
  type SessionRecord,
} from "@aaroncx/protocol";
import { cmdChecks } from "./checks.ts";
import { connectAcp, describeSessionStartError, InteractiveSession } from "./client.ts";
import {
  authHeaders,
  type DaemonHandle,
  ensureDaemon,
  fetchSessions,
  fetchStatus,
  findRunningDaemon,
  pidAlive,
  readDaemonInfo,
  setSessionMode,
  startDaemon,
  stopDaemon,
} from "./daemon.ts";
import { cmdGc } from "./gc.ts";
import { Renderer } from "./render.ts";
import { cmdReview, enterFixLoop } from "./review.ts";

const VERSION = "0.1.0";

function usage(): string {
  return [
    "monad: sessions that outlive the client that started them.",
    "",
    "Usage: monad <command> [options]",
    "",
    "  run [-p \"prompt\"] [--thoughts]   open a session in the current directory",
    "  attach <id> [--mode review|fix]  replay a session, then follow it live",
    "  review <pr> [--full] [--post]    review a PR in its own worktree",
    "             [--fix] [--no-install] [--backend claude]",
    "             [--trust | --no-trust] [--install]",
    "  checks [--staged | --base <ref>] run the checks here, no session",
    "         [--only a,b] [--full] [--json] [--untrusted]",
    "  gc [--older-than 7d]             remove closed sessions' worktrees",
    "  ls                               list sessions",
    "  daemon start|stop|status         manage monadd",
    "  acp-stdio                        stdio<->daemon ACP bridge for editors",
    "  --version                        print the version and exit",
    "",
    "run streams the agent's answer to stdout; each stdin line is a prompt",
    "(ctrl+D exits, ctrl+C cancels the in-flight turn). attach prints the",
    "history with a [replay] prefix, one --- live --- divider, then follows.",
    "review exits 0 when the verdict is looks_good or comment and no check",
    "failed; checks exits 1 on any failing check. A PR from a fork, or from",
    "someone without write access, is reviewed as untrusted: no dependency",
    "install, no build, no test, and its .monad.yml cannot decide what runs",
    "(--trust overrides, --no-trust forces it, decision record 0009).",
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
  let created: { sessionId: string };
  try {
    created = await session.connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
  } catch (error) {
    console.error(describeSessionStartError(error));
    session.connection.close();
    process.exit(1);
  }
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

/** Resolves a full or abbreviated session id against the daemon's list. */
async function resolveSession(handle: DaemonHandle, id: string): Promise<SessionRecord> {
  const sessions = await fetchSessions(handle);
  const matches = sessions.filter((s) => s.id === id || s.id.startsWith(id));
  if (matches.length === 0) {
    fail(`no session matches ${id} (see monad ls)`);
  }
  if (matches.length > 1) {
    fail(`ambiguous session id ${id}; matches ${matches.map((s) => s.id).join(", ")}`);
  }
  return matches[0] as SessionRecord;
}

async function cmdAttach(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id || id.startsWith("-")) {
    fail("attach needs a session id (see monad ls)");
  }
  const rest = argv.slice(1);
  let mode: SessionMode | undefined;
  const modeIndex = rest.indexOf("--mode");
  if (modeIndex !== -1) {
    const value = rest[modeIndex + 1];
    if (value !== "review" && value !== "fix") {
      fail("--mode needs review or fix");
    }
    mode = value;
    rest.splice(modeIndex, 2);
  }
  const flags = parseRunFlags(rest);
  const handle = await ensureDaemon();
  const record = await resolveSession(handle, id);

  if (mode !== undefined) {
    const updated = await setSessionMode(handle, record.id, mode);
    console.log(`mode: ${updated.mode} (${updated.cwd})`);
    if (mode === "fix") {
      // Fix mode announces itself to the agent with one user prompt, then
      // hands stdin to the interactive loop. With -p it sends that one
      // prompt after the announcement and exits instead.
      await enterFixLoop(handle, updated, { prompt: flags.prompt });
      process.exit(0);
    }
  }

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
  if (flags.prompt !== undefined) {
    // One prompt then exit, matching monad run -p. Without this the flag
    // parses and is silently ignored, and a scripted attach exits 0 having
    // sent nothing.
    const stopReason = await interactive.sendPrompt(flags.prompt);
    session.connection.close();
    process.exit(stopReason === undefined ? 1 : 0);
  }
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
    const pr = s.pr ? `#${s.pr.number}` : "-";
    console.log(
      `${s.id}  ${s.status.padEnd(22)}  ${s.mode.padEnd(11)}  ${pr.padEnd(6)}  ${s.cwd}  ${s.updatedAt}`,
    );
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

try {
  switch (command) {
    case "run":
      await cmdRun(rest);
      break;
    case "attach":
      await cmdAttach(rest);
      break;
    case "review":
      await cmdReview(rest);
      break;
    case "checks":
      await cmdChecks(rest);
      break;
    case "gc":
      await cmdGc(rest);
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
} catch (error) {
  // Commands throw plain Errors for bad input and failed subprocesses; a
  // stack trace is never the right thing to show a user at the prompt.
  fail(error instanceof Error ? error.message : String(error));
}
