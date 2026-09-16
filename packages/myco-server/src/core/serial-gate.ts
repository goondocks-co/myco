/**
 * One-at-a-time work over shared state, and one step shared by every caller that arrives while it runs.
 *
 * A checkpoint holding one attempt is mutated by whoever wakes it, and a wake can arrive while another is still in
 * flight. `exclusive` puts those mutations in a queue of one; `shared` hands the step already running to the next
 * caller instead of starting a second, which is what keeps two overlapping wakes from asking a provider twice.
 */
export interface SerialGate {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  shared<T>(work: () => Promise<T>): Promise<T>;
}

export function serialGate(): SerialGate {
  let queue: Promise<void> = Promise.resolve();
  let held: Promise<unknown> | null = null;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    exclusive,
    async shared<T>(work: () => Promise<T>): Promise<T> {
      if (held !== null) return held as Promise<T>;
      const run = exclusive(work);
      held = run;
      try {
        return await run;
      } finally {
        if (held === run) held = null;
      }
    },
  };
}
