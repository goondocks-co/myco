/**
 * Stop waiting when the caller's signal aborts, including work that ignores cancellation. Work that still finishes
 * after the wait was given up hands its result to `discarded`, the one owner of anything that result holds; a
 * failure of that work, or of `discarded`, is nobody's to report.
 */
export async function abortable<T>(signal: AbortSignal, work: () => Promise<T>, discarded?: (late: T) => void | Promise<void>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  const running = work();
  let delivered = false;
  try {
    const result = await Promise.race([running, aborted]);
    delivered = true;
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!delivered && discarded !== undefined) void running.then(discarded).catch(() => {});
  }
}
