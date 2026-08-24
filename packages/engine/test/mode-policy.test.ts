import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { PermissionResolutionMeta } from "@aaroncx/protocol";
import {
  decideFixPermission,
  decideReviewPermission,
  editedExecAllowlistInputs,
  execAllowlistFromManifest,
  fixExecAllowlist,
  isExecAllowlistInput,
  ModeAwarePermissionPolicy,
  type PermissionClient,
  type PermissionPolicyHooks,
  type PolicySessionContext,
  realpathDeep,
  selectPolicyOption,
} from "../src/policy.ts";

const SESSION_ID = Bun.randomUUIDv7();

const ONCE_OPTIONS: PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function request(
  toolCall: Partial<ToolCallUpdate>,
  options: PermissionOption[] = ONCE_OPTIONS,
): RequestPermissionRequest {
  return {
    sessionId: SESSION_ID,
    toolCall: { toolCallId: "call-1", ...toolCall },
    options,
  };
}

/** The ExitPlanMode request shape from decision 0007: reject_once "plan" plus escalating allow_always options. */
function exitPlanModeRequest(): RequestPermissionRequest {
  return request({ title: "Ready to code?", kind: "switch_mode" }, [
    { optionId: "bypassPermissions", name: "Yes, bypass permissions", kind: "allow_always" },
    { optionId: "acceptEdits", name: "Yes, accept edits", kind: "allow_always" },
    { optionId: "default", name: "Yes, ask as usual", kind: "allow_once" },
    { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
  ]);
}

function checksToolRequest(): RequestPermissionRequest {
  return request({
    title: "mcp__monad-checks__run_checks",
    kind: "other",
    _meta: { claudeCode: { toolName: "mcp__monad-checks__run_checks" } },
  });
}

describe("decideReviewPermission", () => {
  test("allows read, search, think", () => {
    for (const kind of ["read", "search", "think"] as const) {
      expect(decideReviewPermission(request({ kind }))).toEqual({ kind: "allow" });
    }
  });

  test("allows any monad-checks tool regardless of kind", () => {
    expect(decideReviewPermission(checksToolRequest())).toEqual({ kind: "allow" });
  });

  test("rejects edit, delete, move, fetch", () => {
    for (const kind of ["edit", "delete", "move", "fetch"] as const) {
      const verdict = decideReviewPermission(request({ kind }));
      expect(verdict.kind).toBe("reject");
    }
  });

  test("rejects execute pointing at the checks tools", () => {
    const verdict = decideReviewPermission(
      request({ kind: "execute", rawInput: { command: "bun test" } }),
    );
    expect(verdict.kind).toBe("reject");
    if (verdict.kind === "reject") {
      expect(verdict.message).toContain("run_checks");
    }
  });

  test("rejects switch_mode preferring the plan option", () => {
    const verdict = decideReviewPermission(exitPlanModeRequest());
    expect(verdict).toMatchObject({ kind: "reject", preferOptionId: "plan" });
  });

  test("rejects other tools naming them", () => {
    const verdict = decideReviewPermission(
      request({ kind: "other", title: "mcp__somewhere__do_thing" }),
    );
    expect(verdict.kind).toBe("reject");
    if (verdict.kind === "reject") {
      expect(verdict.message).toContain("mcp__somewhere__do_thing");
    }
  });
});

describe("decideFixPermission", () => {
  function makeWorktree(): { worktree: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), "monad-fix-policy-"));
    const worktree = join(root, "wt");
    const outside = join(root, "outside");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(worktree, "inside.ts"), "export {};\n");
    writeFileSync(join(outside, "secrets.txt"), "keep out\n");
    return { worktree, outside };
  }

  function fixContext(worktree: string) {
    return { worktree, execAllowlist: fixExecAllowlist(worktree) };
  }

  test("allows an edit whose locations resolve inside the worktree", () => {
    const { worktree } = makeWorktree();
    const verdict = decideFixPermission(
      request({ kind: "edit", locations: [{ path: join(worktree, "inside.ts") }] }),
      fixContext(worktree),
    );
    expect(verdict).toEqual({ kind: "allow" });
  });

  test("allows an edit creating a new file under the worktree", () => {
    const { worktree } = makeWorktree();
    const verdict = decideFixPermission(
      request({ kind: "edit", locations: [{ path: join(worktree, "new-dir", "new.ts") }] }),
      fixContext(worktree),
    );
    expect(verdict).toEqual({ kind: "allow" });
  });

  test("rejects an edit escaping via ..", () => {
    const { worktree } = makeWorktree();
    const escapePath = join(worktree, "..", "outside", "secrets.txt");
    const verdict = decideFixPermission(
      request({ kind: "edit", locations: [{ path: escapePath }] }),
      fixContext(worktree),
    );
    expect(verdict.kind).toBe("reject");
    if (verdict.kind === "reject") {
      expect(verdict.message).toContain(escapePath);
    }
  });

  test("rejects an edit through a symlink pointing outside", () => {
    const { worktree, outside } = makeWorktree();
    const link = join(worktree, "sneaky");
    symlinkSync(join(outside, "secrets.txt"), link);
    const verdict = decideFixPermission(
      request({ kind: "edit", locations: [{ path: link }] }),
      fixContext(worktree),
    );
    expect(verdict.kind).toBe("reject");
  });

  test("rejects a multi-location edit when any path is outside", () => {
    const { worktree, outside } = makeWorktree();
    const verdict = decideFixPermission(
      request({
        kind: "edit",
        locations: [
          { path: join(worktree, "inside.ts") },
          { path: join(outside, "secrets.txt") },
        ],
      }),
      fixContext(worktree),
    );
    expect(verdict.kind).toBe("reject");
  });

  test("forwards an edit with no locations (boundary unverifiable)", () => {
    const { worktree } = makeWorktree();
    const verdict = decideFixPermission(request({ kind: "edit" }), fixContext(worktree));
    expect(verdict).toEqual({ kind: "forward" });
  });

  test("allows allowlisted git commands and the repo's scripts", () => {
    const { worktree } = makeWorktree();
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ scripts: { lint: "biome check .", test: "bun test" } }),
    );
    const context = fixContext(worktree);
    for (const command of ["git commit -m 'fix lint'", "git status", "bun run lint", "bun test"]) {
      const verdict = decideFixPermission(
        request({ kind: "execute", rawInput: { command } }),
        context,
      );
      expect(verdict).toEqual({ kind: "allow" });
    }
  });

  test("forwards git push and unknown commands", () => {
    const { worktree } = makeWorktree();
    for (const command of ["git push origin main", "git push", "rm -rf /", "curl example.com"]) {
      const verdict = decideFixPermission(
        request({ kind: "execute", rawInput: { command } }),
        fixContext(worktree),
      );
      expect(verdict).toEqual({ kind: "forward" });
    }
  });

  test("an allowlisted prefix cannot smuggle a second command past the human", () => {
    const { worktree } = makeWorktree();
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ scripts: { lint: "biome check .", test: "bun test" } }),
    );
    const context = fixContext(worktree);
    const smuggled = [
      "git commit -m x && git push",
      "git commit -m x; git push",
      "git add -A & git push origin main",
      "git status || git push",
      "git log | tee /tmp/leak",
      "git diff > /tmp/leak",
      "git show `git push`",
      'git commit -m "$(git push)"',
      "git status\ngit push",
      "bun run lint && git push",
      "git commit -m 'unterminated",
    ];
    for (const command of smuggled) {
      const verdict = decideFixPermission(
        request({ kind: "execute", rawInput: { command } }),
        context,
      );
      expect(verdict).toEqual({ kind: "forward" });
    }
  });

  test("quoted shell metacharacters stay a single allowlisted command", () => {
    const { worktree } = makeWorktree();
    const context = fixContext(worktree);
    for (const command of [
      "git commit -m 'fix(policy): shell control syntax'",
      'git commit -m "fix(policy): braces {and} pipes | inside quotes"',
      "git commit -m 'a && b'",
    ]) {
      const verdict = decideFixPermission(
        request({ kind: "execute", rawInput: { command } }),
        context,
      );
      expect(verdict).toEqual({ kind: "allow" });
    }
  });

  test("safe git global flags do not force a forward, unsafe ones still do", () => {
    // Observed live in M2 acceptance: the agent runs `git --no-pager diff`
    // constantly, and matching on the second token forwarded every one of
    // those reads to a human for no security gain.
    const { worktree } = makeWorktree();
    const context = fixContext(worktree);
    for (const command of [
      "git --no-pager diff",
      "git --no-pager diff -- src/config.ts",
      "git -P log --oneline -3",
      "git --no-pager --literal-pathspecs status",
    ]) {
      expect(
        decideFixPermission(request({ kind: "execute", rawInput: { command } }), context),
      ).toEqual({ kind: "allow" });
    }
    // -c can hand git a command to run, and -C / --git-dir / --work-tree
    // point it outside the worktree, so these must still reach a human even
    // though the subcommand after them is allowlisted.
    for (const command of [
      "git -c core.sshCommand=/tmp/evil fetch",
      "git -c alias.st=!/tmp/evil st",
      "git -c core.pager=/tmp/evil log",
      "git -C /etc status",
      "git --git-dir=/tmp/other/.git log",
      "git --work-tree=/ status",
      "git --exec-path=/tmp/evil diff",
    ]) {
      expect(
        decideFixPermission(request({ kind: "execute", rawInput: { command } }), context),
      ).toEqual({ kind: "forward" });
    }
  });

  test("git shorthand prefixes do not leak: gitk and git pushx are not allowlisted", () => {
    const { worktree } = makeWorktree();
    for (const command of ["gitk", "git statusx", "git diff-index"]) {
      const verdict = decideFixPermission(
        request({ kind: "execute", rawInput: { command } }),
        fixContext(worktree),
      );
      expect(verdict).toEqual({ kind: "forward" });
    }
  });

  test("allows monad-checks tools, rejects fetch and switch_mode", () => {
    const { worktree } = makeWorktree();
    const context = fixContext(worktree);
    expect(decideFixPermission(checksToolRequest(), context)).toEqual({ kind: "allow" });
    expect(decideFixPermission(request({ kind: "fetch" }), context).kind).toBe("reject");
    expect(decideFixPermission(exitPlanModeRequest(), context).kind).toBe("reject");
  });
});

