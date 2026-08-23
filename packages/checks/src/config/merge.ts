/**
 * Recursive deep-merge for plain config objects. Objects are merged key-by-key;
 * arrays and scalars are *replaced* wholesale by the source (later) value. This
 * is the ESLint-extends override semantic: a later layer that sets
 * `file_patterns.block` replaces the inherited list rather than concatenating,
 * which keeps overrides predictable (you always know exactly what blocks).
 *
 * Shared by the defaults merge and the `extends` pack merge so both layers
 * apply identical rules.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = (target as Record<string, unknown>)[key];

    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      (result as Record<string, unknown>)[key] = sourceVal;
    }
  }

  return result;
}
