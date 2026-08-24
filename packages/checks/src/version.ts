/**
 * Checks engine version, kept in lockstep with packages/checks/package.json.
 *
 * This constant is the single runtime source of truth and version.test.ts
 * asserts it matches package.json so they can't silently drift.
 */
export const ENGINE_VERSION = "0.1.0";
