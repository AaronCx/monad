import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionResolutionMeta, SessionId, SessionMode } from "@aaroncx/protocol";

/** A client able to answer a permission request (an attached CLI, editor, ...). */
export interface PermissionClient {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/**
 * Persistence hooks the policy calls. The SessionManager implements these
 * against the store so the policy itself stays free of storage concerns.
 * Every resolution carries metadata saying WHO decided (a human or one of
 * the policies) so auto-decisions stay visible in the transcript.
 */
export interface PermissionPolicyHooks {
  persistRequested(sessionId: SessionId, params: RequestPermissionRequest): void;
  persistResolved(
    sessionId: SessionId,
    response: RequestPermissionResponse,
    meta: PermissionResolutionMeta,
  ): void;
  setStatus(sessionId: SessionId, status: "running" | "waiting_for_permission"): void;
}

export interface PermissionPolicy {
  /**
   * Routes one agent-side session/request_permission. The returned promise
   * stays open until a client answers or the session is cancelled; the
   * caller (the backend's client handler) returns it to the vendor agent.
   */
  request(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    client: PermissionClient | undefined,
  ): Promise<RequestPermissionResponse>;

  /**
   * Offers a held request to a newly attached client. Returns the pending
   * params if there was one to deliver, undefined otherwise. First answer
   * wins if several clients see the same request.
   */
  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest | undefined;

  /** The held request for a session, if any. */
  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined;

  /** Resolves a held request with a cancelled outcome (session/cancel path). */
  cancel(sessionId: SessionId): void;
}

interface PendingPermission {
  params: RequestPermissionRequest;
  settled: boolean;
  resolve: (response: RequestPermissionResponse) => void;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function metaFor(
  by: PermissionResolutionMeta["by"],
  params: RequestPermissionRequest,
  response: RequestPermissionResponse,
  message?: string,
): PermissionResolutionMeta {
  const meta: PermissionResolutionMeta = { by };
  if (response.outcome.outcome === "selected") {
    meta.optionId = response.outcome.optionId;
  }
  const toolCallId = params.toolCall?.toolCallId;
  if (toolCallId) {
    meta.toolCallId = toolCallId;
  }
  if (message) {
    meta.message = message;
  }
  return meta;
}

/**
 * The M1 policy: interactive. Forward the request to the most recently
 * active attached client; with nobody attached, persist permission_requested,
 * mark the session waiting_for_permission, and hold the vendor agent's
 * request open until a client attaches and answers or the session is
 * cancelled. This is the seed of answering from a phone later: the waiting
 * path is real, not a timeout.
 */
export class InteractivePermissionPolicy implements PermissionPolicy {
  private readonly hooks: PermissionPolicyHooks;
  private readonly pending = new Map<SessionId, PendingPermission>();
  /**
   * When true, request() does not persist permission_requested itself (the
   * caller already did). Used by the mode-aware policy so a forwarded fix
   * execute is logged exactly once.
   */
  private readonly skipPersistRequested: boolean;

  constructor(hooks: PermissionPolicyHooks, options: { skipPersistRequested?: boolean } = {}) {
    this.hooks = hooks;
    this.skipPersistRequested = options.skipPersistRequested ?? false;
  }

  async request(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    client: PermissionClient | undefined,
  ): Promise<RequestPermissionResponse> {
    if (this.pending.has(sessionId)) {
      throw new Error(`a permission request is already pending for session ${sessionId}`);
    }
    if (!this.skipPersistRequested) {
      this.hooks.persistRequested(sessionId, params);
    }
    if (client) {
      try {
        const response = await client.requestPermission(params);
        this.hooks.persistResolved(sessionId, response, metaFor("human", params, response));
        return response;
      } catch {
        // The client vanished mid-question. Fall through to the waiting path.
      }
    }
    this.hooks.setStatus(sessionId, "waiting_for_permission");
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(sessionId, { params, settled: false, resolve });
    });
  }

  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest | undefined {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.settled) {
      return undefined;
    }
    client
      .requestPermission(entry.params)
      .then((response) => {
        this.settle(sessionId, entry, response, "running");
      })
      .catch(() => {
        // This client vanished too; the request stays held for the next one.
      });
    return entry.params;
  }

  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined {
    return this.pending.get(sessionId)?.params;
  }

  cancel(sessionId: SessionId): void {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.settled) {
      return;
    }
    // Status is left to the caller: session/cancel ends the turn and the
    // manager sets the session idle.
    entry.settled = true;
    this.pending.delete(sessionId);
    this.hooks.persistResolved(
      sessionId,
      CANCELLED,
      metaFor("human", entry.params, CANCELLED, "cancelled"),
    );
    entry.resolve(CANCELLED);
  }

  private settle(
    sessionId: SessionId,
    entry: PendingPermission,
    response: RequestPermissionResponse,
    status: "running",
  ): void {
    if (entry.settled || this.pending.get(sessionId) !== entry) {
      return; // Another client answered first.
    }
    entry.settled = true;
    this.pending.delete(sessionId);
    this.hooks.persistResolved(sessionId, response, metaFor("human", entry.params, response));
    this.hooks.setStatus(sessionId, status);
    entry.resolve(response);
  }
}

