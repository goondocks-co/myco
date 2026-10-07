import { serve } from '@myco-server-worker/entry/bun.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { memberHeaders } from '../myco-server/helpers/fixtures.js';
import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { assertRecoveryTenantChoice } from '@myco-server-worker/core/recovered-tenant.js';
import { restoreLocalDeployment } from '@myco/server/local-recovery.js';
import { LOCAL_SECRET_NAMES, readLocalRecord, readLocalSecrets, resolveLocalPaths } from '@myco/server/local.js';
import { envelope, sqliteEnv, uuid } from '../myco-server/helpers/fixtures.js';
import { legacyBlob, seedCredential } from '../myco-server/helpers/d1.js';
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
import { createHash } from 'node:crypto';
import { blobObjectKey, registeredObjectKeySql } from '../../packages/myco-server/src/core/blob-objects.js';
import { migrateOnly, startDeployment } from '../../packages/myco-server/src/platform/bun/server-main.js';
import { getBlob } from '../../packages/myco-server/src/read/blobs.js';
import { processedBody } from '../../packages/myco-server/src/read/processed.js';
import { ingestEvent } from '../../packages/myco-server/src/ingest/events.js';
import { SERVER_SCHEMA_VERSION } from '../../packages/myco-server/src/constants.js';
import { RECOVERED_SWITCH } from '../../packages/myco-server/src/core/embedding/switch-store.js';
import { asSchema41 } from './legacy-recovery-fixture.js';

/** Where the fixture source holds the object an artifact key names. */
async function sourceKeyOf(source: ReturnType<typeof sqliteEnv>, logical: string): Promise<string> {
  if (logical.startsWith('backups/')) return logical;
  const [projectId, key] = logical.split('/');
  return (source.sqlite.query(`SELECT ${registeredObjectKeySql('?', '?')} AS k`).get(projectId!, key!) as { k: string }).k;
}

/**
 * The restored volume as its own startup and server read it: migrations apply nothing, a second start applies nothing,
 * no lifecycle row survives from the source, every blob is registered under one generation, and each blob reads back
 * through the started server by the object its row names, with nothing left under its logical key.
 */
