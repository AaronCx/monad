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
   * Offers every held request for the session to a newly attached client,
   * oldest first, and returns them in that order (empty when there was
   * nothing to deliver). The client answers them one at a time; first answer
   * wins per request if several clients see the same one.
   */
  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest[];

  /** The OLDEST held request for a session, if any. */
  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined;

  /** Every held request for a session, oldest first. */
  pendingRequests(sessionId: SessionId): RequestPermissionRequest[];

  /** Resolves every held request with a cancelled outcome (session/cancel). */
  cancel(sessionId: SessionId): void;
}

interface PendingPermission {
  /**
   * The key this request is held under inside its session's map: the ACP
   * toolCallId when the request has one, otherwise a synthetic id minted
   * here. Also what lands in the resolution's meta.toolCallId, so a request
   * with no id of its own still has SOMETHING to join a transcript on.
   */
  key: string;
  params: RequestPermissionRequest;
  settled: boolean;
  resolve: (response: RequestPermissionResponse) => void;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/**
 * Builds the resolution metadata. `fallbackToolCallId` is used only when the
 * request carries no toolCallId of its own: the pending map's synthetic key
 * goes in instead, so a resolution is never left with nothing to join on.
 * The request's REAL id always wins, because dropping it would break the
 * permission_requested to permission_resolved join that
 * editedExecAllowlistInputs relies on.
 */
function metaFor(
  by: PermissionResolutionMeta["by"],
  params: RequestPermissionRequest,
  response: RequestPermissionResponse,
  message?: string,
  fallbackToolCallId?: string,
): PermissionResolutionMeta {
  const meta: PermissionResolutionMeta = { by };
  if (response.outcome.outcome === "selected") {
    meta.optionId = response.outcome.optionId;
  }
  const toolCallId = params.toolCall?.toolCallId || fallbackToolCallId;
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
 *
 * A session holds MANY requests at once, keyed by toolCallId. Claude issues
 * tool calls in parallel, so two forwards can be in flight inside one turn
 * (two non-allowlisted executes in fix mode, two edits with no locations);
 * M2 kept a single slot per session and threw a JSON-RPC error back at the
 * vendor mid-turn for the second one. Nothing is ever dropped to make room:
 * a request with no toolCallId, or one whose id collides with a request
 * already held, gets a synthetic key and is held like any other, because
 * dropping a permission request means the vendor never hears an answer.
 */
export class InteractivePermissionPolicy implements PermissionPolicy {
  private readonly hooks: PermissionPolicyHooks;
  /** sessionId to (pending key to request), each map in arrival order. */
  private readonly pending = new Map<SessionId, Map<string, PendingPermission>>();
  private syntheticKeys = 0;
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
    const held = this.holdFor(sessionId);
    // Only the FIRST hold moves the session; a second concurrent request
    // finds it already waiting_for_permission and leaves it there.
    if (held.size === 0) {
      this.hooks.setStatus(sessionId, "waiting_for_permission");
    }
    const key = this.keyFor(params, held);
    return new Promise<RequestPermissionResponse>((resolve) => {
      held.set(key, { key, params, settled: false, resolve });
    });
  }

  deliverPending(
    sessionId: SessionId,
    client: PermissionClient,
  ): RequestPermissionRequest[] {
    const held = this.pending.get(sessionId);
    if (!held) {
      return [];
    }
    // Snapshot first: settling mutates the map while this iterates, and an
    // answer can land synchronously.
    const entries = [...held.values()].filter((entry) => !entry.settled);
    for (const entry of entries) {
      client
        .requestPermission(entry.params)
        .then((response) => {
          this.settle(sessionId, entry, response, "running");
        })
        .catch(() => {
          // This client vanished too; the request stays held for the next one.
        });
    }
    return entries.map((entry) => entry.params);
  }

  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined {
    return this.pendingRequests(sessionId)[0];
  }

  pendingRequests(sessionId: SessionId): RequestPermissionRequest[] {
    const held = this.pending.get(sessionId);
    if (!held) {
      return [];
    }
    return [...held.values()].filter((entry) => !entry.settled).map((entry) => entry.params);
  }

  cancel(sessionId: SessionId): void {
    const held = this.pending.get(sessionId);
    if (!held) {
      return;
    }
    // Status is left to the caller: session/cancel ends the turn and the
    // manager sets the session idle.
    this.pending.delete(sessionId);
    for (const entry of held.values()) {
      if (entry.settled) {
        continue;
      }
      entry.settled = true;
      this.hooks.persistResolved(
        sessionId,
        CANCELLED,
        metaFor("human", entry.params, CANCELLED, "cancelled", entry.key),
      );
      entry.resolve(CANCELLED);
    }
  }

  /** The session's pending map, created on first use. */
  private holdFor(sessionId: SessionId): Map<string, PendingPermission> {
    const existing = this.pending.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, PendingPermission>();
    this.pending.set(sessionId, created);
    return created;
  }

  /**
   * The key one request is held under. The ACP toolCallId when there is one
   * and it is free; otherwise a synthetic id, which keeps a request with no
   * id (or a duplicate one) held rather than evicting the request it would
   * have collided with. The synthetic id is unique within this daemon run and
   * is written into the resolution meta, so the transcript can still tell two
   * anonymous requests apart.
   */
  private keyFor(
    params: RequestPermissionRequest,
    held: Map<string, PendingPermission>,
  ): string {
    const toolCallId = params.toolCall?.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0 && !held.has(toolCallId)) {
      return toolCallId;
    }
    this.syntheticKeys += 1;
    return `monad-pending-${this.syntheticKeys}`;
  }