describe("the frozen exec allowlist (finding 3)", () => {
  test("execAllowlistFromManifest names only the scripts the manifest has", () => {
    const allow = execAllowlistFromManifest(
      JSON.stringify({ scripts: { lint: "biome check .", test: "bun test" } }),
    );
    expect(allow).toContain("git commit");
    expect(allow).toContain("bun run lint");
    expect(allow).toContain("bun test");
    expect(allow).not.toContain("bun run build");
    expect(allow).not.toContain("bun run typecheck");
  });

  test("execAllowlistFromManifest degrades to the git prefixes, never wider", () => {
    for (const manifest of [undefined, "not json at all", "{}", JSON.stringify({ scripts: {} })]) {
      expect(execAllowlistFromManifest(manifest)).toEqual([
        "git status",
        "git diff",
        "git add",
        "git commit",
        "git log",
        "git show",
      ]);
    }
  });

  test("every execute forwards once the allowlist inputs were edited", () => {
    const worktree = mkdtempSync(join(tmpdir(), "monad-fix-edited-"));
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ scripts: { lint: "biome check .", test: "bun test" } }),
    );
    const context = {
      worktree,
      execAllowlist: fixExecAllowlist(worktree),
      execAllowlistInputsEdited: true,
    };
    for (const command of ["git status", "bun run lint", "bun test", "git commit -m x"]) {
      expect(
        decideFixPermission(request({ kind: "execute", rawInput: { command } }), context),
      ).toEqual({ kind: "forward" });
    }
    // Reads and in-worktree edits are untouched by the rule.
    expect(decideFixPermission(request({ kind: "read" }), context)).toEqual({ kind: "allow" });
  });

  test("isExecAllowlistInput matches the manifest and every lockfile by basename", () => {
    for (const path of [
      "package.json",
      "/a/b/package.json",
      "packages/engine/package.json",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]) {
      expect(isExecAllowlistInput(path)).toBe(true);
    }
    for (const path of ["src/package.json.ts", "README.md", "tsconfig.json", "lock.json"]) {
      expect(isExecAllowlistInput(path)).toBe(false);
    }
  });
});