/**
 * What a policy wants to happen to one permission request. allow and reject
 * pick a PermissionOption by kind (allow_once / reject_once ONLY; a policy
 * never selects allow_always or reject_always). forward hands the request to
 * the interactive path: the attached human, or held until one attaches.
 */
export type PolicyVerdict =
  | { kind: "allow" }
  | { kind: "reject"; message: string; preferOptionId?: string }
  | { kind: "forward" };

/**
 * The tool name as monad identifies it: the adapter sets both title and
 * _meta.claudeCode.toolName to mcp__<server>__<tool> for MCP tools (spike
 * 0a); _meta wins when present because title is also a human label for
 * built-in tools.
 */
export function permissionToolName(params: RequestPermissionRequest): string | undefined {
  const meta = params.toolCall?._meta as
    | { claudeCode?: { toolName?: unknown } }
    | null
    | undefined;
  const metaName = meta?.claudeCode?.toolName;
  if (typeof metaName === "string" && metaName.length > 0) {
    return metaName;
  }
  const title = params.toolCall?.title;
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

const MONAD_CHECKS_TOOL_PREFIX = "mcp__monad-checks__";

function isMonadChecksTool(params: RequestPermissionRequest): boolean {
  return permissionToolName(params)?.startsWith(MONAD_CHECKS_TOOL_PREFIX) ?? false;
}

/**
 * Decision 0007 fact 2: the ExitPlanMode permission request offers
 * allow_always options up to bypassPermissions beside a reject_once option
 * whose optionId is "plan". A review session must answer with that option;
 * anything else escalates the session out of read-only.
 */
export const PLAN_MODE_REJECT_OPTION_ID = "plan";

/**
 * The review policy verdict for one request. Total: review never forwards.
 * Allowed: read, search, think, and any monad-checks tool. Everything else
 * is rejected, with a message naming what was blocked so the transcript
 * shows it.
 */
export function decideReviewPermission(params: RequestPermissionRequest): PolicyVerdict {
  if (isMonadChecksTool(params)) {
    return { kind: "allow" };
  }
  const kind = params.toolCall?.kind ?? "other";
  switch (kind) {
    case "read":
    case "search":
    case "think":
      return { kind: "allow" };
    case "edit":
    case "delete":
    case "move":
    case "fetch":
      return {
        kind: "reject",
        message: `review mode is read-only; ${kind} was blocked by policy:review`,
      };
    case "execute":
      return {
        kind: "reject",
        message:
          "execute is blocked in review mode; the monad-checks tools (run_checks) are the " +
          "sanctioned way to run lint, typecheck, build, and test. If you need something " +
          "else, say so in your review instead of running it.",
      };
    case "switch_mode":
      // Decision 0007: answer ExitPlanMode with the reject_once option whose
      // optionId is "plan". Never auto-approve; the request dangles
      // allow_always options up to bypassPermissions.
      return {
        kind: "reject",
        preferOptionId: PLAN_MODE_REJECT_OPTION_ID,
        message: "review sessions stay in plan mode; mode switches are blocked by policy:review",
      };
    default: {
      const name = permissionToolName(params) ?? "an unnamed tool";
      return {
        kind: "reject",
        message: `${name} is not allowed in review mode (blocked by policy:review)`,
      };
    }
  }
}

/**
 * Resolves a path the way the fix policy needs it: symlinks and .. resolved
 * against the real filesystem, tolerating not-yet-existing leaf components
 * (an edit may create the file). The longest existing ancestor is
 * realpath-resolved, then the remaining lexically-normalized components are
 * appended.
 */
export function realpathDeep(path: string): string {
  let prefix = normalize(path);
  let suffix = "";
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return suffix.length > 0 ? join(real, suffix) : real;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) {
        return suffix.length > 0 ? join(prefix, suffix) : prefix;
      }
      suffix = suffix.length > 0 ? join(basename(prefix), suffix) : basename(prefix);
      prefix = parent;
    }
  }
}

