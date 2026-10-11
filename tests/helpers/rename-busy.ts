import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const RENAME_RETRY_MS = 50;
const RENAME_TIMEOUT_MS = 5_000;

export function isRenameBusyError(error: unknown): boolean {
  return ['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export function renameBusySync(
  source: string, target: string,
  options: { rename?: typeof fs.renameSync; now?: () => number; pause?: () => void } = {},
): void {
  const rename = options.rename ?? fs.renameSync;
  const now = options.now ?? Date.now;
  const deadline = now() + RENAME_TIMEOUT_MS;
  const waiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let originalError: unknown;
  for (;;) {
    try { rename(source, target); return; }
    catch (error) {
      if (!isRenameBusyError(error)) throw error;
      originalError ??= error;
      if (now() >= deadline) throw originalError;
      if (options.pause) options.pause();
      else Atomics.wait(waiter, 0, 0, RENAME_RETRY_MS);
    }
  }
}

/** Windows may briefly retain an image handle after launch. */
export async function renameBusy(
  source: string, target: string,
  options: { rename?: typeof fs.renameSync; now?: () => number; pause?: () => Promise<void> } = {},
): Promise<void> {
  const rename = options.rename ?? fs.renameSync;
  const now = options.now ?? Date.now;
  const deadline = now() + RENAME_TIMEOUT_MS;
  for (;;) {
    try { rename(source, target); return; }
    catch (error) {
      if (!isRenameBusyError(error) || now() >= deadline) throw error;
      await (options.pause?.() ?? sleep(RENAME_RETRY_MS));
    }
  }
}
