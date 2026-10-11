import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const RENAME_RETRY_MS = 50;
const RENAME_TIMEOUT_MS = 5_000;

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
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || now() >= deadline) throw error;
      await (options.pause?.() ?? sleep(RENAME_RETRY_MS));
    }
  }
}
