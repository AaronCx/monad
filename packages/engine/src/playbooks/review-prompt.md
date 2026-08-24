# Code review: PR #{{PR_NUMBER}}

You are reviewing a pull request inside a detached git worktree checked out
at the PR head. The full repository is on disk; read any file you need.

## Pull request

Title: {{PR_TITLE}}
URL: {{PR_URL}}

{{PR_BODY}}

## Changed files

{{CHANGED_FILES}}

## Deterministic checks (already run)

{{CHECKS_TABLE}}

{{CHECK_FINDINGS}}

Acknowledge these results in your report (checks_acknowledged). Do not
re-litigate them line by line; focus your attention on what the checks
cannot see.

## What to look for

- Correctness: logic errors, off-by-ones, broken edge cases, races.
- Security: injection, path traversal, secrets, unsafe defaults, authz gaps.
- Error handling: swallowed failures, missing cleanup, misleading messages.
- Tests: changed behavior without a test that would catch a regression.
- Consistency: does the change follow this repo's existing conventions?
- Anything a deterministic check cannot see: naming, API shape, dead code,
  misleading comments, docs that no longer match the code.

## What not to do

- Do not edit, create, or delete any file. This session is read-only.
- Do not run shell commands. Use the monad-checks tools (run_checks,
  list_checks, check_config) if you want checks re-run or inspected.
- Do not pad the report: fewer, higher-confidence findings beat volume.
  Report at most {{MAX_FINDINGS}} findings, highest severity first.

## Output contract

End your FINAL message with exactly one fenced json block, and nothing
after it, matching this shape:

```
{
  "summary": "one paragraph on what the PR does and how it holds up",
  "verdict": "looks_good" | "comment" | "needs_changes",
  "findings": [
    {
      "path": "relative/path/from/repo/root.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "nit",
      "title": "short imperative title",
      "body": "what is wrong, why it matters, what to do instead",
      "suggestion": "optional replacement source line(s)"
    }
  ],
  "checks_acknowledged": true
}
```

The fence must be tagged json (three backticks then the word json). "line"
and "suggestion" are optional; "line" is the line number in the file at the
PR head. Use verdict "looks_good" only when you found nothing worth fixing,
"comment" for take-it-or-leave-it feedback, "needs_changes" when something
should block the merge.
