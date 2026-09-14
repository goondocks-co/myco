import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { resetEmbeddingIndex } from '@myco-server-worker/core/embedding/reconcile.js';
import { syncDirectoryForDurability } from '@myco/utils/atomic-write.js';
import { copyRecoveryBundle } from './recovery-bundle.js';
import { prepareRecoveryCredentials } from './recovery-credentials.js';
import { LocalVolume } from './local-volume.js';
import {
  DEFAULT_LOCAL_RECORD, resolveLocalPaths,
  writeLocalRecord, writeLocalSecrets, assertRecordServable, type LocalDeploymentPaths,
} from './local.js';

/** Publish a complete native volume only after its data and independently supplied wrapping material verify. */
export async function restoreLocalDeployment(options: {
  source: string; secretsFile: string; port?: number; paths?: LocalDeploymentPaths; report?: (line: string) => void;
}): Promise<{ schemaVersion: number; rebuildEmbeddings: boolean }> {
  const paths = options.paths ?? resolveLocalPaths();
  const record = { ...DEFAULT_LOCAL_RECORD, port: options.port ?? DEFAULT_LOCAL_RECORD.port };
  assertRecordServable(record);
  return new LocalVolume(paths).exclusive(async () => {
    if (fs.existsSync(paths.root)) throw new Error('recovery requires a fresh local Deployment directory; existing data was not changed');
    const { secrets, key } = await prepareRecoveryCredentials(options.source, options.secretsFile);
    const stagingHome = fs.mkdtempSync(path.join(path.dirname(paths.root), '.local-restore-'));
    fs.chmodSync(stagingHome, 0o700);
    try {
      const staging = resolveLocalPaths(stagingHome);
      const manifest = await copyRecoveryBundle(options.source, staging.root, options.report);
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
      writeLocalSecrets(secrets, staging);
      writeLocalRecord(record, staging);
      fs.renameSync(path.join(staging.root, 'recovery.json'), path.join(staging.root, 'recovered-from.json'));
      fs.rmSync(path.join(staging.root, '.recovery.lock'));
      for (const file of [staging.databasePath, staging.secretsFile, staging.recordFile]) {
        const fd = fs.openSync(file, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      syncDirectoryForDurability(staging.root);
      fs.renameSync(staging.root, paths.root);
      syncDirectoryForDurability(path.dirname(paths.root));
      return { schemaVersion: manifest.snapshot!.schemaVersion, rebuildEmbeddings };
    } finally { fs.rmSync(stagingHome, { recursive: true, force: true }); }
  });
}
