import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { diskBlobStore } from '@myco-server-worker/platform/bun/blobs.js';
import { LOCAL_SECRET_NAMES, readLocalRecord, resolveLocalPaths, type LocalDeploymentPaths } from './local.js';
import { createRecoveryBundle, type RecoveryManifest } from './recovery-bundle.js';

function configuration(paths: LocalDeploymentPaths) {
  const { port, origin, sourceFrom, trustedHeader, trustedHops, fleet } = readLocalRecord(paths);
  return { port, origin, sourceFrom, trustedHeader, trustedHops, fleet };
}

/** Capture a locally served Deployment without starting it or applying migrations. */
export async function backupLocalDeployment(options: {
  destination: string; paths?: LocalDeploymentPaths; report?: (line: string) => void;
}): Promise<RecoveryManifest> {
  const paths = options.paths ?? resolveLocalPaths();
  const source = diskBlobStore(paths.blobDir);
  return createRecoveryBundle(options.destination, {
    source: { target: 'local', locator: fs.realpathSync(paths.databasePath) },
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
  }, options.report);
}
