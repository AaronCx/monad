import type { PolicyPack } from "./types";
import { agentSafety } from "./agent-safety";
import { secretsStrict } from "./secrets-strict";
import { soloDev } from "./solo-dev";

export type { PolicyPack } from "./types";

/**
 * Built-in policy packs, resolved by name with no network access. These ship
 * inside the engine and are the v1 of the shareable-config story (ESLint's
 * model). External packs (npm modules or fetched JSON/URLs) can be layered in
 * later behind the same {@link PackResolver} interface without touching the
 * merge logic.
 *
 * Keyed by both the bare name (`solo-dev`) and the scoped name
 * (`@lastgate/solo-dev`) so users can write either form in `extends:`.
 */
const BUILTIN_LIST: PolicyPack[] = [agentSafety, secretsStrict, soloDev];

const BUILTIN_PACKS = new Map<string, PolicyPack>();
for (const pack of BUILTIN_LIST) {
  BUILTIN_PACKS.set(pack.name, pack);
  // Also index by the bare (unscoped) name for ergonomic `extends: solo-dev`.
  const bare = pack.name.replace(/^@lastgate\//, "");
  BUILTIN_PACKS.set(bare, pack);
}

/** Names of every built-in pack (scoped form), for error messages and docs. */
export const BUILTIN_PACK_NAMES: readonly string[] = BUILTIN_LIST.map(
  (p) => p.name,
);

/**
 * The result of parsing an `extends` reference into a name + optional version.
 * `@lastgate/agent-safety@1` -> { name: "@lastgate/agent-safety", version: 1 }
 */
export interface PackRef {
  /** Bare reference without the version suffix. */
  name: string;
  /** Requested major version, or undefined if unpinned. */
  version?: number;
  /** The original, unparsed reference (for error messages). */
  raw: string;
}

/**
 * Parse an `extends` entry into a {@link PackRef}. Handles scoped names
 * (`@lastgate/agent-safety`) where the leading `@` is part of the scope, not a
 * version separator — only a `@` that is *not* at index 0 introduces a version.
 *
 * `@lastgate/agent-safety@1` -> name "@lastgate/agent-safety", version 1
 * `agent-safety`             -> name "agent-safety", version undefined
 */
export function parsePackRef(ref: string): PackRef {
  const trimmed = ref.trim();
  // Find a version separator `@` that is not the leading scope `@`.
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const name = trimmed.slice(0, at);
    const versionStr = trimmed.slice(at + 1);
    if (versionStr !== "" && /^\d+$/.test(versionStr)) {
      return { name, version: Number(versionStr), raw: trimmed };
    }
    // A non-numeric suffix after `@` is malformed — surface it clearly.
    if (versionStr !== "") {
      throw new Error(
        `Invalid pack version in extends entry "${trimmed}": version must be a ` +
          `major-version integer (e.g. "${name}@1").`,
      );
    }
  }
  return { name: trimmed, version: undefined, raw: trimmed };
}

/**
 * Resolves a pack reference to its {@link PolicyPack}. Pluggable so a future
 * npm/URL fetcher can be supplied without changing extends-resolution. Returns
 * `undefined` for an unknown pack so the caller can produce a single,
 * consistent error message.
 */
export type PackResolver = (ref: PackRef) => PolicyPack | undefined;

/**
 * The default resolver: built-in packs only, no network. Validates the
 * requested major version against the pack's version when one is pinned.
 */
export const resolveBuiltinPack: PackResolver = (ref) => {
  const pack = BUILTIN_PACKS.get(ref.name);
  if (!pack) return undefined;
  if (ref.version !== undefined && ref.version !== pack.version) {
    throw new Error(
      `Pack "${ref.name}" version ${ref.version} is not available — the ` +
        `bundled version is ${pack.version}. Use "${ref.name}@${pack.version}".`,
    );
  }
  return pack;
};
