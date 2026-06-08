/**
 * Out-of-process restore.
 *
 * A restore must execute the whole SQL dump to merge it (INSERT OR IGNORE).
 * On an 800MB backup that is minutes of synchronous `db.exec`, which would
 * wedge the daemon's single thread and freeze every endpoint. Instead the
 * daemon spawns its own binary as a short-lived child (`myco __restore-backup`)
 * to do the heavy work and just awaits it — the event loop stays free, and a
 * crash in the restore can't take the daemon down. WAL lets the daemon keep
 * reading the same DB while the child writes; the dump's many small commits
 * interleave with the daemon's own writes rather than holding one long lock.
 *
 * The child writes its RestoreResult JSON to a temp file (not stdout) so
 * incidental logging on stdout can't corrupt the result.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RestoreResult } from './engine.js';

export interface RestoreChildParams {
  /** Absolute path to the Grove DB the backup is restored into. */
  dbPath: string;
  /** Absolute path to the backup dump. */
  backupPath: string;
  /** The myco binary to spawn (typically `process.execPath`). */
  binaryPath: string;
}

export function restoreViaChild(params: RestoreChildParams): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `myco-restore-${process.pid}-${Date.now()}.json`);
    const child = spawn(
      params.binaryPath,
      ['__restore-backup', params.dbPath, params.backupPath, outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        if (code !== 0) {
          reject(new Error(`restore process exited ${code}: ${err.trim() || 'unknown error'}`));
          return;
        }
        resolve(JSON.parse(fs.readFileSync(outPath, 'utf-8')) as RestoreResult);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* best effort */ }
      }
    });
  });
}
