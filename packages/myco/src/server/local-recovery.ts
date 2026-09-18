import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { resetEmbeddingIndex } from '@myco-server-worker/core/embedding/reconcile.js';
import { assignRestoreGeneration, resetRecoveryLedger } from '@myco-server-worker/core/object-release.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { readSchemaVersion } from '@myco-server-worker/db/migrate.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { syncDirectoryForDurability } from '@myco/utils/atomic-write.js';
import { copyRecoveryBundle, preparedObjectKeys, restoredFleet } from './recovery-bundle.js';
import { prepareRecoveryCredentials } from './recovery-credentials.js';
import { LocalVolume } from './local-volume.js';
import {
  DEFAULT_LOCAL_RECORD, resolveLocalPaths,
  writeLocalRecord, writeLocalSecrets, assertRecordServable, type LocalDeploymentPaths,
} from './local.js';

/**
 * Brings the staged volume to the bundled schema through the one migration applier, clears the source's object
 * lifecycle, and names every registered blob under a fresh restore generation: the staged copy's logical-key objects
 * move to the keys the database now registers, so the volume published is the layout its rows name. Answers the schema
 * version the prepared volume holds.
 */
async function prepareRestoredObjects(staging: LocalDeploymentPaths, native: NativeSqlite | undefined): Promise<number> {
  migrateOnly(staging.databasePath, native);
  const db = new Database(staging.databasePath);
  let schemaVersion: number;
  try {
    const store = sqliteRelationalStore(db);
    await resetRecoveryLedger(store);
    await assignRestoreGeneration(store, crypto.randomUUID());
    schemaVersion = await readSchemaVersion(store);
  } finally { db.close(); }
  const moved = new Set<string>();
  for (const [logical, { objectKey }] of preparedObjectKeys(staging.databasePath)) {
    if (objectKey === logical) continue;
    const from = path.join(staging.blobDir, ...logical.split('/'));
    const to = path.join(staging.blobDir, ...objectKey.split('/'));
    fs.renameSync(from, to);
    moved.add(path.dirname(to));
  }
  for (const directory of moved) syncDirectoryForDurability(directory);
  return schemaVersion;
}

/** Publish a complete native volume only after its data and independently supplied wrapping material verify. */
export async function restoreLocalDeployment(options: {
  source: string; secretsFile: string; port?: number; paths?: LocalDeploymentPaths; native?: NativeSqlite;
  /** Publish with a fresh sign-in secret and no sign-in credentials, for a Deployment that holds none. */
  newSignIn?: boolean; report?: (line: string) => void;
}): Promise<{ schemaVersion: number; rebuildEmbeddings: boolean }> {
  const paths = options.paths ?? resolveLocalPaths();
  const record = { ...DEFAULT_LOCAL_RECORD, port: options.port ?? DEFAULT_LOCAL_RECORD.port };
  assertRecordServable(record);
  return new LocalVolume(paths).exclusive(async () => {
    if (fs.existsSync(paths.root)) throw new Error('recovery requires a fresh local Deployment directory; existing data was not changed');
    const { secrets, key } = await prepareRecoveryCredentials(options.source, options.secretsFile, options.newSignIn === true);
    const stagingHome = fs.mkdtempSync(path.join(path.dirname(paths.root), '.local-restore-'));
    fs.chmodSync(stagingHome, 0o700);
    try {
      const staging = resolveLocalPaths(stagingHome);
      const manifest = await copyRecoveryBundle(options.source, staging.root, options.report);
      // The fleet is the one recorded setting a native restore carries; its network settings stay this Deployment's own.
      const carried = restoredFleet(manifest.snapshot!.configuration);
      const published = carried.fleet === null ? record : { ...record, fleet: carried.fleet };
      assertRecordServable(published);
      const db = new Database(staging.databasePath);
      let rebuildEmbeddings: boolean;
      try {
        const store = sqliteRelationalStore(db);
        const heldSecrets = await deploymentSecretStore(store, key).list();
        if (heldSecrets.some((secret) => !secret.readable)) throw new Error('recovery wrapping key cannot open all stored credentials');
        rebuildEmbeddings = manifest.source.target === 'cloudflare'
          || db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_vectors'").get() === null;
        if (rebuildEmbeddings) {
          const projects = db.query<{ project_id: string }, []>('SELECT project_id FROM projects').all();
          for (const project of projects) await resetEmbeddingIndex(store, project.project_id);
          options.report?.('Embedding rebuild required before semantic search is ready');
        }
      } finally { db.close(); }
      const schemaVersion = await prepareRestoredObjects(staging, options.native);
      writeLocalSecrets(secrets, staging);
      writeLocalRecord(published, staging);
      options.report?.(carried.report);
      fs.renameSync(path.join(staging.root, 'recovery.json'), path.join(staging.root, 'recovered-from.json'));
      fs.rmSync(path.join(staging.root, '.recovery.lock'));
      for (const file of [staging.databasePath, staging.secretsFile, staging.recordFile]) {
        const fd = fs.openSync(file, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      syncDirectoryForDurability(staging.root);
      fs.renameSync(staging.root, paths.root);
      syncDirectoryForDurability(path.dirname(paths.root));
      return { schemaVersion, rebuildEmbeddings };
    } finally { fs.rmSync(stagingHome, { recursive: true, force: true }); }
  });
}
