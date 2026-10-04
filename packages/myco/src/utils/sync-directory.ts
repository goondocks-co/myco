import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';

/** Flush a directory entry update on POSIX. Windows has no portable directory handle. */
export function syncDirectoryForDurability(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fsConstants.O_RDONLY);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
