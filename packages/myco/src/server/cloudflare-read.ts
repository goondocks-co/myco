import type { WorkerRetry } from '@myco/server/cloudflare-worker-update.js';

const READ_WINDOW_MS = 20_000;
const READ_ATTEMPTS = 3;
const READ_TIMEOUT_MS = 5_000;
const READ_WAIT_MS = 2_000;

interface PropagationRead<T> {
  retry?: WorkerRetry;
  read: (timeoutMs: number) => Promise<T>;
  confirmed: (value: T) => boolean;
  retryError: (error: unknown) => boolean;
}

/** A negative observation requires agreement across the bounded read window. */
export async function readCloudflarePropagation<T>(options: PropagationRead<T>): Promise<T> {
  const now = options.retry?.now ?? Date.now;
  const sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + READ_WINDOW_MS;
  let negativeReads = 0;
  let observed: { value: T } | undefined;
  let failed: { error: unknown } | undefined;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const value = await options.read(Math.min(READ_TIMEOUT_MS, remaining));
      if (options.confirmed(value)) return value;
      observed = { value };
      negativeReads += 1;
    } catch (error) {
      if (!options.retryError(error)) throw error;
      failed = { error };
    }
    if (attempt + 1 < READ_ATTEMPTS) {
      const wait = Math.min(READ_WAIT_MS, Math.max(0, deadline - now()));
      if (wait > 0) await sleep(wait);
    }
  }
  if (failed !== undefined) throw failed.error;
  if (observed !== undefined && negativeReads === READ_ATTEMPTS) return observed.value;
  throw new Error('Cloudflare read could not be confirmed within its observation window');
}