  private settle(
    sessionId: SessionId,
    entry: PendingPermission,
    response: RequestPermissionResponse,
    status: "running",
  ): void {
    const held = this.pending.get(sessionId);
    if (entry.settled || held?.get(entry.key) !== entry) {
      return; // Another client answered first, or the session was cancelled.
    }
    entry.settled = true;
    held.delete(entry.key);
    if (held.size === 0) {
      this.pending.delete(sessionId);
    }
    this.hooks.persistResolved(
      sessionId,
      response,
      metaFor("human", entry.params, response, undefined, entry.key),
    );
    // Back to running only once the LAST held request has been answered;
    // with others still held the session stays waiting_for_permission.
    if (held.size === 0) {
      this.hooks.setStatus(sessionId, status);
    }
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
 * The tool name for DISPLAY: what monad shows a human and puts in a rejection
 * message. UNTRUSTED, because when no vendor-set name is available it falls
 * back to `title`, which the vendor derives from the call itself and which
 * for shell tools is the command the model wrote
 * (verified: a `git push ...` permission request arrives with that whole
 * command line as its title). A model can therefore put any string here, so
 * this value may never decide anything. Use permissionToolNameTrusted for
 * decisions (decision record 0009: the worktree is untrusted, and so is
 * everything the model writes).
 */
export function permissionToolName(params: RequestPermissionRequest): string | undefined {
  const trusted = permissionToolNameTrusted(params);
  if (trusted !== undefined) {
    return trusted;
  }
  const title = params.toolCall?.title;
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

/**
 * The tool name monad is willing to DECIDE on. Only sources the vendor fills
 * in are consulted; nothing the model can write reaches this function.
 *
 * Two sources, both vendor-set, measured against adapter claude-agent-acp
 * 0.70.0 on 2026-08-24 (see decision record 0006):
 *
 * 1. `toolCall._meta.claudeCode.toolName`. Documented, and what tool_call
 *    session updates always carry. On a `session/request_permission` the
 *    adapter attaches it ONLY when the call came from a sub-agent
 *    (`...(parentToolUseId ? { _meta: { claudeCode: { toolName,
 *    parentToolUseId } } } : {})` in acp-agent.js), so a top-level call has
 *    no `_meta` at all. Every permission request in this machine's event log
 *    confirms it: none of them carries one.
 * 2. The permission rule the vendor offers to persist, on its own
 *    `allow_always` option: `option._meta.permission.changes[].targets[]`
 *    with `type: "tool"` carries the real tool name
 *    (`permissionMetadataForAlwaysAllow(suggestions, toolName)`). It is built
 *    from the vendor's tool name, not from the model's input: the live
 *    `git push` request above offers `toolName: "Bash"` while its title is
 *    the command, and the live `run_checks` request offers
 *    `mcp__monad-checks__run_checks`.
 *
 * Default deny: no source, a malformed target, or two targets naming
 * different tools all return undefined, and an undefined name is not a monad
 * tool.
 */
export function permissionToolNameTrusted(
  params: RequestPermissionRequest,
): string | undefined {
  const meta = params.toolCall?._meta as
    | { claudeCode?: { toolName?: unknown } }
    | null
    | undefined;
  const metaName = meta?.claudeCode?.toolName;
  if (typeof metaName === "string" && metaName.length > 0) {
    return metaName;
  }
  return toolNameFromPermissionRules(params);
}

/** One `targets[]` entry of a vendor permission-rule change. */
interface PermissionRuleTarget {
  type?: unknown;
  toolName?: unknown;
}

/**
 * The tool name the vendor's own "always allow" rule would name, when every
 * rule target in the request agrees on one. Disagreement or a malformed
 * target yields undefined rather than a guess.
 */
function toolNameFromPermissionRules(
  params: RequestPermissionRequest,
): string | undefined {
  let found: string | undefined;
  for (const option of params.options ?? []) {
    const meta = option._meta as
      | { permission?: { changes?: { targets?: PermissionRuleTarget[] }[] } }
      | null
      | undefined;
    const changes = meta?.permission?.changes;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      const targets = change?.targets;
      if (!Array.isArray(targets)) {
        continue;
      }
      for (const target of targets) {
        if (target?.type !== "tool") {
          continue;
        }
        const name = target.toolName;
        if (typeof name !== "string" || name.length === 0) {
          return undefined; // Malformed: monad does not know what this is.
        }
        if (found !== undefined && found !== name) {
          return undefined; // Two tools named: ambiguous, so deny.
        }
        found = name;
      }
    }
  }
  return found;
}

const MONAD_CHECKS_TOOL_PREFIX = "mcp__monad-checks__";

/**
 * The complete set of tools the monad-checks MCP server serves. The suffix
 * after the prefix must be one of these: a name monad does not serve is not
 * monad's tool, whoever is claiming it.
 */
const MONAD_CHECKS_TOOL_NAMES = new Set(["run_checks", "list_checks", "check_config"]);

/**
 * Tool call kinds an MCP call can arrive as. The adapter maps every tool it
 * does not know by name (which is every `mcp__server__tool`) through
 * `toolInfoFromToolUse`'s default branch to `kind: "other"`, and all three
 * live monad-checks permission requests in this machine's event log are
 * `other`, as was the `ping_check` capture in decision record 0006. `fetch`
 * is tolerated so a future adapter that classifies fetch-shaped MCP tools
 * does not break the checks plane; `execute` and `edit` are not, which is
 * what stops a shell call from being mistaken for a checks call.
 */
const MCP_TOOL_CALL_KINDS = new Set(["other", "fetch"]);
/** The by-stamp for a decision a policy made in the given mode. */
function byForMode(
  mode: SessionMode,
): "policy:interactive" | "policy:review" | "policy:fix" {
  if (mode === "review") {
    return "policy:review";
  }
  if (mode === "fix") {
    return "policy:fix";
  }
  return "policy:interactive";
}

/**
 * True only for a call monad can prove is one of its own checks tools. Every
 * mode allows these unconditionally, ahead of mode dispatch, so identity here
 * has to be trustworthy: three conditions, all of them from the vendor.
 *
 * 1. The kind is one an MCP call actually arrives as. A shell call is
 *    `execute` and can never pass, however it is titled.
 * 2. The name comes from permissionToolNameTrusted, never from `title`.
 * 3. The suffix after `mcp__monad-checks__` is a tool monad actually serves.
 *
 * Any of the three failing means this is not a monad tool, and the request
 * falls through to the mode's own policy, which is the denying direction.
 *
 * Note the server NAME is not proof of origin on its own: a session inherits
 * the user's global `~/.claude` configuration (decision record 0006 fact 8),
 * so a user MCP server also called monad-checks would produce the same
 * prefix. The suffix set narrows that to three read-only tools of monad's
 * own design, and the checks mount itself is authenticated separately.
 */
export function isMonadChecksTool(params: RequestPermissionRequest): boolean {
  const kind = params.toolCall?.kind;
  if (typeof kind !== "string" || !MCP_TOOL_CALL_KINDS.has(kind)) {
    return false;
  }
  const name = permissionToolNameTrusted(params);
  if (name === undefined || !name.startsWith(MONAD_CHECKS_TOOL_PREFIX)) {
    return false;
  }
  return MONAD_CHECKS_TOOL_NAMES.has(name.slice(MONAD_CHECKS_TOOL_PREFIX.length));
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
   *
   * Frozen once at fix-mode entry from a trusted source (the PR base commit)
   * and passed in. It is NEVER recomputed from the worktree mid-session: the
   * worktree is what the agent is editing, so deriving a permission from it
   * lets the agent widen its own permissions (decision record 0009).
   */
  execAllowlist: string[];
  /**
   * True when the session has already been granted an edit to package.json or
   * a lockfile, or when what a granted edit touched cannot be determined. The
   * frozen allowlist names SCRIPTS, not the command lines they run, so once
   * package.json is writable by the agent `bun run test` no longer means what
   * it meant when the list was frozen. Every execute forwards to the human
   * from that point on, whatever the allowlist says.
   */
  execAllowlistInputsEdited?: boolean;
}

/**
 * `git commit` is on the allowlist, and git commit runs the repo's hooks
 * (`.git/hooks`, or wherever `core.hooksPath` points). That is safe under
 * monad's CURRENT worktree layout and only under it: a fix session works in a
 * detached worktree whose `.git` is a file pointing at
 * `<main repo>/.git/worktrees/<name>`, so both the hooks directory and the
 * config that could repoint it live OUTSIDE the session worktree, where the
 * fix policy rejects every edit. The agent can commit but cannot install a
 * hook, and the hooks it triggers are the user's own.
 *
 * If the worktree layout ever changes so that a session can write inside its
 * own `.git` (an in-place checkout, a bare clone per session, a container
 * mount that includes the git dir), this entry becomes arbitrary code
 * execution and must be revisited: either drop `git commit` from the list or
 * gate it on the hooks directory resolving outside the worktree.
 *
 * On `--no-verify`: monad deliberately does NOT add it implicitly, and cannot.
 * A permission response carries an optionId, nothing else (see
 * RequestPermissionResponse); there is no channel in ACP for answering a
 * permission request with a REWRITTEN command, and the vendor runs the string
 * it already holds. Rewriting would also mean the event log shows one command
 * while another ran, which destroys the property that the transcript is what
 * happened. The agent may pass `--no-verify` itself and it still matches the
 * `git commit` prefix, so the safer spelling is available without monad
 * forging it.
 */
const FIX_GIT_ALLOWLIST = ["git status", "git diff", "git add", "git commit", "git log", "git show"];

/**
 * The execute allowlist for a fix session, derived from one package.json:
 * the fixed git prefixes plus `<runner> run <script>` for each of the repo's
 * lint/typecheck/test/build scripts (and the bare `bun test` / `npm test`
 * shorthands when a test script exists).
 *
 * Pass the manifest read from a TRUSTED source. For a review-derived fix
 * session that is `git show <baseSha>:package.json`, the last state a repo
 * maintainer approved; undefined (no manifest, or unparseable) yields the git
 * prefixes alone, which is the safe direction.
 */
export function execAllowlistFromManifest(manifest: string | undefined): string[] {
  const allow = [...FIX_GIT_ALLOWLIST];
  let scripts: Record<string, unknown> = {};
  if (manifest === undefined) {
    return allow;
  }
  try {
    const parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
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

/**
 * The allowlist derived from the worktree's own package.json. This is a
 * TRUSTED-ONLY path: the SessionManager uses it as the fallback for an
 * interactive session in a repo the user owns that switched to fix mode, and
 * for nothing else. A review-derived session reads the base commit instead,
 * because its worktree is the PR (decision record 0009).
 */
export function fixExecAllowlist(worktree: string): string[] {
  let manifest: string | undefined;
  try {
    manifest = readFileSync(join(worktree, "package.json"), "utf8");
  } catch {
    manifest = undefined;
  }
  return execAllowlistFromManifest(manifest);
}

/**
 * Files that decide what an allowlisted `<runner> run <script>` actually
 * executes: the manifest holding the script bodies, and the lockfiles that
 * decide which dependency code a script pulls in. Matched by basename, so a
 * nested workspace manifest counts too; that is stricter than necessary and
 * deliberately so.
 */
const EXEC_ALLOWLIST_INPUT_FILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** True when this path is one of the files the exec allowlist depends on. */
export function isExecAllowlistInput(path: string): boolean {
  return EXEC_ALLOWLIST_INPUT_FILES.has(basename(path));
}

/**
 * Reconstructs, from a session's permission events, whether a granted edit
 * has touched a file the exec allowlist depends on. Feed it the session's
 * permission_requested and permission_resolved events in seq order; nothing
 * else in the log is needed, so this holds no state of its own.
 *
 * Default deny in three places: an edit with no locations counts (the target
 * is unknown, so it may have been package.json), a resolution monad cannot
 * match back to its request counts, and a selected option monad cannot find
 * in the request's options counts. A pending request does not count, because
 * it has not happened yet.
 */
export function editedExecAllowlistInputs(
  events: { kind: string; payload: unknown }[],
): boolean {
  const requests: { toolCallId?: string; params: RequestPermissionRequest }[] = [];
  const resolutions = new Map<string, { outcome?: string; optionId?: string }>();
  for (const event of events) {
    if (event.kind === "permission_requested") {
      const params = event.payload as RequestPermissionRequest | null;
      if (params?.toolCall === undefined) {
        continue;
      }
      const toolCallId = params.toolCall.toolCallId;
      requests.push({
        toolCallId: typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined,
        params,
      });
      continue;
    }
    if (event.kind !== "permission_resolved") {
      continue;
    }
    const payload = event.payload as
      | { outcome?: { outcome?: string; optionId?: string }; toolCallId?: string }
      | null
      | undefined;
    const toolCallId = payload?.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      resolutions.set(toolCallId, {
        outcome: payload?.outcome?.outcome,
        optionId: payload?.outcome?.optionId,
      });
    }
  }
  for (const { toolCallId, params } of requests) {
    if (!isEditKind(params)) {
      continue;
    }
    const locations = params.toolCall?.locations ?? [];
    const touchesInputs =
      locations.length === 0 || locations.some((location) => isExecAllowlistInput(location.path));
    if (!touchesInputs) {
      continue;
    }
    if (toolCallId === undefined) {
      return true; // No id to match a resolution by: assume it was granted.
    }
    const resolution = resolutions.get(toolCallId);
    if (!resolution) {
      continue; // Never resolved: still pending, so it has not happened.
    }
    if (resolution.outcome !== "selected") {
      continue; // Cancelled or refused outright.
    }
    const option = params.options.find((entry) => entry.optionId === resolution.optionId);
    if (option === undefined || option.kind.startsWith("allow")) {
      return true; // Granted, or granted-or-not is unknowable: deny.
    }
  }
  return false;
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
 * The allowlist is frozen input, never read from the worktree here, and it
 * stops applying entirely once the session has edited package.json or a
 * lockfile (decision record 0009).
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
      if (context.execAllowlistInputsEdited) {
        // package.json or a lockfile has been edited in this session, so the
        // frozen allowlist no longer describes what its entries run. Every
        // execute goes to a human from here (decision record 0009).
        return { kind: "forward" };
      }
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
  /**
   * The fix policy's execute allowlist as frozen on the session record at
   * fix-mode entry (decision record 0009). Absent means no list was frozen,
   * which is read as an empty one: default deny, every execute forwards.
   */
  execAllowlist?: string[];
  /**
   * Whether the session has been granted an edit to package.json or a
   * lockfile (or one whose target is unknown). Absent is read as true, so a
   * context that cannot answer the question forwards executes rather than
   * allowing them.
   */
  execAllowlistInputsEdited?: boolean;
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
    if (isMonadChecksTool(params)) {
      // The checks plane is monad's own tool surface, so every policy allows
      // it unconditionally. Interactive sessions included: without this, a
      // plain "run the checks" needs a human keypress, and a scripted or
      // detached session cancels the call outright.
      return this.respond(sessionId, params, byForMode(mode), "allow_once");
    }
    if (context && mode !== "interactive") {
      const verdict =
        mode === "review"
          ? decideReviewPermission(params)
          : decideFixPermission(params, {
              worktree: context.cwd,
              // Frozen on the record at fix-mode entry, never recomputed from
              // the worktree the agent is editing (decision record 0009).
              // Both fields default to the denying answer.
              execAllowlist: context.execAllowlist ?? [],
              execAllowlistInputsEdited: context.execAllowlistInputsEdited ?? true,
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
  ): RequestPermissionRequest[] {
    return this.interactive.deliverPending(sessionId, client);
  }

  pendingRequest(sessionId: SessionId): RequestPermissionRequest | undefined {
    return this.interactive.pendingRequest(sessionId);
  }

  pendingRequests(sessionId: SessionId): RequestPermissionRequest[] {
    return this.interactive.pendingRequests(sessionId);
  }

  cancel(sessionId: SessionId): void {
    this.interactive.cancel(sessionId);
  }

  private respond(
    sessionId: SessionId,
    params: RequestPermissionRequest,
    by: "policy:interactive" | "policy:review" | "policy:fix",
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
