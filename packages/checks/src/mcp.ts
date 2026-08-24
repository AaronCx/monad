import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { listChecks, runChecks } from "./api";
import { loadConfig } from "./config/loader";
import { deepMerge } from "./config/merge";
import { detectDefaultBranch, diffBetween } from "./git/diff";
import { formatChecksMarkdown } from "./render";
import type { ChangedFile, CheckType, PipelineConfig } from "./types";

/**
 * The per-session MCP surface of the checks engine: three tools bound to one
 * session's worktree and diff, served over the MCP SDK's Streamable HTTP
 * transport in stateless mode.
 *
 * Server contract proven by spike 0a (decision record 0006):
 * - stateless per-request transports: a fresh StreamableHTTPServerTransport
 *   (sessionIdGenerator undefined) plus a fresh Server per POST;
 * - the vendor's MCP client opens with a nonstandard `server/discover` POST,
 *   which gets a normal JSON-RPC method-not-found error;
 * - a standalone GET (SSE stream attempt) is answered 405 and tolerated.
 *
 * Tools are registered through the low-level Server API with JSON Schema
 * literals, not McpServer.registerTool: the zod-generic inference behind
 * registerTool blows up tsc under this package's zod 3 (type-level v3/v4
 * compat explosion, tsc OOM), and three hand-dispatched tools do not need it.
 *
 * Authentication is NOT handled here: the daemon mounts handleRequest behind
 * the same bearer check as /acp (decision record 0006, fact 9).
 */

export interface ChecksMcpBinding {
  /** The session's worktree or repo root; every check runs here. */
  cwd: string;
  /**
   * Diff bounds for review sessions. When absent (interactive sessions) the
   * diff is computed at call time against the repo's default-branch
   * merge-base.
   */
  base?: string;
  head?: string;
  /** Per-session config override, merged over the repo's loaded config. */
  config?: Partial<PipelineConfig>;
  /** monad's session id, for logging and mount-path construction. */
  sessionId: string;
}

