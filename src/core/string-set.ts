/** Compares string collections using the repository's canonical set semantics. */

/** Reports whether both collections contain the same distinct strings. */
export function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
  );
}
