/** Serializes one external-effect identity within the current manager process. */
const tails = new Map<string, Promise<void>>();

export async function withSingleHostEffectLock<T>(effectId: string, operation: () => Promise<T>): Promise<T> {
  const prior = tails.get(effectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => current);
  tails.set(effectId, tail);
  await prior.catch(() => undefined);
  try { return await operation(); }
  finally { release(); if (tails.get(effectId) === tail) tails.delete(effectId); }
}
