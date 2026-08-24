/**
 * A policy pack is a named, versioned bundle of check configuration that a repo
 * can adopt in one line via `extends:` in its `.lastgate.yml`. The model is
 * ESLint's shareable configs: a pack provides a *base*, the local file (and any
 * later pack in the `extends` list) overrides on top.
 *
 * `config` is an arbitrary partial of the YAML config shape — it is NOT
 * pre-validated here. The resolver deep-merges packs in order under the engine
 * defaults and over the local file, then validates the single merged result
 * against the Zod schema. This keeps packs authorable as plain partials while
 * guaranteeing the final config is always schema-valid.
 */
export interface PolicyPack {
  /** Canonical pack name, e.g. "@lastgate/agent-safety". */
  name: string;
  /** Major version. Referenced as `@lastgate/agent-safety@1`. */
  version: number;
  /** One-line human description shown in docs and tooling. */
  description: string;
  /** Partial config the pack contributes (merged, then validated). */
  config: Record<string, unknown>;
}
