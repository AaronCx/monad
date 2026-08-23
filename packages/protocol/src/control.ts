import { z } from "zod";
import { BackendIdSchema, SessionIdSchema, SessionRecordSchema } from "./session.ts";

/**
 * The control API covers what ACP does not: cross-repo session listing and
 * daemon introspection. In M1 it is plain JSON over HTTP on the same port as
 * the ACP endpoint: GET /v1/sessions and GET /v1/status. ACP traffic is on
 * /acp. Both require the bearer token.
 */

/** Response of GET /v1/sessions. */
export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionRecordSchema),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/** One live vendor backend process owned by the daemon. */
export const ActiveBackendSchema = z.object({
  sessionId: SessionIdSchema,
  backend: BackendIdSchema,
});
export type ActiveBackend = z.infer<typeof ActiveBackendSchema>;

/** Response of GET /v1/status. */
export const DaemonStatusSchema = z.object({
  version: z.string(),
  startedAt: z.iso.datetime(),
  uptimeMs: z.number().int().nonnegative(),
  activeBackends: z.array(ActiveBackendSchema),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/**
 * Contents of ~/.monad/monadd.json, written by the daemon on startup and
 * read by the CLI to discover a running daemon.
 */
export const DaemonInfoSchema = z.object({
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;
