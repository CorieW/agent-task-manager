/** Provides deterministic cursor pagination without exposing provider-specific cursors. */
/** Inputs required to perform page. */
export interface PageRequest {
  /** Opaque cursor after which the next page begins. */
  readonly cursor: string | null;
  /** Limit for page request. */
  readonly limit: number;
}

/** Returns a deterministic page beginning after the supplied cursor. */
export function pageAfter<T>(
  values: readonly T[],
  request: PageRequest,
  keyOf: (value: T) => string,
  maximumLimit = 100,
): readonly T[] {
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > maximumLimit
  ) {
    throw new RangeError(
      `Page limit must be an integer from 1 to ${maximumLimit}`,
    );
  }
  return [...values]
    .sort((left, right) => keyOf(left).localeCompare(keyOf(right)))
    .filter(
      (value) =>
        request.cursor === null ||
        keyOf(value).localeCompare(request.cursor) > 0,
    )
    .slice(0, request.limit);
}