describe("editedExecAllowlistInputs", () => {
  function requested(toolCall: Partial<ToolCallUpdate>) {
    return { kind: "permission_requested", payload: request(toolCall) };
  }
  function resolved(toolCallId: string, optionId: string) {
    return {
      kind: "permission_resolved",
      payload: { outcome: { outcome: "selected", optionId }, by: "policy:fix", toolCallId },
    };
  }

  test("a granted package.json edit counts", () => {
    expect(
      editedExecAllowlistInputs([
        requested({ kind: "edit", locations: [{ path: "/wt/package.json" }] }),
        resolved("call-1", "allow"),
      ]),
    ).toBe(true);
  });

  test("a granted source edit does not", () => {
    expect(
      editedExecAllowlistInputs([
        requested({ kind: "edit", locations: [{ path: "/wt/src/a.ts" }] }),
        resolved("call-1", "allow"),
      ]),
    ).toBe(false);
  });

  test("a rejected package.json edit does not, and an unresolved one does not yet", () => {
    const pending = requested({ kind: "edit", locations: [{ path: "/wt/package.json" }] });
    expect(editedExecAllowlistInputs([pending, resolved("call-1", "reject")])).toBe(false);
    expect(editedExecAllowlistInputs([pending])).toBe(false);
  });

  test("a granted edit with no locations counts: the target is unknowable", () => {
    expect(
      editedExecAllowlistInputs([requested({ kind: "edit" }), resolved("call-1", "allow")]),
    ).toBe(true);
  });

  test("a granted edit whose selected option is not in the request counts", () => {
    expect(
      editedExecAllowlistInputs([
        requested({ kind: "edit", locations: [{ path: "/wt/bun.lock" }] }),
        resolved("call-1", "some-option-nobody-offered"),
      ]),
    ).toBe(true);
  });

  test("executes and reads are not edits, whatever they name", () => {
    expect(
      editedExecAllowlistInputs([
        requested({ kind: "read", locations: [{ path: "/wt/package.json" }] }),
        resolved("call-1", "allow"),
        requested({ kind: "execute", rawInput: { command: "cat package.json" } }),
        resolved("call-1", "allow"),
      ]),
    ).toBe(false);
  });
});

