/** All started work settles before a failure propagates, so observations are final when the caller answers. */
export async function settledAll<T extends readonly unknown[] | []>(work: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  await Promise.allSettled(work);
  return Promise.all(work);
}