export interface ChecksMcpServer {
  binding: ChecksMcpBinding;
  /** Serves one HTTP request. Mount behind the daemon's bearer check. */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

const CHECK_TYPE_VALUES: readonly CheckType[] = [
  "secrets",
  "file_patterns",
  "lint",
  "typecheck",
  "build",
  "test",
  "dependencies",
  "agent_patterns",
];

const TOOL_DEFINITIONS = [
  {
    name: "run_checks",
    description:
      "Run the repo's configured deterministic checks (secrets, file patterns, lint, " +
      "typecheck, build, test, dependencies, agent patterns) against this session's diff. " +
      "Returns the full CheckRunResults as structured JSON plus a compact markdown table.",
    inputSchema: {
      type: "object" as const,
      properties: {
        only: {
          type: "array",
          items: { type: "string", enum: [...CHECK_TYPE_VALUES] },
          description: "Restrict the run to these checks.",
        },
        profile: {
          type: "string",
          enum: ["fast", "full"],
          description: "fast (default) skips build and test; full runs everything enabled.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        checks: { type: "array" },
        hasFailures: { type: "boolean" },
        hasWarnings: { type: "boolean" },
        failureCount: { type: "number" },
        warningCount: { type: "number" },
        summary: { type: "string" },
        annotations: { type: "array" },
        meta: { type: "object" },
      },
      required: ["checks", "hasFailures", "summary", "annotations", "meta"],
    },
  },
  {
    name: "list_checks",
    description:
      "List every known check with its effective enabled flag, severity, and run profile " +
      "under this repo's configuration, plus where the configuration came from.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object" as const,
      properties: {
        checks: { type: "array" },
        source: { type: "string" },
      },
      required: ["checks", "source"],
    },
  },
  {
    name: "check_config",
    description:
      "The effective checks configuration for this session (repo file merged with any " +
      "session override), its source, and any loader warnings.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object" as const,
      properties: {
        config: { type: "object" },
        source: { type: "string" },
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["config", "source", "warnings"],
    },
  },
];

interface EffectiveConfig {
  config: PipelineConfig;
  source: string;
  warnings: string[];
}

async function resolveConfig(binding: ChecksMcpBinding): Promise<EffectiveConfig> {
  const loaded = await loadConfig(binding.cwd);
  const config = binding.config
    ? (deepMerge(
        loaded.config as unknown as Record<string, unknown>,
        binding.config as Record<string, unknown>,
      ) as unknown as PipelineConfig)
    : loaded.config;
  return { config, source: loaded.source, warnings: loaded.warnings };
}

/**
 * The session's diff: exactly base..head when the binding pins them (review
 * sessions), otherwise HEAD against the default-branch merge-base, computed
 * fresh on every call so interactive sessions see their latest commits.
 * Returns the bounds too so agent_patterns gets its commit range.
 */
async function resolveDiff(
  binding: ChecksMcpBinding,
): Promise<{ files: ChangedFile[]; base?: string; head?: string }> {
  if (binding.base && binding.head) {
    return {
      files: await diffBetween(binding.base, binding.head, binding.cwd),
      base: binding.base,
      head: binding.head,
    };
  }
  const branch = await detectDefaultBranch(binding.cwd);
  if (!branch) {
    return { files: [] };
  }
  const { execFile } = await import("node:child_process");
  const mergeBase = await new Promise<string | undefined>((resolve) => {
    execFile("git", ["merge-base", branch, "HEAD"], { cwd: binding.cwd }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
  if (!mergeBase) {
    return { files: [] };
  }
  return {
    files: await diffBetween(mergeBase, "HEAD", binding.cwd),
    base: mergeBase,
    head: "HEAD",
  };
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

function parseRunChecksArgs(args: Record<string, unknown> | undefined): {
  only?: CheckType[];
  profile?: "fast" | "full";
} {
  const result: { only?: CheckType[]; profile?: "fast" | "full" } = {};
  if (args?.only !== undefined) {
    if (
      !Array.isArray(args.only) ||
      !args.only.every(
        (item): item is CheckType =>
          typeof item === "string" && (CHECK_TYPE_VALUES as readonly string[]).includes(item),
      )
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `only must be an array of check names (${CHECK_TYPE_VALUES.join(", ")})`,
      );
    }
    result.only = args.only;
  }
  if (args?.profile !== undefined) {
    if (args.profile !== "fast" && args.profile !== "full") {
      throw new McpError(ErrorCode.InvalidParams, 'profile must be "fast" or "full"');
    }
    result.profile = args.profile;
  }
  return result;
}

async function callTool(
  binding: ChecksMcpBinding,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case "run_checks": {
      const { only, profile } = parseRunChecksArgs(args);
      const { config } = await resolveConfig(binding);
      const diff = await resolveDiff(binding);
      const results = await runChecks({
        cwd: binding.cwd,
        files: diff.files,
        base: diff.base,
        head: diff.head,
        config,
        profile,
        only,
      });
      return {
        content: [{ type: "text", text: formatChecksMarkdown(results) }],
        structuredContent: results as unknown as Record<string, unknown>,
      };
    }
    case "list_checks": {
      const { config, source } = await resolveConfig(binding);
      const checks = listChecks(config);
      const lines = checks.map(
        (c) =>
          `${c.key}: ${c.enabled ? "enabled" : "disabled"}, severity ${c.severity}, profile ${c.profile}`,
      );
      return {
        content: [{ type: "text", text: [`config source: ${source}`, ...lines].join("\n") }],
        structuredContent: { checks, source } as unknown as Record<string, unknown>,
      };
    }
    case "check_config": {
      const effective = await resolveConfig(binding);
      const structured = {
        config: effective.config as unknown,
        source: effective.source,
        warnings: effective.warnings,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured as Record<string, unknown>,
      };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

function buildServer(binding: ChecksMcpBinding): Server {
  const server = new Server(
    { name: "monad-checks", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callTool(
      binding,
      request.params.name,
      request.params.arguments as Record<string, unknown> | undefined,
    );
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isDiscoverRequest(body: unknown): body is { id: number | string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "server/discover" &&
    "id" in body
  );
}

/**
 * Builds the session-bound checks MCP server. The returned handleRequest is
 * a plain node:http handler; the daemon mounts it at /mcp/<sessionId> behind
 * its bearer check.
 */
export function createChecksMcpServer(binding: ChecksMcpBinding): ChecksMcpServer {
  return {
    binding,
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "POST") {
        // Standalone GET SSE streams (and DELETE) are not supported by a
        // stateless server; spike 0a showed the vendor tolerates the 405.
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed; POST JSON-RPC only" }));
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      // The vendor's MCP client opens with a nonstandard server/discover
      // POST; answer it with a normal method-not-found error (spike 0a).
      if (isDiscoverRequest(parsedBody)) {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: parsedBody.id,
          error: { code: -32601, message: "Method not found: server/discover" },
        });
        return;
      }
      // Stateless contract: fresh transport and server per request, torn
      // down when the response closes.
      const server = buildServer(binding);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    },
  };
}
