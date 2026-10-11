import type { PromptRequest } from "@agentclientprotocol/sdk";
import {
  type EventRecord,
  PEER_META_KEY,
  type PeerMessagePayload,
  PeerMessagePayloadSchema,
  type PeerPromptMeta,
  PeerPromptMetaSchema,
  type SessionId,
} from "@aaroncx/protocol";

/**
 * Peer delivery helpers (monad Link, decision record 0012). A peer message is
 * only ever a prompt: it reaches the target as the text of an ordinary turn,
 * under a provenance header the daemon writes, and nothing else. There is no
 * path from here to a permission answer, a mode switch or a policy.
 */

/**
 * Matches a provenance header line (provenanceHeader, HUMAN_PROVENANCE_HEADER).
 * It says who sent a message, not what was asked, so a derived title
 * (indexer.ts) and a handoff's quoted asks (Link) skip it.
 */
export const PROVENANCE_HEADER_PATTERN = /^\[message from (?:monad session |the human\b)/;

/** The header of a message the human sent from the monad CLI. */
export const HUMAN_PROVENANCE_HEADER = "[message from the human at the monad CLI]";

/**
 * The first line of a delivered peer message, naming who sent it:
 * `[message from monad session <id> "<title>", repo <x>]`. The title is
 * JSON-quoted, so a title cannot close the quote and forge the rest of the
 * header. The engine's title derivation skips this line (indexer.ts), so a
 * session first named by a peer message is titled after the message body.
 */
export function provenanceHeader(
  message: Pick<PeerMessagePayload, "from" | "fromTitle" | "fromRepo">,
): string {
  if (message.from === "human") {
    return HUMAN_PROVENANCE_HEADER;
  }
  const title = JSON.stringify(message.fromTitle ?? "untitled");
  const repo = message.fromRepo === undefined ? "no repo" : `repo ${message.fromRepo}`;
  return `[message from monad session ${message.from} ${title}, ${repo}]`;
}

/** The full text a peer message is delivered as: header, blank line, body. */
export function peerPromptText(message: PeerMessagePayload): string {
  return `${provenanceHeader(message)}\n\n${message.text}`;
}

/**
 * The session/prompt params that deliver a peer message. _meta carries the
 * message id (so a restarted daemon can tell a delivered message from a
 * queued one) and the hop count (so the target's own sends during this turn
 * carry hop + 1).
 */
export function peerPromptRequest(sessionId: SessionId, message: PeerMessagePayload): PromptRequest {
  const meta: PeerPromptMeta = { messageId: message.messageId, from: message.from, hop: message.hop };
  return {
    sessionId,
    prompt: [{ type: "text", text: peerPromptText(message) }],
    _meta: { [PEER_META_KEY]: meta },
  };
}

/** The peer metadata of a logged prompt payload, if it delivered one. */
export function peerMetaOf(promptPayload: unknown): PeerPromptMeta | undefined {
  if (promptPayload === null || typeof promptPayload !== "object") {
    return undefined;
  }
  const meta = (promptPayload as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const parsed = PeerPromptMetaSchema.safeParse((meta as Record<string, unknown>)[PEER_META_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The hop count of the turn a prompt started: the peer hop it carried, or 0
 * for a turn a human started (or no turn at all).
 */
export function turnHop(promptPayload: unknown): number {
  return peerMetaOf(promptPayload)?.hop ?? 0;
}

/**
 * Queued peer messages not yet delivered, oldest first, rebuilt from a
 * session's peer_message and prompt events. A queued message is delivered
 * exactly when a prompt carrying its messageId appears in the log, so this
 * IS the queue: it needs no state of its own and survives a daemon restart
 * for free. Malformed payloads are skipped rather than delivered.
 */
export function undeliveredPeerMessages(events: EventRecord[]): PeerMessagePayload[] {
  const delivered = new Set<string>();
  for (const event of events) {
    if (event.kind === "prompt") {
      const meta = peerMetaOf(event.payload);
      if (meta) {
        delivered.add(meta.messageId);
      }
    }
  }
  const queued: PeerMessagePayload[] = [];
  for (const event of events) {
    if (event.kind !== "peer_message") {
      continue;
    }
    const parsed = PeerMessagePayloadSchema.safeParse(event.payload);
    if (parsed.success && parsed.data.delivery === "queued" && !delivered.has(parsed.data.messageId)) {
      queued.push(parsed.data);
    }
  }
  return queued;
}
