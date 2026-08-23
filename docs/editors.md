# Editor integration

Any ACP-capable editor can drive monad by spawning `monad acp-stdio`. The bridge is a dumb
bidirectional pipe between the editor's stdio and the daemon's HTTP transport: the editor
speaks ACP straight to monadd, gets monad's persistent sessions, and needs zero monad-specific
support. The bridge auto-starts the daemon when it is not running.

Sessions opened from an editor are the same sessions `monad ls` shows, so you can
`monad attach <id>` to an editor-born session from a terminal (and the other way around:
an editor can `session/load` a CLI-born session if it exposes that).

## Zed

Add monad as a custom agent server in Zed's `settings.json` (Cmd+, then "Open Settings"):

```json
{
  "agent_servers": {
    "monad": {
      "command": "/usr/local/bin/monad",
      "args": ["acp-stdio"]
    }
  }
}
```

Point `command` at wherever the compiled `monad` binary lives (`bun run build` produces
`apps/cli/dist/monad`; put it on your PATH or use the absolute path). Then open the agent
panel, pick `monad`, and start a session.

Notes:

- Each editor connection is its own ACP connection to the daemon, which is exactly monad's
  multi-client model (one SSE receiver per stream).
- The daemon replays history through `session/load`. The replay count rides the response
  `_meta["monad.sh/replayCount"]`; editors that ignore `_meta` still render the replayed
  updates correctly, they just cannot draw a replay divider.
- monad's error events reach editors as `_monad.sh/error` extension notifications. SDK-based
  clients silently drop unknown notifications, so editors that do not know monad are safe.

## Other ACP clients

JetBrains and the VS Code ACP extension configure external agents the same way: command
`monad`, args `["acp-stdio"]`. Consult each client's documentation for where the setting
lives.