function resolvesInsideWorktree(worktreeReal: string, path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  const resolved = realpathDeep(absolute);
  return resolved === worktreeReal || resolved.startsWith(worktreeReal + sep);
}

/** Context the fix policy decides against. */
export interface FixPolicyContext {
  /** The session's worktree (its cwd). Boundary for edit/delete/move. */
  worktree: string;
  /**
   * Execute prefixes allowed without a human: git status/diff/add/commit/
   * log/show plus the repo's lint/typecheck/test/build scripts.
   */
  execAllowlist: string[];
}

const FIX_GIT_ALLOWLIST = ["git status", "git diff", "git add", "git commit", "git log", "git show"];

/**
 * The execute allowlist for a fix session: the fixed git prefixes plus
 * `<runner> run <script>` for each of the repo's lint/typecheck/test/build
 * package.json scripts (and the bare `bun test` / `npm test` shorthands when
 * a test script exists).
 */
export function fixExecAllowlist(worktree: string): string[] {
  const allow = [...FIX_GIT_ALLOWLIST];
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = manifest.scripts ?? {};
  } catch {
    return allow;
  }
  for (const name of ["lint", "typecheck", "test", "build"]) {
    if (typeof scripts[name] === "string") {
      for (const runner of ["bun", "npm", "pnpm", "yarn"]) {
        allow.push(`${runner} run ${name}`);
      }
    }
  }
  if (typeof scripts.test === "string") {
    allow.push("bun test", "npm test");
  }
  return allow;
}

function commandFromRawInput(rawInput: unknown): string | undefined {
  if (typeof rawInput === "string") {
    return rawInput;
  }
  if (typeof rawInput === "object" && rawInput !== null) {
    const command = (rawInput as { command?: unknown }).command;
    if (typeof command === "string") {
      return command;
    }
  }
  return undefined;
}

/**
 * Shell syntax that makes a command more than the single program its prefix
 * names: chaining and separators (&& || ; & newline), pipes, redirections,
 * command substitution ($( ` <( ), and subshell/brace grouping. A prefix
 * match cannot vouch for what runs after any of these, so
 * `git commit -m x && git push` must NOT ride in on the `git commit` entry.
 */
const SHELL_CONTROL_CHARS = new Set([";", "&", "|", "<", ">", "`", "(", ")", "{", "}", "\n", "\r"]);

/**
 * True when the command carries shell syntax outside quotes. Quoting is
 * tracked so a conventional-commit subject such as
 * `git commit -m "fix(policy): thing"` stays a single command, while
 * `git commit -m x && git push` does not. Backslash escapes are honored
 * outside single quotes. Substitution (backtick, $(, ${) still counts
 * inside DOUBLE quotes, where a real shell expands it; single quotes
 * suppress everything. Unterminated quoting counts as control syntax, since
 * the real shell would then read further than this scan can model.
 */
export function hasShellControlSyntax(command: string): boolean {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (char === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === "`" || (char === "$" && (command[i + 1] === "(" || command[i + 1] === "{"))) {
        return true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (SHELL_CONTROL_CHARS.has(char)) {
      return true;
    }
    if (char === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) {
      return true;
    }
  }
  return quote !== undefined;
}

/**
 * True only for a single unchained command whose text begins with an
 * allowlist entry. Anything carrying shell control syntax (chaining,
 * separators, pipes, redirections, command substitution, grouping) is never
 * matched here, because a prefix match cannot vouch for what runs after it;
 * the caller forwards those to the attached human instead. That is what
 * keeps `git push` behind a permission prompt however it is spelled,
 * including `git commit -m x && git push`.
 */