async function assertServedAfterStartup(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  expect(migrateOnly(f.paths.databasePath)).toBe(0);
  expect(migrateOnly(f.paths.databasePath)).toBe(0);
  const db = new Database(f.paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT value FROM schema_meta WHERE key = 'version'").get()).toEqual({ value: String(SERVER_SCHEMA_VERSION) });
    // The restored volume carries the schema fence the migration applier created.
    expect((db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'blobs' ORDER BY name").all() as { name: string }[]).map((row) => row.name))
      .toEqual(expect.arrayContaining(['blobs_release_through_journal', 'blobs_require_generation']));
    for (const table of ['object_releases', 'recovery_holds', 'blob_reservations', 'backup_release_candidates']) expect({ table, rows: db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() }).toEqual({ table, rows: { n: 0 } });
    const generations = db.query('SELECT DISTINCT generation FROM blobs').all() as { generation: string | null }[];
    expect(generations).toHaveLength(1);
    expect(generations[0]!.generation).toMatch(/^[0-9a-f-]{36}$/);
  } finally { db.close(); }
  const server = await startDeployment({ databasePath: f.paths.databasePath, blobDir: f.paths.blobDir, port: 0, sourceFrom: 'socket', transport: 'loopback' });
  try {
    for (const { key, text } of f.blobs) {
      const row = (await getBlob(server.env.db, { projectId: 'proj_1' }, key))!;
      expect(row.objectKey).toMatch(new RegExp(`^proj_1/${key}~[0-9a-f-]{36}$`));
      const object = await server.env.blobs.get(row.objectKey);
      expect(object === null ? null : await new Response(object.body).text()).toBe(text);
      expect(fs.existsSync(path.join(f.paths.blobDir, 'proj_1', key))).toBe(false);
    }
  } finally { await server.stop(); }
}

configureSqliteLibrary();

const LEGACY_TEXT = 'legacy blob body';
const legacyKey = createHash('sha256').update(LEGACY_TEXT).digest('hex');

/** A source whose database held one blob registered before generations: seeded before step 42, as it was. */
const legacySource = () => sqliteEnv({ beforeStep42: (db) => legacyBlob(db, { projectId: 'proj_1', key: legacyKey, size: Buffer.byteLength(LEGACY_TEXT) }) });

/** Two stored blobs as a source holds them: the one registered before generations, and one under its own generation. */
async function storedBlobs(source: ReturnType<typeof sqliteEnv>) {
  const held = [];
  for (const [text, generation] of [[LEGACY_TEXT, null], ['generation blob body', crypto.randomUUID()]] as const) {
    const bytes = new TextEncoder().encode(text);
    const key = createHash('sha256').update(bytes).digest('hex');
    if (generation !== null) source.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', ?, ?, 'text/plain', 't', 1, ?)`, [key, bytes.byteLength, generation]);
    await source.bucket.put(blobObjectKey('proj_1', key, generation), new Response(bytes).body);
    held.push({ key, text });
  }
  return held;
}


const RECOVERED_TOOL_ID = uuid(9002);
const RECOVERED_TOOL_INPUT = { text: 'restore input '.repeat(300), file_path: '/repo/recovered.ts' };

async function fixture(target: 'local' | 'cloudflare' = 'cloudflare',
  { legacy = false, configuration = {} as Record<string, unknown>, bundledInput = false, authority = false } = {}) {
  const source = legacySource();
  const blobs = await storedBlobs(source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-recovery-'));
  const artifact = path.join(root, 'artifact');
  const secretsFile = path.join(root, 'independent.env');
  const paths = resolveLocalPaths(path.join(root, 'destination'));
  const secrets = { SECRET_WRAP_KEY: Buffer.alloc(32, 9).toString('base64'), SESSION_SECRET: 'fixture-session-secret-with-thirty-two-bytes',
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret' };
  fs.writeFileSync(secretsFile, Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 });
  const key = wrappingKeyFromText(async () => secrets.SECRET_WRAP_KEY, 'fixture');
  await deploymentSecretStore(source.db, key).put('fixture', 'recovered-secret', 'fixture', 1);
  source.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','memory','user','A durable architecture decision','decision',1)");
  // A switch building to a paid model, and a source embedding passes over, as the source Deployment held them.
  source.sqlite.run(`INSERT INTO embedding_switches (slot, id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, estimated_sources, progressed_at, state, reason, retry_at, failures, started_at, started_by, updated_at)
    VALUES ('deployment', 'recovered-switch', 'workers-ai', '@cf/baai/bge-base-en-v1.5', NULL, 'k2', 'k1', 10, 1, 1, 'building', NULL, NULL, 0, 1, 'mem_machine_1', 1)`);
  source.sqlite.run(`INSERT INTO embedding_source_failures (project_id, type, record_id, model_key, revision, reason, recorded_at)
    VALUES ('proj_1', 'plan', 'gone', '', 'r1', 'its stored text is missing', 1)`);
  const provider = { modelKey: 'fixture-model', embed: async () => [1, 0] };
  await reconcileEmbedding({ db: source.db, blobs: source.bucket, provider,
    vectors: target === 'local' ? sqliteVectorStore(source.sqlite) : cloudflareVectorStore(indexFixture()) }, 'proj_1', 1000);
  if (bundledInput) {
    const now = Date.now();
    const tokenId = seedCredential(source.sqlite, { expiresAt: now + 60_000 });
    expect(await ingestEvent(source.db, { projectId: 'proj_1', machineId: 'machine_1', tokenId,
      bodyBytes: 0, now }, envelope({ eventId: uuid(9001), sessionId: 'sess_recovery_input',
      kind: 'tool.use', payload: { toolCallId: RECOVERED_TOOL_ID, toolName: 'Write',
        input: RECOVERED_TOOL_INPUT, success: true } }), source.serverEnv))
      .toMatchObject({ persisted: true, projected: true });
  }
  const carriedToken = authority ? await issueMemberToken(source.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now()) : null;
  if (authority) {
    seedCredential(source.sqlite, { id: 'carried-live', expiresAt: Date.now() + 60_000 });
    source.sqlite.run("INSERT INTO enrollment_authorities(id,key_hash,created_at,expires_at) VALUES('carried-enrollment','enrollment-hash',1,9999999999999)");
    source.sqlite.run("INSERT INTO identity_link_authorities(id,key_hash,member_id,created_at,expires_at) VALUES('carried-link','link-hash','mem_machine_1',1,9999999999999)");
    source.sqlite.run("INSERT INTO external_grants(id,key_hash,project_id,label,created_by,created_at,expires_at) VALUES('carried-grant','grant-hash','proj_1','fixture','mem_machine_1',1,9999999999999)");
  }
  const backup = await createBackup(source.db, source.bucket, { producer: 'fixture', now: 1000 });
  await setBackupPinned(source.db, backup.id, true);
  await createRecoveryBundle(artifact, {
    source: { target, locator: 'fixture-source' },
    snapshot: async (file) => {
      source.sqlite.query('VACUUM INTO ?').run(file);
      if (legacy) asSchema41(file);
      return { configuration, credentialsRequired: [...LOCAL_SECRET_NAMES] };
    },
    blob: async (object) => {
      // A current snapshot names the object its row registered. A schema-41 snapshot names the logical key, and this
      // fixture's store holds the current layout, so the fixture resolves it the way a schema-41 store held it.
      if (!legacy) expect(object.source).toBe(await sourceKeyOf(source, object.key));
      const held = await source.bucket.get(legacy ? await sourceKeyOf(source, object.key) : object.source);
      if (held === null) throw new Error('missing fixture object');
      return held.body;
    },
  });
  return { source, root, artifact, secretsFile, paths, secrets, key, provider, backup, blobs, carriedToken,
    restore: (report?: (line: string) => void, tenantMode: 'replacement' | 'fork' = 'replacement') => restoreLocalDeployment({ sourceRetired: true, tenantMode, source: artifact, secretsFile, paths, port: 18901, ...(report === undefined ? {} : { report }) }),
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
      // The switch waits for an admin here, and what the rebuilt index passes over is found again.
      expect(db.query('SELECT state, reason, retry_at FROM embedding_switches').all()).toEqual([{ state: 'paused', reason: RECOVERED_SWITCH, retry_at: null }]);
      expect(db.query('SELECT COUNT(*) AS n FROM embedding_source_failures').get()).toEqual({ n: 0 });
      expect(await hasEmbeddingWork(store, 'proj_1', f.provider.modelKey, 2000)).toBe(true);
      const vectors = sqliteVectorStore(db);
      expect(await reconcileEmbedding({ db: store, blobs: diskBlobStore(f.paths.blobDir), provider: f.provider, vectors }, 'proj_1', 2000))
        .toEqual({ phase: 'missing', processed: 1 });
      const search = await searchProject(store, { projectId: 'proj_1' }, { query: 'architecture', mode: 'semantic' }, async () => ({ provider: f.provider, vectors }));
      expect(search.results.map((row) => row.id)).toEqual(['memory']);
    } finally { db.close(); }
    await assertServedAfterStartup(f);
    expect(fs.readFileSync(path.join(f.artifact, 'myco.sqlite'))).toEqual(original);
    await expect(f.restore()).rejects.toThrow('fresh local Deployment directory');
  } finally { f.cleanup(); }
});

it('preserves a native snapshot and its vectors without resetting their ready receipts', async () => {
  const f = await fixture('local');
  try {
    const original = fs.readFileSync(path.join(f.artifact, 'myco.sqlite'));
    expect(await f.restore()).toMatchObject({ rebuildEmbeddings: false });
    const db = new Database(f.paths.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT ready FROM embedding_receipts').all()).toEqual([{ ready: 1 }]);
      // The kept index keeps what it passes over; the switch still waits for an admin here.
      expect(db.query('SELECT COUNT(*) AS n FROM embedding_source_failures').get()).toEqual({ n: 1 });
      expect(db.query('SELECT state, reason FROM embedding_switches').all()).toEqual([{ state: 'paused', reason: RECOVERED_SWITCH }]);
    }
    finally { db.close(); }
    // No embedding rebuild is needed, and the object lifecycle is still reset and the objects named for this volume.
    await assertServedAfterStartup(f);
    expect(fs.readFileSync(path.join(f.artifact, 'myco.sqlite'))).toEqual(original);
  } finally { f.cleanup(); }
});

it('serves a bundled tool input after native restore assigns a fresh object generation', async () => {
  const f = await fixture('local', { bundledInput: true });
  try {
    const sourceProof = f.source.sqlite.query(`SELECT generation FROM registered_content_proofs
      WHERE source_kind='bundle' LIMIT 1`).get() as { generation: string };
    f.source.bucket.objects.clear();
    await f.restore();
    const db = new Database(f.paths.databasePath);
    try {
      const proof = db.query(`SELECT p.generation AS proof_generation,b.generation AS blob_generation
        FROM registered_content_proofs p JOIN blobs b ON b.project_id=p.project_id AND b.key=p.key
        WHERE p.source_kind='bundle' LIMIT 1`).get() as { proof_generation: string; blob_generation: string };
      expect(proof.proof_generation).toBe(proof.blob_generation);
      expect(proof.blob_generation).not.toBe(sourceProof.generation);
      expect(await processedBody({ db: sqliteRelationalStore(db), blobs: diskBlobStore(f.paths.blobDir) },
        { projectId: 'proj_1' }, 'tool-input', RECOVERED_TOOL_ID)).toBe(JSON.stringify(RECOVERED_TOOL_INPUT));
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

it('recovers a schema-41 artifact through the one migration applier, then starts and serves it', async () => {
  const f = await fixture('local', { legacy: true });
  try {
    const original = fs.readFileSync(path.join(f.artifact, 'myco.sqlite'));
    const legacy = new Database(path.join(f.artifact, 'myco.sqlite'), { readonly: true });
    try { expect(legacy.query("SELECT 1 FROM pragma_table_info('blobs') WHERE name = 'generation'").get()).toBeNull(); }
    finally { legacy.close(); }
    // The result names the published volume's schema, and the source artifact keeps the schema it was captured at.
    expect(await f.restore()).toMatchObject({ schemaVersion: SERVER_SCHEMA_VERSION });
    expect(JSON.parse(fs.readFileSync(path.join(f.paths.root, 'recovered-from.json'), 'utf8')).snapshot.schemaVersion).toBe(41);
    await assertServedAfterStartup(f);
    expect(fs.readFileSync(path.join(f.artifact, 'myco.sqlite'))).toEqual(original);
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

it('carries a recorded fleet into the restored native record, leaves its network settings as they were, and says what it carried', async () => {
  const f = await fixture('local', { configuration: { port: 8787, origin: 'https://source.example.test', sourceFrom: 'header', trustedHeader: 'x-forwarded-for', trustedHops: 1, fleet: 3 } });
  try {
    const lines: string[] = [];
    await f.restore((line) => lines.push(line));
    // Only the fleet is carried; the network settings stay this Deployment's own defaults, as native restore published before.
    expect(readLocalRecord(f.paths)).toEqual({ port: 18901, sourceFrom: 'socket', fleet: 3 });
    expect(lines).toContain('Recorded fleet 3 carried to the restored Deployment.');
  } finally { f.cleanup(); }
});

it('publishes no fleet from an artifact that records none, and says its source fleet is unknown', async () => {
  const f = await fixture('local', { configuration: { startedBy: 'mem_1' } });
  try {
    const lines: string[] = [];
    await f.restore((line) => lines.push(line));
    expect(readLocalRecord(f.paths)).toEqual({ port: 18901, sourceFrom: 'socket' });
    expect(lines).toContain('The artifact records no fleet, so its source fleet is unknown; the restored Deployment is published without one, and dispatch applies no fleet bound.');
  } finally { f.cleanup(); }
});

it('refuses a recorded fleet that is not a whole number of runtimes without publishing a destination', async () => {
  const f = await fixture('local', { configuration: { port: 8787, fleet: 'local' } });
  try {
    await expect(f.restore()).rejects.toThrow('not a whole number of runtimes');
    expect(fs.existsSync(f.paths.root)).toBe(false);
  } finally { f.cleanup(); }
});

/**
 * A Deployment that holds no sign-in credentials is still recoverable.
 *
 * `--new-signin` asks for a fresh session secret and only the wrapping key the artifact was sealed under, which is
 * what a self-hosted Deployment that never configured GitHub sign-in has to supply. Without it, such a Deployment
 * could take automatic backups it could never restore.
 */
it('recovers with a fresh sign-in from the wrapping key alone, for a Deployment holding no sign-in credentials', async () => {
  const f = await fixture();
  try {
    // Only the wrapping key, as an owner who configured no GitHub sign-in holds.
    fs.writeFileSync(f.secretsFile, `SECRET_WRAP_KEY=${f.secrets.SECRET_WRAP_KEY}\n`, { mode: 0o600 });
    await expect(restoreLocalDeployment({ sourceRetired: true, source: f.artifact, secretsFile: f.secretsFile, paths: f.paths, port: 18902 }))
      .rejects.toThrow('recovery requires independently supplied SESSION_SECRET');

    const restored = await restoreLocalDeployment({ sourceRetired: true,
      source: f.artifact, secretsFile: f.secretsFile, paths: f.paths, port: 18902, newSignIn: true,
    });
    expect(restored.schemaVersion).toBeGreaterThan(0);
    // The volume is published with a session secret of its own and no sign-in credentials carried over.
    const published = fs.readFileSync(f.paths.secretsFile, 'utf8');
    expect(published).toContain('SECRET_WRAP_KEY=');
    expect(published).toContain('SESSION_SECRET=');
    expect(published).not.toContain('GITHUB_CLIENT_ID=');
  } finally { f.cleanup(); }
});

for (const tenantMode of ['replacement', 'fork'] as const) {
  it(`native ${tenantMode} publishes the approved tenant and copied-authority contract`, async () => {
    const f = await fixture('local', { authority: true });
    try {
      const original = fs.readFileSync(path.join(f.artifact, 'myco.sqlite'));
      const sourceId = f.source.sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string };
      const history = f.source.sqlite.query('SELECT * FROM spores').all();
      await f.restore(undefined, tenantMode);
      const db = new Database(f.paths.databasePath, { readonly: true });
      try {
        const destinationId = db.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string };
        if (tenantMode === 'replacement') expect(destinationId).toEqual(sourceId);
        else expect(destinationId.value).not.toBe(sourceId.value);
        expect(db.query('SELECT * FROM spores').all()).toEqual(history);
        for (const table of ['member_credentials', 'enrollment_authorities', 'identity_link_authorities', 'external_grants']) {
          const live = db.query(`SELECT count(*) AS n FROM ${table} WHERE revoked_at IS NULL`).get() as { n: number };
          if (tenantMode === 'fork') expect(live.n).toBe(0);
          else expect(live.n).toBeGreaterThan(0);
        }
        const published = readLocalSecrets(f.paths);
        if (tenantMode === 'fork') expect(published.SESSION_SECRET).not.toBe(f.secrets.SESSION_SECRET);
        else expect(published.SESSION_SECRET).toBe(f.secrets.SESSION_SECRET);
      } finally { db.close(); }
      const started = await serve({ databasePath: f.paths.databasePath, blobDir: f.paths.blobDir,
        port: 0, bind: 'loopback', transport: 'loopback', sourceFrom: 'socket', wakeLoop: false, ...readLocalSecrets(f.paths) });
      try {
        const origin = `http://127.0.0.1:${started.port}`;
        const oldSession = await signSession(f.secrets.SESSION_SECRET, { aud: sourceId.value, sub: '583231', login: 'fixture', iat: Date.now(), exp: Date.now() + 60_000 });
        expect((await fetch(`${origin}/api/projects`, { headers: { cookie: `${SESSION_COOKIE}=${oldSession}` } })).status)
          .toBe(tenantMode === 'fork' ? 401 : 200);
        expect((await fetch(`${origin}/members/status`, { method: 'POST', headers: memberHeaders(f.carriedToken!.token), body: '{}' })).status)
          .toBe(tenantMode === 'fork' ? 401 : 200);
        const current = await issueMemberToken(started.env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
        expect((await fetch(`${origin}/members/status`, { method: 'POST', headers: memberHeaders(current.token), body: '{}' })).status).toBe(200);
      } finally { await started.stop(); }
      expect(fs.readFileSync(path.join(f.artifact, 'myco.sqlite'))).toEqual(original);
      await assertServedAfterStartup(f);
    } finally { f.cleanup(); }
  });
}

it('replacement requires source retirement; fork permits an independent live source', () => {
  expect(() => assertRecoveryTenantChoice()).toThrow('--source-retired');
  expect(() => assertRecoveryTenantChoice('replacement', true)).not.toThrow();
  expect(() => assertRecoveryTenantChoice('fork')).not.toThrow();
});
