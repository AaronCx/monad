# 0007: Review sessions run in vendor plan mode plus monad policy

Date: 2026-08-23
Status: accepted

## Question

Is claude-agent-acp's plan mode usable as the vendor-side read-only layer for monad review
sessions, and do MCP tools injected via session/new (the monad-checks plane from decision 0005's
successor spike) still work inside it? If plan mode blocked MCP tools, review would run in
default mode with monad's review policy as the only read-only layer.

## What was probed

Throwaway spike (scratch dir, not in the repo), run 2026-08-23 on the Mac Mini. The vendored
adapter at ~/.monad/vendor (claude-agent-acp 0.70.0) was spawned per decision 0005's contract
(Bun.spawn, env HOME plus PATH only, node from /opt/homebrew/bin, FileSink wrapper before
ndJsonStream), cwd a throwaway git repo containing one file note.txt. session/new carried one
mcpServers entry of type http (bearer token in headers) pointing at a local stateless
Streamable HTTP server built with @modelcontextprotocol/sdk 1.30.0 exposing one tool,
ping_check. Two runs: (1) plan mode, prompt asking for both a file edit and a ping_check call;
(2) plan mode, prompt asking only for the ping_check call.

## Result

Both questions answered yes.

- Edits: the vendor diverted the edit itself. The model never attempted an edit tool call on
  the repo file; it stated plan mode was active, wrote a plan, and called ExitPlanMode, which
  surfaced as the turn's only session/request_permission (kind switch_mode, "Ready to code?").
  Answering the reject_once option kept the session in plan mode, the turn ended with
  end_turn, and note.txt was byte identical (git status clean).
- MCP: in plan mode the model loaded mcp__monad-checks__ping_check via ToolSearch and called
  it; the server logged tools/call and the result streamed back, with zero permission
  requests. The bearer header was present on every adapter request to the server.

## Decision

Review sessions get two independent read-only layers:

1. Vendor layer: immediately after session/new, monadd calls session/set_mode with
   modeId "plan" and treats the empty acknowledgment as success.
2. monad layer: the review policy in the daemon's permission responder and MCP allowlist,
   exactly as designed. This layer is NOT redundant (see facts 1 and 2 below).

The checks plane (monad-checks MCP tools) is available to review sessions without leaving plan
mode; no default-mode fallback is needed.

## Facts the implementation must honor

1. Plan mode is not a filesystem sandbox. The adapter wrote its plan document to
   ~/.claude/plans/<slug>.md, outside the session cwd, with no permission request. The vendor
   layer protects the repo; monad policy remains the outer boundary.
2. The permission responder is the real gate. The ExitPlanMode request offers allow_always
   options up to bypassPermissions alongside the reject_once "plan" option. A review session's
   requestPermission handler must always select the reject_once option (optionId "plan");
   auto-approval would escalate the session out of read-only entirely.
3. Modes ground truth (0.70.0): availableModes is auto, default, acceptEdits, plan, dontAsk,
   bypassPermissions (six, not the five in the M2 brief; auto is new). currentModeId at
   session/new is default.
4. Client-initiated session/set_mode returns an empty response and emits NO
   current_mode_update; the only observable echo is a config_option_update whose mode option
   shows the new currentValue. current_mode_update fires only for agent-initiated switches
   (for example, approving ExitPlanMode into another mode). State machines must not wait for a
   current_mode_update after setting plan mode.
5. Do not assert on refusal text or failed edit tool calls. Plan mode edit refusal is model
   discipline plus the ExitPlanMode gate; the testable invariants are file-unchanged, the
   switch_mode permission request, and the reject flow.
6. MCP tools are deferred in this adapter: the model runs ToolSearch
   (select:mcp__<server>__<tool>) before first use. With a mixed prompt the model may defer
   even read-only MCP calls into the plan, so review orchestration must either prompt for
   checks explicitly as read-only actions or not depend on the model calling them mid-plan.
7. Server side of the checks plane: the adapter's MCP client first POSTs a nonstandard
   server/discover method (answer with a normal method-not-found error) and attempts an SSE
   GET (a stateless Streamable HTTP server's 405 is tolerated). The Authorization header from
   the session/new headers array arrived on every request, including tools/call.

## Revisit when

The adapter changes its mode set or ExitPlanMode option list on a version bump, or when monad
wants the auto mode classifier as a middle tier between review and full sessions.
