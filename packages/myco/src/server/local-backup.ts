import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { diskBlobStore } from '@myco-server-worker/platform/bun/blobs.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { acquireRecoveryHold, openRecoveryHold, readRecoveryHold, releaseOperatorHold } from '@myco-server-worker/core/object-release.js';
import { LOCAL_SECRET_NAMES, readLocalRecord, resolveLocalPaths, type LocalDeploymentPaths } from './local.js';
import { LocalVolume } from './local-volume.js';
import { createRecoveryBundle, type RecoveryHoldOwner, type RecoveryHoldReading, type RecoveryManifest } from './recovery-bundle.js';

function configuration(paths: LocalDeploymentPaths) {
  const { port, origin, sourceFrom, trustedHeader, trustedHops, fleet } = readLocalRecord(paths);
  return { port, origin, sourceFrom, trustedHeader, trustedHops, fleet };
}

/**
 * The recovery hold a native backup takes on the volume it is copying.
 *
 * The statements are the server's own hold owner, and every one of them runs under the volume capability
 * (`LocalVolume.reading`, a shared lease): nothing replaces the volume between reading its identity and holding it, and
 * no caller has to remember to take a lease of its own. Each statement is one transaction and idempotent by token, so
 * an answer that was lost is settled by asking again about the same token rather than by taking a second hold.
 */
export function localRecoveryHold(paths: LocalDeploymentPaths, native?: NativeSqlite): RecoveryHoldOwner {
  const held = <T>(work: (db: ReturnType<typeof sqliteRelationalStore>) => Promise<T>): Promise<T> =>
    new LocalVolume(paths).reading(() => {
      configureSqliteLibrary(native);
      const sqlite = new Database(paths.databasePath, { readwrite: true, create: false });
      sqlite.exec('PRAGMA busy_timeout = 5000');
      return work(sqliteRelationalStore(sqlite)).finally(() => { sqlite.close(); });
    });
  /** The hold and the Deployment answering for it, as one statement: never a hold paired with an identity read apart. */
  const reading = (db: ReturnType<typeof sqliteRelationalStore>, token: string): Promise<RecoveryHoldReading> =>
    readRecoveryHold(db, token).then(({ hold, sourceIdentity }) => ({
      state: hold === null ? 'absent' : hold.holder !== 'operator' ? 'other-holder' : hold.releasedAt === null ? 'open' : 'released',
      sourceIdentity,
    }));
  return {
    // The volume this hold belongs to, by the path a destination records: its real path while it exists, and the path
    // itself for a Deployment this machine no longer holds, so a recorded hold can still be read or given up.
    locator: fs.existsSync(paths.databasePath) ? fs.realpathSync(paths.databasePath) : paths.databasePath,
    acquire: (token) => held(async (db) => {
      await acquireRecoveryHold(db, token, Date.now(), 'operator');
      return reading(db, token);
    }),
    inspect: (token) => held((db) => reading(db, token)),
    release: (token, reason) => held(async (db) => {
      await releaseOperatorHold(db, token, Date.now(), reason);
      return reading(db, token);
    }),
    open: () => held((db) => openRecoveryHold(db, 'operator')),
  };
}

/**
 * Capture a locally served Deployment without starting it or applying migrations.
 *
 * The volume lease is held shared for the whole capture, so the Deployment keeps serving while nothing migrates,
 * recovers or rewrites the volume under the snapshot. The recovery hold the writer takes keeps every object this
 * snapshot names until the artifact completes.
 */
export async function backupLocalDeployment(options: {
  destination: string; paths?: LocalDeploymentPaths; report?: (line: string) => void; native?: NativeSqlite;
}): Promise<RecoveryManifest> {
  const paths = options.paths ?? resolveLocalPaths();
  const source = diskBlobStore(paths.blobDir);
  return new LocalVolume(paths).reading(() => createRecoveryBundle(options.destination, {
    source: { target: 'local', locator: fs.realpathSync(paths.databasePath) },
    hold: localRecoveryHold(paths, options.native),
    snapshot: async (file) => {
      const before = configuration(paths);
      const db = new Database(paths.databasePath, { readonly: true, create: false });
      try { db.query('VACUUM INTO ?').run(file); } finally { db.close(); }
      if (JSON.stringify(before) !== JSON.stringify(configuration(paths))) throw new Error('Deployment configuration changed during its snapshot; retry');
      return { configuration: before, credentialsRequired: [...LOCAL_SECRET_NAMES] };
    },
    blob: async (blob) => {
      const held = await source.get(blob.source);
      if (held === null) throw new Error(`source Deployment is missing blob ${blob.key}`);
      return held.body;
    },
  }, options.report));
}
