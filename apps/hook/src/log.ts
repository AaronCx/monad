import { describeDelivery, type DeliveryMeta } from "@aaroncx/github";
import type { DeliveryRow } from "./queue.ts";

/**
 * Logging, bounded by construction.
 *
 * Every line about a delivery is built from DeliveryMeta, which holds the
 * delivery id, the event, the action, the repository, and the PR number and
 * has no field a body, a token, or a private key could travel in. There is
 * deliberately no helper here that takes a payload.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function consoleLogger(prefix = "monad-hook"): Logger {
  return {
    info: (message) => console.log(`${prefix}: ${message}`),
    warn: (message) => console.warn(`${prefix}: ${message}`),
    error: (message) => console.error(`${prefix}: ${message}`),
  };
}

/** A logger that keeps its lines, for tests and for GET /healthz's tail. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

/** The log-safe projection of a queued row. */
export function describeRow(row: DeliveryRow): string {
  const meta: DeliveryMeta = {
    id: row.deliveryId,
    event: row.event,
    action: row.action,
    repo: row.repo,
    number: row.number,
  };
  return describeDelivery(meta);
}
