import { Database } from 'bun:sqlite';
import { setupFirstOwner } from '@myco-server-worker/core/first-owner.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { LocalVolume } from './local-volume.js';
import { assertRecordServable, LOCAL_SECRET_NAMES, readLocalRecord, readLocalSecrets, type LocalDeploymentPaths } from './local.js';

/** Issues a first administrator link under stopped-volume ownership; retries replace only its pending link. */
export async function setupLocalOwner(paths: LocalDeploymentPaths, native: NativeSqlite) {
  return new LocalVolume(paths).exclusive(async () => {
    const record = readLocalRecord(paths);
    assertRecordServable(record);
    const origin = new URL(record.origin ?? `http://127.0.0.1:${record.port}`).origin;
    const secrets = readLocalSecrets(paths);
    if (LOCAL_SECRET_NAMES.some((name) => !secrets[name])) {
      throw new Error('configure native sign-in with `myco server github-app --target local` before owner setup');
    }
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readwrite: true, create: false });
    try {
      sqlite.exec('PRAGMA foreign_keys = ON');
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const db = sqliteRelationalStore(sqlite);
        const link = await setupFirstOwner(db, Date.now(), 'native schema must match this binary before owner setup');
        sqlite.exec('COMMIT');
        return { memberId: link.memberId, url: `${origin}/link#${link.key}`, expiresAt: link.expiresAt };
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    } finally { sqlite.close(); }
  });
}
