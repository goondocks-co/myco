import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { copyRecoveryBundle, verifyRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { materializeRecoveryStaging } from '@myco/server/recovery-materialize.js';
import { SCHEMA_QUERY, schemaObjects } from '@myco/server/recovery-schema.js';
import { exportedTables } from '@myco/server/recovery-snapshot.js';
import { STAGING_FORMAT } from '@myco/server/recovery-contract.js';
import { quote, stagingFixture as fixture } from './helpers/recovery-staging.js';

it('materializes a staging into a verified artifact that preserves rows, schema and object bytes', async () => {
  const f = fixture();
  try {
    const manifest = await f.materialize();
    expect(manifest.format).toBe('myco-recovery/2');
    expect(manifest.status).toBe('complete');
    expect(manifest.snapshot!.credentialsRequired).toEqual(['MYCO_WRAP_KEY']);
    expect(manifest.snapshot!.configuration).toEqual({ accountId: 'fixture-account', databaseId: 'fixture-database' });
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.blobDigest)))).toEqual(f.bytes);
    expect(fs.readFileSync(path.join(f.destination, 'blobs', f.backupKey), 'utf8')).toBe(f.backupBody);

    // Content and schema, not only counts: every exported table matches the source row for row.
    const recovered = new Database(path.join(f.destination, 'myco.sqlite'), { readonly: true });
    try {
      const schema = schemaObjects.parse(f.source.sqlite.query(SCHEMA_QUERY).all());
      expect(schemaObjects.parse(recovered.query(SCHEMA_QUERY).all())).toEqual(schema);
      for (const table of exportedTables(schema)) {
        const rows = (db: Database) => JSON.stringify(db.query(`SELECT * FROM ${quote(table)}`).all());
        expect(rows(recovered)).toBe(rows(f.source.sqlite));
      }
      expect(recovered.query('SELECT * FROM recovery_fixture').get()).toEqual({ id: 3, body: f.body, bytes: f.bytes });
      expect(recovered.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'Recovered'").all()).toHaveLength(1);
      expect(recovered.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { recovered.close(); }

    // The artifact stands on its own through the existing owner, and copies through it.
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    const copy = path.join(f.root, 'copy');
    expect((await copyRecoveryBundle(f.destination, copy)).status).toBe('complete');
    expect(fs.readFileSync(path.join(copy, 'blobs', f.backupKey), 'utf8')).toBe(f.backupBody);
    // A sequence high-water mark survives, so new rows do not collide with recovered ones.
    const resumed = new Database(path.join(copy, 'myco.sqlite'));
    try { expect(resumed.query("INSERT INTO recovery_fixture(body) VALUES('next') RETURNING id").get()).toEqual({ id: 72 }); } finally { resumed.close(); }
  } finally { f.cleanup(); }
});

it('refuses a raw staging, an incomplete staging and a malformed inventory', async () => {
  const f = fixture();
  try {
    await expect(verifyRecoveryBundle(f.staging)).rejects.toThrow('materialize it first');
    f.write({ ...f.manifest, status: 'open', completedAt: undefined });
    await expect(f.materialize()).rejects.toThrow('recovery staging is incomplete');
    f.write({ ...f.manifest, objects: [...f.manifest.objects, f.manifest.objects[0]!] });
    await expect(f.materialize()).rejects.toThrow('repeats an object key');
    f.write({ ...f.manifest, objects: [{ key: `proj_1/${f.blobDigest}`, bytes: -1, sha256: f.blobDigest }] });
    await expect(f.materialize()).rejects.toThrow();
    f.write({ ...f.manifest, format: 'myco-recovery/2' });
    await expect(f.materialize()).rejects.toThrow();
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses altered staged SQL, an altered schema capture and schema drift', async () => {
  const f = fixture();
  try {
    const sqlFile = path.join(f.staging, 'd1.sql');
    const held = fs.readFileSync(sqlFile, 'utf8');
    fs.writeFileSync(sqlFile, held.replace('Recovered 🌱 title', 'Tampered 🌱 title'));
    await expect(f.materialize(path.join(f.root, 'altered-sql'))).rejects.toThrow('SQL export does not match its recorded fingerprint');
    fs.writeFileSync(sqlFile, held);

    const schemaFile = path.join(f.staging, 'schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')) as Array<{ name: string; type: string; sql: string }>;
    const drifted = schema.map((row) => (row.name === 'sessions' && row.type === 'table' ? { ...row, sql: `${row.sql} -- drift` } : row));
    fs.writeFileSync(schemaFile, JSON.stringify(drifted));
    await expect(f.materialize(path.join(f.root, 'altered-schema'))).rejects.toThrow('schema capture does not match its recorded fingerprint');

    // A capture that disagrees with the export's own table definitions is drift, and the fingerprint follows it.
    f.write({ ...f.manifest, schema: f.fingerprint(schemaFile) });
    await expect(f.materialize(path.join(f.root, 'drifted'))).rejects.toThrow('exported database schema does not match its source');
    expect(fs.existsSync(path.join(f.root, 'drifted', 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses a missing object, an altered object and a mismatched inventory entry', async () => {
  const f = fixture();
  try {
    const object = path.join(f.staging, 'objects', 'proj_1', f.blobDigest);
    const held = fs.readFileSync(object);
    fs.rmSync(object);
    await expect(f.materialize(path.join(f.root, 'missing-object'))).rejects.toThrow(`recovery staging is missing objects/proj_1/${f.blobDigest}`);
    fs.writeFileSync(object, new Uint8Array([9, 9, 9, 9, 9]));
    await expect(f.materialize(path.join(f.root, 'altered-object'))).rejects.toThrow(`object proj_1/${f.blobDigest} does not match its recorded fingerprint`);
    fs.writeFileSync(object, held);
    f.write({ ...f.manifest, objects: [{ key: `proj_1/${f.blobDigest}`, bytes: 4, sha256: f.blobDigest }, f.manifest.objects[1]!] });
    await expect(f.materialize(path.join(f.root, 'wrong-size'))).rejects.toThrow('different size than its snapshot');
    f.write({ ...f.manifest, objects: [f.manifest.objects[1]!] });
    await expect(f.materialize(path.join(f.root, 'missing-entry'))).rejects.toThrow('1 absent');
  } finally { f.cleanup(); }
});

it('refuses an overlapping destination, a symlinked staging and a staging for another Deployment', async () => {
  const f = fixture();
  try {
    await expect(materializeRecoveryStaging({ staging: f.staging, destination: path.join(f.staging, 'inside') }))
      .rejects.toThrow('must not overlap');
    const link = path.join(f.root, 'linked-staging');
    fs.symlinkSync(f.staging, link);
    await expect(materializeRecoveryStaging({ staging: link, destination: path.join(f.root, 'from-link') }))
      .rejects.toThrow('must be a directory, not a symlink');
    fs.rmSync(path.join(f.staging, 'schema.json'));
    fs.symlinkSync(path.join(f.root, 'elsewhere.json'), path.join(f.staging, 'schema.json'));
    await expect(f.materialize()).rejects.toThrow('must be a regular file');

    const second = fixture();
    try {
      await second.materialize();
      second.write({ ...second.manifest, source: { target: 'cloudflare', locator: 'other-account/other-database/other-bucket' } });
      await expect(second.materialize()).rejects.toThrow('belongs to another Deployment');
    } finally { second.cleanup(); }
  } finally { f.cleanup(); }
});
