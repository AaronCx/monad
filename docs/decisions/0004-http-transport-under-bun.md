# 0004: HTTP transport under Bun

Date: 2026-08-22
Status: accepted

## Context

monadd serves ACP to its own clients over the SDK's Streamable HTTP transport. The server side
of that transport ships as experimental exports built for Node (`AcpServer` from
`@agentclientprotocol/sdk/experimental/server`, `createNodeHttpHandler` from
`.../experimental/node`), and monad runs on Bun. Before building `packages/engine/src/transport`
we needed to know whether Bun's `node:http` shim carries the whole flow, in particular the SSE
streams that deliver `session/update` notifications, or whether we need a hand-written
`Bun.serve` handler that satisfies `createHttpStream`.

## What was probed

Throwaway spike (scratch dir, not in the repo), `@agentclientprotocol/sdk@1.4.0` exactly,
`zod@4.4.3`, Bun 1.3.10 on macOS arm64. A minimal echo agent modeled on the SDK's shipped
`dist/examples/http-server.js` (Bun process one: `node:http` `createServer` +
`createNodeHttpHandler(new AcpServer({ agent }))` on `127.0.0.1:7431/acp`, bearer token check in
front of the handler, no WebSocket path). Driven from Bun process two with `createHttpStream`:

1. `initialize`, `session/new`, `session/prompt`; the prompt streamed three
   `agent_message_chunk` updates over the session SSE stream.
2. Reconnect: a fresh `createHttpStream` sharing the same `MemoryAcpCookieStore`, `initialize`,
   capability check, `session/load` replaying the full history, then a live prompt on the
   loaded session.
3. Cross-runtime check: the same client run under Node 25.8.0 against the Bun server.

## Result

Everything passed under Bun as shipped. POST round trips work, the initialize response carries
`Acp-Connection-Id`, SSE streams deliver ordered `session/update` notifications through Bun's
`node:http` shim, and the reconnect flow (new stream, `initialize`, `session/load`, live
updates) works end to end. The Node client against the Bun server also passed, so the two
runtimes interoperate on this transport. The `Bun.serve` fallback was not needed and was not
built.

## Decision

M1 uses the SDK's node adapter as is: `packages/engine/src/transport` wraps `AcpServer` +
`createNodeHttpHandler` behind `createAcpHttpServer(agent, opts)` with `listen(port, host)` and
`close()`. No `Bun.serve` fallback, no WebSocket upgrade path in M1. The transport module is the
only place that imports `experimental/*` paths, per decision 0001 and the repo rules.

## Facts the implementation must honor

- Wire shape: first POST is `initialize` with no connection header and returns 200 with the
  JSON-RPC response body plus an `Acp-Connection-Id` response header. Every later POST carries
  `Acp-Connection-Id` (plus `Acp-Session-Id` for session scoped messages) and returns 202 with
  an empty body; responses and notifications arrive on SSE GET streams (`Accept:
  text/event-stream` plus the same headers). DELETE with `Acp-Connection-Id` tears down the
  connection.
- No cross-stream ordering guarantee: the transport routes the `session/load` response to the
  connection SSE stream while replayed `session/update` notifications ride the per-session SSE
  stream (see `pendingResponseRoute` in `dist/server.js`). The load response can resolve before
  the replay finishes arriving. Attach and replay code must not treat the `session/load`
  response as replay complete; the CLI needs an explicit completion signal from the daemon
  (event count in the load response `_meta`, or a sentinel update) before printing the
  `--- live ---` divider.
- One active SSE receiver per stream: a second GET on the same connection or session stream is
  rejected with 409. Multi-client attach therefore means one `createHttpStream` connection per
  client, which is monad's model anyway.
- Cookie affinity is client side only. `createHttpStream` persists any `Set-Cookie` it sees into
  its `AcpCookieStore` for external load balancers; `AcpServer` never touches cookies. A single
  process monadd needs no cookie handling, and clients should hold one cookie store across
  reconnects like the shipped example does.
- `stream.writable.close()` after session traffic rejects on both Bun and Node because
  `connectWith` already closed the connection and the writable is still locked. Swallow it or
  skip the manual close; connection cleanup happens through the transport's own close path.
- The shipped example imports `ws`, which is a devDependency of the SDK. The HTTP plus SSE path
  needs only `node:http`; do not add `ws` in M1.
- The SDK has zero runtime dependencies and declares zod as a peer dependency
  (`^3.25.0 || ^4.0.0`); zod 4 works. `createNodeHttpHandler` caps request bodies at 16 MiB by
  default. Auth middleware sits in front of the handler in the `node:http` request callback,
  which is where the bearer token check from `packages/engine/src/auth.ts` goes.

## Revisit when

The `experimental/*` export paths or option shapes change on an SDK bump, or when a later
milestone wants the WebSocket upgrade path or non-loopback exposure.
