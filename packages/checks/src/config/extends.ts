import { deepMerge } from "./merge";
import {
  BUILTIN_PACK_NAMES,
  parsePackRef,
  resolveBuiltinPack,
  type PackResolver,
} from "./packs";

/**
 * Normalize the raw `extends` field into a list of references. Accepts a single
 * string or an array of strings. Anything else (number, object, etc.) is a
 * config error.
 */
function normalizeExtends(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (typeof v !== "string") {
        throw new Error(
          `Invalid extends[${i}]: every extends entry must be a string pack reference (e.g. "@lastgate/agent-safety@1").`,
        );
      }
      return v;
    });
  }
  throw new Error(
    `Invalid "extends": expected a string or an array of strings, got ${typeof value}.`,
  );
}

function unknownPackError(ref: string): Error {
  return new Error(
    `Unknown policy pack "${ref}" in extends. Available built-in packs: ${BUILTIN_PACK_NAMES.join(", ")}. Reference a version with "@N", e.g. "@lastgate/agent-safety@1".`,
  );
}

/**
 * Resolve the `extends` chain of a raw config object into a single merged base
 * config. Packs may themselves declare `extends`, so resolution is recursive
 * and depth-first: a pack's own bases are merged before the pack's config, and
 * earlier entries in an `extends` array are overridden by later ones.
 *
 * Circular references (a pack that extends itself, directly or transitively)
 * are detected via a path stack and reported with the full cycle.
 *
 * The returned object is the merged *base* only — it does NOT include engine
 * defaults or the local file. The caller layers defaults underneath and the
 * local file on top, then validates the final result.
 */
export function resolveExtends(
  raw: Record<string, unknown>,
  resolver: PackResolver = resolveBuiltinPack,
): Record<string, unknown> {
  return resolveExtendsInner(raw, resolver, []);
}

function resolveExtendsInner(
  node: Record<string, unknown>,
  resolver: PackResolver,
  stack: string[],
): Record<string, unknown> {
  const refs = normalizeExtends(node.extends);
  let base: Record<string, unknown> = {};

  for (const ref of refs) {
    const parsed = parsePackRef(ref);

    if (stack.includes(parsed.name)) {
      throw new Error(
        `Circular extends detected: ${[...stack, parsed.name].join(" -> ")}.`,
      );
    }

    const pack = resolver(parsed);
    if (!pack) {
      throw unknownPackError(ref);
    }

    // A pack's own `extends` (if any) resolves first, then its config layers on
    // top — so the pack overrides what it inherits. `resolveExtendsInner`
    // returns only the *inherited* bases; the pack's own `config` (minus its
    // `extends` key) is merged over that here.
    const packConfig = pack.config as Record<string, unknown>;
    const packBases = resolveExtendsInner(packConfig, resolver, [
      ...stack,
      parsed.name,
    ]);
    const { extends: _packExtends, ...packOwn } = packConfig;
    const packResolved = deepMerge(packBases, packOwn);

    // Later packs in the list override earlier ones.
    base = deepMerge(base, packResolved);
  }

  return base;
}
