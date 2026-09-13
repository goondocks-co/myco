import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { restoreLocalDeployment } from '@myco/server/local-recovery.js';
import { LOCAL_SECRET_NAMES, readLocalRecord, readLocalSecrets, resolveLocalPaths } from '@myco/server/local.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteRelationalStore } from '../../packages/myco-server/src/platform/bun/sqlite.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { diskBlobStore } from '../../packages/myco-server/src/platform/bun/blobs.js';
import { deploymentSecretStore } from '../../packages/myco-server/src/core/secrets.js';
import { wrappingKeyFromText } from '../../packages/myco-server/src/platform/wrapping-key.js';
import { reconcileEmbedding } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';
import { searchProject } from '../../packages/myco-server/src/read/search.js';
import { createBackup, setBackupPinned } from '../../packages/myco-server/src/core/backup.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { indexFixture } from '../myco-server/helpers/vector-index.js';

configureSqliteLibrary();

async function fixture(target: 'local' | 'cloudflare' = 'cloudflare') {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-recovery-'));
  const artifact = path.join(root, 'artifact');
  const secretsFile = path.join(root, 'independent.env');
  const paths = resolveLocalPaths(path.join(root, 'destination'));
  const secrets = { SECRET_WRAP_KEY: Buffer.alloc(32, 9).toString('base64'), SESSION_SECRET: 'fixture-session-secret',
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret' };
  fs.writeFileSync(secretsFile, Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 });
  const key = wrappingKeyFromText(async () => secrets.SECRET_WRAP_KEY, 'fixture');
  await deploymentSecretStore(source.db, key).put('fixture', 'recovered-secret', 'fixture', 1);
  source.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','memory','user','A durable architecture decision','decision',1)");
  const provider = { modelKey: 'fixture-model', embed: async () => [1, 0] };
  await reconcileEmbedding({ db: source.db, blobs: source.bucket, provider,
    vectors: target === 'local' ? sqliteVectorStore(source.sqlite) : cloudflareVectorStore(indexFixture()) }, 'proj_1', 1000);
  const backup = await createBackup(source.db, source.bucket, { producer: 'fixture', now: 1000 });
  await setBackupPinned(source.db, backup.id, true);
  await createRecoveryBundle(artifact, {
    source: { target, locator: 'fixture-source' },
    snapshot: async (file) => { source.sqlite.query('VACUUM INTO ?').run(file); return { configuration: {}, credentialsRequired: [...LOCAL_SECRET_NAMES] }; },
    blob: async (object) => { const held = await source.bucket.get(object.key); if (held === null) throw new Error('missing fixture object'); return held.body; },
  });
  return { source, root, artifact, secretsFile, paths, secrets, key, provider, backup,
    restore: () => restoreLocalDeployment({ source: artifact, secretsFile, paths, port: 18901 }),
    cleanup: () => { source.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('recovers hosted data, independently wrapped credentials and pinned artifacts into a fresh native volume', async () => {
  const f = await fixture();
  try {
    const original = fs.readFileSync(path.join(f.artifact, 'myco.sqlite'));
    const sourceRows = f.source.sqlite.query('SELECT * FROM spores').all();
    expect(await f.restore()).toMatchObject({ rebuildEmbeddings: true });
    expect(fs.readFileSync(path.join(f.artifact, 'myco.sqlite'))).toEqual(original);
    expect(readLocalRecord(f.paths)).toMatchObject({ port: 18901, sourceFrom: 'socket' });
    expect(readLocalSecrets(f.paths)).toEqual(f.secrets);
    const db = new Database(f.paths.databasePath);
    try {
      const store = sqliteRelationalStore(db);
      expect(db.query('SELECT * FROM spores').all()).toEqual(sourceRows);
      expect(await deploymentSecretStore(store, f.key).get('fixture')).toBe('recovered-secret');
      expect(db.query('SELECT pinned FROM backups WHERE id=?').get(f.backup.id)).toEqual({ pinned: 1 });
      expect(fs.readFileSync(path.join(f.paths.blobDir, f.backup.key)))
        .toEqual(fs.readFileSync(path.join(f.artifact, 'blobs', f.backup.key)));
      expect(await hasEmbeddingWork(store, 'proj_1', f.provider.modelKey, 2000)).toBe(true);
      const vectors = sqliteVectorStore(db);
      expect(await reconcileEmbedding({ db: store, blobs: diskBlobStore(f.paths.blobDir), provider: f.provider, vectors }, 'proj_1', 2000))
        .toEqual({ phase: 'missing', processed: 1 });
      const search = await searchProject(store, { projectId: 'proj_1' }, { query: 'architecture', mode: 'semantic' }, async () => ({ provider: f.provider, vectors }));
      expect(search.results.map((row) => row.id)).toEqual(['memory']);
    } finally { db.close(); }
    await expect(f.restore()).rejects.toThrow('fresh local Deployment directory');
  } finally { f.cleanup(); }
});

it('preserves a native snapshot and its vectors without resetting their ready receipts', async () => {
  const f = await fixture('local');
  try {
    expect(await f.restore()).toMatchObject({ rebuildEmbeddings: false });
    expect(fs.readFileSync(f.paths.databasePath)).toEqual(fs.readFileSync(path.join(f.artifact, 'myco.sqlite')));
    const db = new Database(f.paths.databasePath, { readonly: true });
    try { expect(db.query('SELECT ready FROM embedding_receipts').all()).toEqual([{ ready: 1 }]); }
    finally { db.close(); }
  } finally { f.cleanup(); }
});

it('refuses an unreadable wrapping key or corrupted artifact without publishing a destination', async () => {
  const f = await fixture();
  try {
    const originalSecrets = fs.readFileSync(f.secretsFile);
    fs.writeFileSync(f.secretsFile, originalSecrets.toString().replace(f.secrets.SECRET_WRAP_KEY, Buffer.alloc(32, 8).toString('base64')));
    await expect(f.restore()).rejects.toThrow('cannot open all stored credentials');
    expect(fs.existsSync(f.paths.root)).toBe(false);
    expect(fs.readdirSync(path.dirname(f.paths.root))).toEqual(['local.lock']);
    fs.writeFileSync(f.secretsFile, originalSecrets);
    const object = path.join(f.artifact, 'blobs', f.backup.key);
    const bytes = fs.readFileSync(object);
    fs.writeFileSync(object, 'damaged artifact');
    await expect(f.restore()).rejects.toThrow('completed recovery blob no longer matches');
    expect(fs.existsSync(f.paths.root)).toBe(false);
    fs.writeFileSync(object, bytes);
    expect(await f.restore()).toMatchObject({ rebuildEmbeddings: true });
  } finally { f.cleanup(); }
});
