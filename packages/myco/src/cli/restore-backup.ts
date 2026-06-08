/**
 * Internal command: `myco __restore-backup <dbPath> <backupPath> <outPath>`.
 *
 * Not user-facing — the daemon spawns this in a child process so a heavy
 * restore doesn't block its event loop (see backup/restore-runner.ts). It
 * opens the Grove DB, runs the engine restore, and writes the RestoreResult
 * as JSON to `outPath` (a file, so stdout noise can't corrupt it).
 */

import fs from 'node:fs';
import { openDatabase } from '@myco/db/client.js';
import { restoreBackup } from '@myco/backup/engine.js';

export async function run(args: string[]): Promise<void> {
  const [dbPath, backupPath, outPath] = args;
  if (!dbPath || !backupPath || !outPath) {
    throw new Error('Usage: myco __restore-backup <dbPath> <backupPath> <outPath>');
  }
  const db = openDatabase(dbPath);
  try {
    const result = restoreBackup(db, backupPath);
    fs.writeFileSync(outPath, JSON.stringify(result), 'utf-8');
  } finally {
    db.close();
  }
}
