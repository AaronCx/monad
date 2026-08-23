/**
 * A client fixture that dies badly. Connects to monadd over the HTTP
 * transport, loads a session, sends a prompt that triggers a permission
 * request, prints PERMISSION_DELIVERED once the request reaches it, and then
 * sleeps forever: it never answers and never closes the connection. The
 * integration test SIGKILLs this process to reproduce a client whose tmux
 * window is killed: no HTTP DELETE on the wire, just TCP socket death.
 *
 * Env: MONAD_PORT, MONAD_TOKEN, MONAD_SESSION, MONAD_CWD.
 */
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { createHttpStream } from "@aaroncx/engine/transport";

const port = process.env.MONAD_PORT;
const token = process.env.MONAD_TOKEN;
const sessionId = process.env.MONAD_SESSION;
const cwd = process.env.MONAD_CWD ?? process.cwd();
if (!port || !token || !sessionId) {
  console.error("doomed-client: MONAD_PORT, MONAD_TOKEN and MONAD_SESSION are required");
  process.exit(2);
}

const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
  headers: { Authorization: `Bearer ${token}` },
});

const connection = client({ name: "doomed" })
  .onNotification(methods.client.session.update, () => {})
  .onNotification("_monad.sh/error", (params: unknown) => params as Record<string, unknown>, () => {})
  .onRequest(methods.client.session.requestPermission, () => {
    console.log("PERMISSION_DELIVERED");
    return new Promise<RequestPermissionResponse>(() => {});
  })
  .connect(stream);

await connection.agent.request(methods.agent.initialize, {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {},
});
await connection.agent.request(methods.agent.session.load, {
  sessionId,
  cwd,
  mcpServers: [],
});
console.log("LOADED");

// "perm" in the text makes the fake backend agent issue a permission
// request. The promise never settles here: the permission is never answered
// and this process is SIGKILLed by the test.
void connection.agent
  .request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "perm from the doomed client" }],
  })
  .catch(() => {});

// Sleep until killed.
await new Promise(() => {});