/**
 * Git global options that carry no capability of their own, so skipping them
 * cannot turn a safe subcommand into an unsafe one. Deliberately excluded:
 * -c (sets arbitrary config, and core.sshCommand or an alias turns into
 * command execution), -C, --git-dir, --work-tree and --exec-path (all
 * redirect git outside the worktree). A command using any of those does not
 * match the allowlist and forwards to the human, which is the safe default.
 */
const SAFE_GIT_GLOBAL_FLAGS = new Set([
  "--no-pager",
  "-P",
  "--paginate",
  "--no-replace-objects",
  "--literal-pathspecs",
]);

/**
 * Drops the safe global flags so `git --no-pager diff` matches the `git diff`
 * allowlist entry. Agents reach for --no-pager constantly; without this every
 * one of those reads forwards to a human for no security gain.
 */
function stripSafeGitGlobals(normalized: string): string {
  const parts = normalized.split(" ");
  if (parts[0] !== "git") {
    return normalized;
  }
  let index = 1;
  while (index < parts.length && SAFE_GIT_GLOBAL_FLAGS.has(parts[index] as string)) {
    index += 1;
  }
  return index === 1 ? normalized : ["git", ...parts.slice(index)].join(" ");
}

function matchesAllowlist(command: string, allowlist: string[]): boolean {
  const normalized = command.trim().replace(/[ \t]+/g, " ");
  if (hasShellControlSyntax(normalized)) {
    return false;
  }
  const candidate = stripSafeGitGlobals(normalized);
  return allowlist.some(
    (prefix) => candidate === prefix || candidate.startsWith(`${prefix} `),
  );
}

/**
 * The fix policy verdict for one request. Allowed: read, search, think,
 * monad-checks tools, and edit/delete/move whose every location realpath
 * resolves inside the worktree. Allowlisted executes run without a human;
 * every other execute (git push included) forwards to the attached human
 * exactly as interactive does, and is held when nobody is attached.
 * An allowlisted prefix only counts on a single unchained command: anything
 * with shell control syntax outside quotes forwards, so `git push` cannot
 * ride in behind `git commit -m x &&`.
 */
export function decideFixPermission(
  params: RequestPermissionRequest,
  context: FixPolicyContext,
): PolicyVerdict {
  if (isMonadChecksTool(params)) {
    return { kind: "allow" };
  }
  const kind = params.toolCall?.kind ?? "other";
  switch (kind) {
    case "read":
    case "search":
    case "think":
      return { kind: "allow" };
    case "edit":
    case "delete":
    case "move": {
      const locations = params.toolCall?.locations ?? [];
      if (locations.length === 0) {
        // No locations means the boundary cannot be verified; a human decides.
        return { kind: "forward" };
      }
      const worktreeReal = realpathDeep(context.worktree);
      for (const location of locations) {
        if (!resolvesInsideWorktree(worktreeReal, location.path, context.worktree)) {
          return {
            kind: "reject",
            message:
              `${location.path} resolves outside the session worktree ${context.worktree}; ` +
              `${kind} was blocked by policy:fix`,
          };
        }
      }
      return { kind: "allow" };
    }
    case "execute": {
      const command = commandFromRawInput(params.toolCall?.rawInput);
      if (command !== undefined && matchesAllowlist(command, context.execAllowlist)) {
        return { kind: "allow" };
      }
      return { kind: "forward" };
    }
    case "fetch":
      return { kind: "reject", message: "fetch is blocked in fix mode by policy:fix" };
    case "switch_mode":
      return {
        kind: "reject",
        preferOptionId: PLAN_MODE_REJECT_OPTION_ID,
        message: "mode switches are blocked in fix mode by policy:fix",
      };
    default:
      return { kind: "forward" };
  }
}

/**
 * Picks the option a policy verdict maps to. Only allow_once and reject_once
 * are ever selected; when preferOptionId names an offered option of the
 * wanted kind (the ExitPlanMode "plan" option), it wins.
 */
export function selectPolicyOption(
  options: PermissionOption[],
  want: "allow_once" | "reject_once",
  preferOptionId?: string,
): PermissionOption | undefined {
  if (preferOptionId !== undefined) {
    const preferred = options.find(
      (option) => option.optionId === preferOptionId && option.kind === want,
    );
    if (preferred) {
      return preferred;
    }
  }
  return options.find((option) => option.kind === want);
}

