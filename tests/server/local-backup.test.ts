import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupLocalDeployment } from '@myco/server/local-backup.js';
import { resolveLocalPaths, writeLocalRecord } from '@myco/server/local.js';
import { diskBlobStore } from '@myco-server-worker/platform/bun/blobs.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { legacyBlob } from '../myco-server/helpers/d1.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';

it('backs up committed WAL data and exact blob bytes, reading each blob from the object its row registered, without migrating or replacing the source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-local-backup-'));
  const paths = resolveLocalPaths(path.join(root, 'home'));
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  // One blob from before generations, seeded before step 42 as the Deployment's database held it.
  const fixture = sqliteEnv({ beforeStep42: (db) => legacyBlob(db, { projectId: 'proj_1', key: digest, size: bytes.length, mediaType: 'application/octet-stream', tokenId: 'mt_fixture' }) });
  let live: Database | undefined;
  try {
    writeLocalRecord({ port: 8787, sourceFrom: 'socket', fleet: 2 }, paths);
    // The Deployment's own secrets hold sentinel values: public settings are recorded, secret values never are.
    const sentinels = { SECRET_WRAP_KEY: Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET: 'sentinel-session-secret',
      GITHUB_CLIENT_ID: 'sentinel-client-id', GITHUB_CLIENT_SECRET: 'sentinel-client-secret' };
    fs.writeFileSync(paths.secretsFile, Object.entries(sentinels).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 });
    // A blob uploaded under its own generation is stored under that name, and the artifact keeps its logical key.
    const uploaded = new TextEncoder().encode('uploaded under a generation');
    const uploadedDigest = createHash('sha256').update(uploaded).digest('hex');
    const generation = crypto.randomUUID();
    fixture.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES ('proj_1',?,?,'text/plain','mt_fixture',1,?)`, [uploadedDigest, uploaded.length, generation]);
    fixture.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title)
      VALUES ('proj_1','s_backup','m_fixture','mt_fixture',1,1,'Initial title')`);
    const backupKey = 'backups/lineage__1__bk_pinned.jsonl';
    const backupBody = '{"format":"myco-backup/1"}\n';
    fixture.sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned) VALUES ('pinned',?,1,?,'{}',13,'fixture',1)`, [backupKey, Buffer.byteLength(backupBody)]);
    fixture.sqlite.query('VACUUM INTO ?').run(paths.databasePath);
    await diskBlobStore(paths.blobDir).put(`proj_1/${digest}`, new Response(bytes).body, { sha256: digest });
    await diskBlobStore(paths.blobDir).put(backupKey, new Response(backupBody).body);
    await diskBlobStore(paths.blobDir).put(`proj_1/${uploadedDigest}~${generation}`, new Response(uploaded).body, { sha256: uploadedDigest });
    live = new Database(paths.databasePath);
    live.exec('PRAGMA journal_mode=WAL');
    live.run("UPDATE sessions SET title='Committed WAL title' WHERE session_id='s_backup'");
    const version = live.query("SELECT value FROM schema_meta WHERE key='version'").get();
    const destination = path.join(root, 'archive');
    const result = await backupLocalDeployment({ destination, paths });
    expect(result.status).toBe('complete');
    expect(result.snapshot?.blobCount).toBe(2);
    expect(result.snapshot?.configuration).toMatchObject({ port: 8787, sourceFrom: 'socket', fleet: 2 });
    expect(result.snapshot?.credentialsRequired).toEqual([...RECOVERY_CREDENTIAL_NAMES]);
    const manifestText = fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8');
    for (const value of Object.values(sentinels)) expect(manifestText).not.toContain(value);
    for (const name of RECOVERY_CREDENTIAL_NAMES) expect(manifestText).toContain(name);
    const restored = new Database(path.join(destination, 'myco.sqlite'), { readonly: true });
    try {
      expect(restored.query("SELECT title FROM sessions WHERE session_id='s_backup'").get()).toEqual({ title: 'Committed WAL title' });
      expect(restored.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'Committed'").all()).toHaveLength(1);
      expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(restored.query('SELECT pinned, size_bytes FROM backups').get()).toEqual({ pinned: 1, size_bytes: Buffer.byteLength(backupBody) });
    } finally { restored.close(); }
    expect(new Uint8Array(fs.readFileSync(path.join(destination, 'blobs', 'proj_1', digest)))).toEqual(bytes);
    expect(new Uint8Array(fs.readFileSync(path.join(destination, 'blobs', 'proj_1', uploadedDigest)))).toEqual(uploaded);
    expect(fs.readdirSync(path.join(destination, 'blobs', 'proj_1')).sort()).toEqual([digest, uploadedDigest].sort());
    fs.rmSync(path.join(paths.blobDir, backupKey));
    expect(await new Response((await diskBlobStore(path.join(destination, 'blobs')).get(backupKey))!.body).text()).toBe(backupBody);
    expect(live.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual(version);
    expect(live.query("SELECT title FROM sessions WHERE session_id='s_backup'").get()).toEqual({ title: 'Committed WAL title' });
  } finally { live?.close(); fixture.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
