/**
 * Shared subprocess helper for LifecycleLock tests.
 *
 * Invoked as: `bun tests/helpers/lifecycle-lock-orphan-helper.ts <lockPath> [dbPath]`
 *
 * - Acquires the LifecycleLock at lockPath. Exits 2 if the lock is held.
 * - If dbPath is provided: opens that SQLite database, holds an open
 *   write transaction. Used by tests that need an orphan holding both
 *   the flock and the SQLite write lock (the production failure shape).
 * - Emits READY plus the holder PID to stdout once everything is held.
 *   Idles forever; the OS releases both locks on SIGTERM/SIGKILL.
 */

import { Database } from 'bun:sqlite';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

const lockPath = process.argv[2];
const dbPath = process.argv[3];

if (!lockPath) {
  process.stderr.write('helper: lockPath argument required\n');
  process.exit(64);
}

const result = LifecycleLock.acquire(lockPath);
if (!result.acquired) {
  process.stderr.write('helper: failed to acquire lock\n');
  process.exit(2);
}

let db: Database | null = null;
if (dbPath) {
  db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 200');
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // The parent may have just initialized the schema; holding any write lock
    // is enough for this helper, so keep the existing journal mode on a race.
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  db.exec('CREATE TABLE IF NOT EXISTS _orphan_witness (n INTEGER)');
  db.exec('INSERT INTO _orphan_witness (n) VALUES (1)');
}

process.stdout.write(`READY ${process.pid}\n`);

const cleanup = (): void => {
  if (db) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  process.exit(0);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
setInterval(() => {}, 1000);