/** What the mode-aware policy needs to know about a session to decide. */
export interface PolicySessionContext {
  mode: SessionMode;
  /** The session cwd; for review/fix sessions this is the worktree. */
  cwd: string;
}

export interface ModeAwarePolicyOptions {
  hooks: PermissionPolicyHooks;
  /** Resolves the session's mode and cwd at decision time (store lookup). */
  resolveContext: (sessionId: SessionId) => PolicySessionContext | undefined;
  /**
   * Runs before the first (and every) granted edit in a fix session; the
   * SessionManager uses it to lazily create the monad/fix/pr-N-sha branch.
   * Failures reject the edit rather than editing a detached worktree.
   */
  beforeEditGrant?: (sessionId: SessionId) => Promise<void>;
}

/**
 * The daemon's default policy: dispatches on the session's stored mode.
 * interactive forwards to the attached human (M1 behavior); review decides
 * everything itself; fix decides reads/edits/allowlisted executes and
 * forwards the rest to the human. Every decision lands in the log as
 * permission_resolved with by: policy:review / policy:fix / human.
 */
export class ModeAwarePermissionPolicy implements PermissionPolicy {
  private readonly hooks: PermissionPolicyHooks;
  private readonly resolveContext: ModeAwarePolicyOptions["resolveContext"];
  private readonly beforeEditGrant?: (sessionId: SessionId) => Promise<void>;
  private readonly interactive: InteractivePermissionPolicy;

  constructor(options: ModeAwarePolicyOptions) {
    this.hooks = options.hooks;
    this.resolveContext = options.resolveContext;
    this.beforeEditGrant = options.beforeEditGrant;
    // The interactive fallback must not double-log permission_requested:
    // this policy persists the request before dispatching.
    this.interactive = new InteractivePermissionPolicy(options.hooks, {
      skipPersistRequested: true,
    });
  }

  async request(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    client: PermissionClient | undefined,
  ): Promise<RequestPermissionResponse> {
    this.hooks.persistRequested(sessionId, params);
    const context = this.resolveContext(sessionId);
    const mode = context?.mode ?? "interactive";
    if (context && mode !== "interactive") {
      const verdict =
        mode === "review"
          ? decideReviewPermission(params)
          : decideFixPermission(params, {
              worktree: context.cwd,
              execAllowlist: fixExecAllowlist(context.cwd),
            });
      const by = mode === "review" ? ("policy:review" as const) : ("policy:fix" as const);
      if (verdict.kind === "allow") {
        if (mode === "fix" && this.beforeEditGrant && isEditKind(params)) {
          try {
            await this.beforeEditGrant(sessionId);
          } catch (error) {
            return this.respond(sessionId, params, by, "reject_once", undefined, [
              "could not prepare the fix branch, so the edit was not granted:",
              error instanceof Error ? error.message : String(error),
            ].join(" "));
          }
        }
        return this.respond(sessionId, params, by, "allow_once");
      }
      if (verdict.kind === "reject") {
        return this.respond(
          sessionId,
          params,
          by,
          "reject_once",
          verdict.preferOptionId,
          verdict.message,
        );
      }
      // forward: fall through to the interactive path below.
    }
    return this.interactive.request(sessionId, params, client);
  }

  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest | undefined {
    return this.interactive.deliverPending(sessionId, client);
  }

  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined {
    return this.interactive.pendingRequest(sessionId);
  }

  cancel(sessionId: SessionId): void {
    this.interactive.cancel(sessionId);
  }

  private respond(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    by: "policy:review" | "policy:fix",
    want: "allow_once" | "reject_once",
    preferOptionId?: string,
    message?: string,
  ): RequestPermissionResponse {
    const option = selectPolicyOption(params.options, want, preferOptionId);
    // A policy never picks allow_always or reject_always. When the wanted
    // once-kind is not offered at all, cancel the request rather than
    // escalate; the vendor treats cancelled as not granted.
    const response: RequestPermissionResponse = option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : CANCELLED;
    const meta = metaFor(
      by,
      params,
      response,
      option ? message : message ?? "no allow_once/reject_once option was offered",
    );
    this.hooks.persistResolved(sessionId, response, meta);
    return response;
  }
}

function isEditKind(params: RequestPermissionRequest): boolean {
  const kind = params.toolCall?.kind;
  return kind === "edit" || kind === "delete" || kind === "move";
}
