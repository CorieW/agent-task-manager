/** Serializes one external-effect identity within the current manager process. */
/** Indexes each effect ID to its current in-process lock tail. */
const tails = new Map<string, Promise<void>>();

/** Serializes work under the corresponding in-process identity lock. */
export async function withSingleHostEffectLock<T>(
  effectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  /** Stores prior used by with single host effect lock. */
  const prior = tails.get(effectId) ?? Promise.resolve();
  /** Callback that releases the current queue position. */
  let release!: () => void;
  /** Queue tail awaited by the next single-host effect. */
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  /** Stores tail used by with single host effect lock. */
  const tail = prior.catch(() => undefined).then(() => current);
  tails.set(effectId, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(effectId) === tail) tails.delete(effectId);
  }
}
