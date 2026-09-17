import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { restoreCloudflareDeployment } from '@myco/server/cloudflare-recovery.js';
import { readDeploymentRecord } from '@myco/server/cloudflare.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';
import type { CommandRunner } from '@myco/server/runner.js';
import type { CloudflareFetch } from '@myco/server/cloudflare.js';
import { createHash } from 'node:crypto';
import { SCHEMA_STEPS } from '../../packages/myco-server/src/db/schema.js';
import { migrationFileName } from '../../packages/myco-server/src/db/migrate.js';
import { SERVER_SCHEMA_VERSION } from '../../packages/myco-server/src/constants.js';
import { sqliteRelationalStore } from '../../packages/myco-server/src/platform/bun/sqlite.js';
import { deploymentSecretStore } from '../../packages/myco-server/src/core/secrets.js';
import { wrappingKeyFromText } from '../../packages/myco-server/src/platform/wrapping-key.js';

/** Rewrites a current snapshot as a schema-41 Deployment captured it: no object lifecycle, no generation column. */
function asSchema41(file: string): void {
  const db = new Database(file);
  try {
    for (const table of ['object_releases', 'blob_release_candidates', 'backup_release_candidates', 'recovery_holds', 'restore_reference_guard']) db.run(`DROP TABLE ${table}`);
    db.run('DROP INDEX idx_blob_reservations_expiry');
    db.run('ALTER TABLE blobs DROP COLUMN generation');
    db.run("UPDATE schema_meta SET value = '41' WHERE key = 'version'");
  } finally { db.close(); }
}