describe("selectPolicyOption", () => {
  test("never selects allow_always or reject_always", () => {
    const options: PermissionOption[] = [
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "never", name: "Never", kind: "reject_always" },
    ];
    expect(selectPolicyOption(options, "allow_once")).toBeUndefined();
    expect(selectPolicyOption(options, "reject_once")).toBeUndefined();
  });

  test("prefers the named option when offered with the wanted kind", () => {
    const options = exitPlanModeRequest().options;
    expect(selectPolicyOption(options, "reject_once", "plan")?.optionId).toBe("plan");
  });
});

describe("realpathDeep", () => {
  test("resolves .. and missing leaf components", () => {
    const root = mkdtempSync(join(tmpdir(), "monad-realpath-"));
    const resolved = realpathDeep(join(root, "a", "..", "b", "missing.txt"));
    expect(resolved.endsWith(join("b", "missing.txt"))).toBe(true);
    expect(resolved.includes("..")).toBe(false);
  });
});

interface ResolvedLogEntry {
  response: RequestPermissionResponse;
  meta: PermissionResolutionMeta;
}

function makeModePolicy(context: PolicySessionContext, beforeEditGrant?: () => Promise<void>) {
  const requested: RequestPermissionRequest[] = [];
  const resolved: ResolvedLogEntry[] = [];
  const statuses: string[] = [];
  const hooks: PermissionPolicyHooks = {
    persistRequested: (_id, params) => {
      requested.push(params);
    },
    persistResolved: (_id, response, meta) => {
      resolved.push({ response, meta });
    },
    setStatus: (_id, status) => {
      statuses.push(status);
    },
  };
  const policy = new ModeAwarePermissionPolicy({
    hooks,
    resolveContext: () => context,
    beforeEditGrant: beforeEditGrant ? () => beforeEditGrant() : undefined,
  });
  return { policy, requested, resolved, statuses };
}

