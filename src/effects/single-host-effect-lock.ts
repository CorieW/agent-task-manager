/** Serializes one external-effect identity within the current manager process. */
/** Indexes each effect ID to its current in-process lock tail. */
const tails = new Map<string, Promise<void>>();

/** Serializes work under the corresponding in-process identity lock. */
export async function withSingleHostEffectLock<T>(
  effectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  /** Result of `tails.get`, retained for the with single host effect lock operation. */
  const prior = tails.get(effectId) ?? Promise.resolve();
  /** Result of `Promise`, retained for the with single host effect lock operation. */
  let release!: () => void;
  /** Result of `Promise`, retained for the with single host effect lock operation. */
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  /** Result of `prior.catch`, retained for the with single host effect lock operation. */
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