async function fixture(failVectorRead = false, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hosted-recovery-'));
  const source = path.join(root, 'artifact');
  const mycoHome = path.join(root, 'home');
  const secretsFile = path.join(root, 'independent.env');
  const data = seededSqlite();
  const wrapKey = Buffer.alloc(32, 7).toString('base64');
  const key = wrappingKeyFromText(async () => wrapKey, 'fixture');
  await deploymentSecretStore(sqliteRelationalStore(data), key).put('fixture', 'sealed-fixture-value', 'fixture', 1);
  data.exec("INSERT INTO schema_meta(key,value) VALUES('fixture_note','keep this finding')");
  // One blob registered before generations and one under its own generation, each held under its own name at the source.
  const bodies = new Map<string, string>();
  const sourceObjects = new Map<string, string>();
  for (const [text, generation] of [['legacy hosted body', null], ['generation hosted body', crypto.randomUUID()]] as const) {
    const key = createHash('sha256').update(text).digest('hex');
    data.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', ?, ?, 'text/plain', 't', 1, ?)`, [key, Buffer.byteLength(text), generation]);
    bodies.set(key, text);
    sourceObjects.set(generation === null ? `proj_1/${key}` : `proj_1/${key}~${generation}`, text);
  }
  await createRecoveryBundle(source, {
    source: { target: 'cloudflare', locator: 'original' },
    snapshot: async (file) => {
      data.query('VACUUM INTO ?').run(file);
      if (legacy) asSchema41(file);
      return { configuration: { fleet: 2 }, credentialsRequired: [] };
    },
    blob: async (object) => {
      const held = legacy ? [...sourceObjects].find(([name]) => name.startsWith(object.key))?.[1] : sourceObjects.get(object.source);
      if (held === undefined) throw new Error('unexpected blob');
      return new Response(held).body!;
    },
  });
  data.close();
  fs.writeFileSync(secretsFile, `SECRET_WRAP_KEY=${Buffer.alloc(32, 7).toString('base64')}\nSESSION_SECRET=fixture-session\nGITHUB_CLIENT_ID=fixture-client\nGITHUB_CLIENT_SECRET=fixture-client-secret\n`, { mode: 0o600 });
  const destination = new Database(':memory:');
  let loseImport = true;
  let creates = 0;
  const deployments: string[] = [];
  const secretCommands: string[] = [];
  const runner: CommandRunner = { async run(_command, args, options) {
    const flat = args.slice(2).join(' ');
    const answer = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
    if (flat === '--version') return answer('4.126.0');
    if (flat === 'whoami') return answer('fixture');
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('fixture-account');
    if (flat === 'd1 list --json' || flat === 'vectorize list --json') return answer('[]');
    if (flat.startsWith('d1 create')) { creates++; return answer('11111111-2222-4333-8444-555555555555'); }
    if (flat.startsWith('r2 bucket create') || flat.startsWith('vectorize create ')) { creates++; return answer(); }
    if (flat.startsWith('vectorize get ')) {
      if (failVectorRead) { failVectorRead = false; return answer('filter preparation unavailable', 1); }
      return answer(JSON.stringify({ config: { dimensions: VECTOR_INDEX_DIMENSIONS, metric: 'cosine' } }));
    }
    if (flat.startsWith('vectorize list-metadata-index ')) return answer(JSON.stringify(VECTOR_METADATA_FIELDS.map(propertyName => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' }))));
    if (flat.startsWith('secrets-store store list')) return answer('f'.repeat(32));
    if (flat.startsWith('secrets-store secret create') || flat.startsWith('secret ')) { secretCommands.push(flat); return answer(); }
    if (flat.startsWith('deployments list')) return answer('Worker not found [code: 10007]', 1);
    if (flat.startsWith('auth token')) return answer(JSON.stringify({ type: 'oauth', token: 'fixture-operator-token' }));
    if (args.includes('--command')) return answer(JSON.stringify([{ success: true, results: destination.query(args[args.indexOf('--command') + 1]!).all() }]));
    if (args.includes('--file')) {
      const file = args[args.indexOf('--file') + 1]!;
      destination.transaction(() => destination.exec(fs.readFileSync(file, 'utf8')))();
      if (loseImport && file.endsWith('/snapshot.sql')) { loseImport = false; throw new Error('lost reply'); }
      return answer();
    }
    if (flat.startsWith('d1 migrations apply')) return answer();
    if (flat.startsWith('deploy ')) {
      expect(readDeploymentRecord(mycoHome)).toBeNull();
      const config = fs.readFileSync(path.join(options!.cwd!, args[args.indexOf('-c') + 1]!), 'utf8');
      deployments.push(config);
      expect(destination.query("SELECT value FROM schema_meta WHERE key='fixture_note'").get()).toEqual({ value: 'keep this finding' });
      return answer('Current Version ID: 11111111-2222-4333-8444-555555555555\nhttps://fixture.account.workers.dev');
    }
    throw new Error(`unexpected ${flat}`);
  } };
  const stored = new Map<string, string>();
  const fetchObject: CloudflareFetch = async (url, init) => {
    const key = decodeURIComponent(url.slice(url.indexOf('/objects/') + '/objects/'.length));
    if (init.method === 'PUT') {
      stored.set(key, await new Response(init.body as Blob).text());
      return Response.json({ success: true });
    }
    return stored.has(key) ? new Response(stored.get(key)!) : new Response('absent', { status: 404 });
  };
  return { source, secretsFile, mycoHome, destination, deployments, secretCommands, key, wrapKey, creates: () => creates, bodies, stored,
    restore: (newSignIn = false) => restoreCloudflareDeployment({ source, secretsFile, mycoHome, accountId: 'fixture-account', runner, newSignIn, fetch: fetchObject }),
    cleanup: () => { destination.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('resumes data transfer on the same fresh resources and publishes only after bootstrap and credentials', async () => {
  const f = await fixture();
  try {
    const original = fs.readFileSync(path.join(f.source, 'myco.sqlite'));
    await expect(f.restore()).rejects.toThrow('Cloudflare recovery import did not finish');
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
    const journalFile = path.join(f.mycoHome, 'server', 'cloudflare', 'recovery.json');
    const { vectorProvisioned: _vectorProvisioned, ...legacyJournal } = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    fs.writeFileSync(journalFile, JSON.stringify(legacyJournal));
    const result = await f.restore();
    expect(result.record.fleet).toBe(2);
    expect(result.record.workerName).toMatch(/^myco-recovery-/);
    // Four resources, each created once: the database, the blob store, the recovery staging store, and the index.
    expect(f.creates()).toBe(4);
    expect(f.deployments).toHaveLength(2);
    expect(f.deployments[0]).not.toContain('d1_databases');
    expect(f.deployments[0]).not.toContain('triggers');
    expect(f.deployments[1]).toContain('MYCO_ORIGIN = "https://fixture.account.workers.dev"');
    expect(readDeploymentRecord(f.mycoHome)).toEqual(result.record);
    expect(fs.readFileSync(path.join(f.source, 'myco.sqlite'))).toEqual(original);
    assertRestoredObjects(f);
    await expect(f.restore()).rejects.toThrow('fresh MYCO_HOME');
  } finally { f.cleanup(); }
});

/**
 * The replacement database and bucket as the restore published them: every step is recorded once, the schema is the
 * bundled one, no lifecycle row survives from the source, and each blob is stored under the one generation the
 * restored rows register, never under its logical key.
 */
function assertRestoredObjects(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.destination.query("SELECT value FROM schema_meta WHERE key = 'version'").get()).toEqual({ value: String(SERVER_SCHEMA_VERSION) });
  expect((f.destination.query('SELECT name FROM d1_migrations ORDER BY name').all() as { name: string }[]).map((row) => row.name))
    .toEqual(SCHEMA_STEPS.map(migrationFileName));
  for (const table of ['object_releases', 'recovery_holds', 'blob_reservations', 'backup_release_candidates']) {
    expect({ table, rows: f.destination.query(`SELECT COUNT(*) AS n FROM ${table}`).get() }).toEqual({ table, rows: { n: 0 } });
  }
  const rows = f.destination.query('SELECT key, generation FROM blobs ORDER BY key').all() as { key: string; generation: string }[];
  expect(new Set(rows.map((row) => row.generation)).size).toBe(1);
  expect(rows[0]!.generation).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.fromEntries(f.stored)).toEqual(Object.fromEntries(rows.map((row) => [`proj_1/${row.key}~${row.generation}`, f.bodies.get(row.key)!])));
}

it('restores a schema-41 artifact through the one migration applier, and copies each blob under the generation its restored row registers', async () => {
  const f = await fixture(false, { legacy: true });
  try {
    const original = fs.readFileSync(path.join(f.source, 'myco.sqlite'));
    await expect(f.restore()).rejects.toThrow('Cloudflare recovery import did not finish');
    await f.restore();
    assertRestoredObjects(f);
    expect(fs.readFileSync(path.join(f.source, 'myco.sqlite'))).toEqual(original);
  } finally { f.cleanup(); }
});

it('keeps the explicit sign-in choice across retry and installs no recovered GitHub credentials in new-signin mode', async () => {
  const f = await fixture();
  try {
    await expect(f.restore(true)).rejects.toThrow('Cloudflare recovery import did not finish');
    await expect(f.restore(false)).rejects.toThrow('same sign-in choice');
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
    fs.writeFileSync(f.secretsFile, `SECRET_WRAP_KEY=${f.wrapKey}\n`, { mode: 0o600 });
    await f.restore(true);
    expect(await deploymentSecretStore(sqliteRelationalStore(f.destination), f.key).get('fixture')).toBe('sealed-fixture-value');
    expect(f.secretCommands.some(command => command.startsWith('secret put SESSION_SECRET'))).toBe(true);
    expect(f.secretCommands.some(command => command.startsWith('secret bulk'))).toBe(false);
  } finally { f.cleanup(); }
});

it('resumes filter preparation on a confirmed index without adopting or recreating a resource', async () => {
  const f = await fixture(true);
  try {
    await expect(f.restore()).rejects.toThrow('filter preparation unavailable');
    const file = path.join(f.mycoHome, 'server', 'cloudflare', 'recovery.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(journal.vectorProvisioned).toBe(true);
    expect(journal.vectorCreated).toBe(false);
    expect(journal.pending).toBeUndefined();
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
    await expect(f.restore()).rejects.toThrow('Cloudflare recovery import did not finish');
    await f.restore();
    // Four resources, each created once: the database, the blob store, the recovery staging store, and the index.
    expect(f.creates()).toBe(4);
    // The staging store belongs to the replacement Worker, not to a name every Deployment would share.
    expect(readDeploymentRecord(f.mycoHome)?.recoveryBucketName).toBe(`${journal.name}-recovery`);
    expect(readDeploymentRecord(f.mycoHome)?.workerName).toBe(journal.name);
  } finally { f.cleanup(); }
});

it('refuses unconfirmed provisioning instead of creating another resource on retry', async () => {
  const f = await fixture();
  try {
    await expect(f.restore()).rejects.toThrow('did not finish');
    const file = path.join(f.mycoHome, 'server', 'cloudflare', 'recovery.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...journal, pending: `D1 ${journal.name}` }));
    await expect(f.restore()).rejects.toThrow('unconfirmed D1');
    // Four resources, each created once: the database, the blob store, the recovery staging store, and the index.
    expect(f.creates()).toBe(4);
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
  } finally { f.cleanup(); }
});