describe("ModeAwarePermissionPolicy", () => {
  test("review: rejects an edit with by policy:review, request logged once", async () => {
    const { policy, requested, resolved } = makeModePolicy({ mode: "review", cwd: "/tmp" });
    const response = await policy.request(SESSION_ID, request({ kind: "edit" }), undefined);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(requested).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.meta).toMatchObject({
      by: "policy:review",
      optionId: "reject",
      toolCallId: "call-1",
    });
  });

  test("review: allows a read and a monad-checks call without asking anyone", async () => {
    const { policy, resolved } = makeModePolicy({ mode: "review", cwd: "/tmp" });
    const askedClient: PermissionClient = {
      requestPermission: () => Promise.reject(new Error("must not be asked")),
    };
    const read = await policy.request(SESSION_ID, request({ kind: "read" }), askedClient);
    expect(read.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    const checks = await policy.request(SESSION_ID, checksToolRequest(), askedClient);
    expect(checks.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(resolved.map((entry) => entry.meta.by)).toEqual(["policy:review", "policy:review"]);
  });

  test("interactive: a monad-checks call is allowed without asking the human", async () => {
    // Live M2 acceptance criterion 6 caught this: only review and fix
    // auto-allowed the checks plane, so in a plain run session "run the
    // checks" went out for a keypress. With no interactive stdin the call
    // was cancelled outright and no checks ran.
    const { policy, resolved } = makeModePolicy({ mode: "interactive", cwd: "/tmp" });
    const askedClient: PermissionClient = {
      requestPermission: () => Promise.reject(new Error("must not be asked")),
    };
    const checks = await policy.request(SESSION_ID, checksToolRequest(), askedClient);
    expect(checks.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(resolved[0]?.meta).toMatchObject({ by: "policy:interactive", optionId: "allow" });
  });

  test("interactive: a non-checks tool still goes to the human", async () => {
    const { policy, resolved } = makeModePolicy({ mode: "interactive", cwd: "/tmp" });
    let asked = 0;
    const client: PermissionClient = {
      requestPermission: () => {
        asked += 1;
        return Promise.resolve({
          outcome: { outcome: "selected" as const, optionId: "allow" },
        });
      },
    };
    await policy.request(SESSION_ID, request({ kind: "edit" }), client);
    expect(asked).toBe(1);
    expect(resolved[0]?.meta.by).toBe("human");
  });

  test("review: answers ExitPlanMode with the reject_once plan option", async () => {
    const { policy, resolved } = makeModePolicy({ mode: "review", cwd: "/tmp" });
    const response = await policy.request(SESSION_ID, exitPlanModeRequest(), undefined);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "plan" });
    expect(resolved[0]?.meta.by).toBe("policy:review");
  });

  test("review: rejects an execute with the sanctioned-way message in the log", async () => {
    const { policy, resolved } = makeModePolicy({ mode: "review", cwd: "/tmp" });
    const response = await policy.request(
      SESSION_ID,
      request({ kind: "execute", rawInput: { command: "git log" } }),
      undefined,
    );
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(resolved[0]?.meta.message).toContain("run_checks");
  });

  test("fix: grants an in-worktree edit and runs beforeEditGrant first", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "monad-fix-grant-"));
    let granted = 0;
    const { policy, resolved } = makeModePolicy({ mode: "fix", cwd: worktree }, async () => {
      granted += 1;
    });
    const response = await policy.request(
      SESSION_ID,
      request({ kind: "edit", locations: [{ path: join(worktree, "a.ts") }] }),
      undefined,
    );
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(granted).toBe(1);
    expect(resolved[0]?.meta.by).toBe("policy:fix");
  });

  test("fix: a context with no frozen allowlist forwards every execute", async () => {
    // Default deny (record 0009): an M2 session row carries no frozen list,
    // and a context that cannot say whether package.json was edited answers
    // as if it was. Neither may end in an unattended execute, even though the
    // worktree's own package.json would have allowed this command in M2.
    const worktree = mkdtempSync(join(tmpdir(), "monad-fix-nolist-"));
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    const { policy, statuses } = makeModePolicy({ mode: "fix", cwd: worktree });
    const held = policy.request(
      SESSION_ID,
      request({ kind: "execute", rawInput: { command: "bun run test" } }),
      undefined,
    );
    await Bun.sleep(10);
    expect(statuses).toEqual(["waiting_for_permission"]);
    policy.cancel(SESSION_ID);
    expect((await held).outcome).toEqual({ outcome: "cancelled" });
  });

  test("fix: forwards git push to the attached human (answered by: human)", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "monad-fix-push-"));
    const { policy, resolved } = makeModePolicy({ mode: "fix", cwd: worktree });
    const asked: RequestPermissionRequest[] = [];
    const human: PermissionClient = {
      requestPermission: (params) => {
        asked.push(params);
        return Promise.resolve({ outcome: { outcome: "selected", optionId: "reject" } });
      },
    };
    const response = await policy.request(
      SESSION_ID,
      request({ kind: "execute", rawInput: { command: "git push origin main" } }),
      human,
    );
    expect(asked).toHaveLength(1);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(resolved[0]?.meta.by).toBe("human");
  });

  test("fix: holds git push with nobody attached", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "monad-fix-hold-"));
    const { policy, statuses, requested } = makeModePolicy({ mode: "fix", cwd: worktree });
    let settled = false;
    const held = policy
      .request(
        SESSION_ID,
        request({ kind: "execute", rawInput: { command: "git push" } }),
        undefined,
      )
      .then((response) => {
        settled = true;
        return response;
      });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(statuses).toEqual(["waiting_for_permission"]);
    expect(requested).toHaveLength(1); // Logged exactly once despite the forward.
    expect(policy.pendingRequest(SESSION_ID)).toBeDefined();

    policy.deliverPending(SESSION_ID, {
      requestPermission: () =>
        Promise.resolve({ outcome: { outcome: "selected", optionId: "allow" } }),
    });
    const response = await held;
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  test("interactive sessions keep M1 forwarding", async () => {
    const { policy, resolved } = makeModePolicy({ mode: "interactive", cwd: "/tmp" });
    const human: PermissionClient = {
      requestPermission: () =>
        Promise.resolve({ outcome: { outcome: "selected", optionId: "allow" } }),
    };
    const response = await policy.request(SESSION_ID, request({ kind: "edit" }), human);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(resolved[0]?.meta.by).toBe("human");
  });
});
