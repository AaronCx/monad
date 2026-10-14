# Importer fixtures

Small synthetic vendor logs modeled on the real formats on the Mac mini
(Claude Code 2.1.x under `~/.claude/projects`, Codex CLI 0.94 under
`~/.codex/sessions`), never copies of real logs. They are templates:
`import.test.ts` replaces `{{HOME}}`, `{{REPO_A}}`, `{{REPO_B}}` and
`{{TOKEN}}` with temp paths and a planted token before importing them.

- `claude/project/<id>.jsonl`: a main session started in `{{HOME}}` (not a
  repository) that reads a file in repo A and runs `cd` into repo B. It has
  every line kind the importer must handle: bookkeeping lines, a meta line,
  a slash command and its output, a task notification, the human's ask, an
  assistant message split across lines (thinking, text, tool_use), tool
  results (one failed), a turn end, a queued prompt, an API error line, a
  compaction summary, a sidechain line that belongs to a subagent, and an
  older Claude Code's `summary` line.
- `claude/project/<id>/subagents/agent-a1.jsonl` (+ `.meta.json`): a
  subagent, and `workflows/wf_1/agent-w1.jsonl`: a workflow agent. The
  workflow's `journal.jsonl` is not a transcript and must be ignored.
- `codex/2026/02/05/rollout-*.jsonl`: a Codex session with injected
  developer and user context (not asks), a user_message, a shell call with
  a workdir, an apply_patch, and the agent's reply logged twice.
