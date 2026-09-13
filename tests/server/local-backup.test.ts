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

it('backs up committed WAL data and exact blob bytes without migrating or replacing the source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-local-backup-'));
  const paths = resolveLocalPaths(path.join(root, 'home'));
  const fixture = sqliteEnv();
  let live: Database | undefined;
  try {
    writeLocalRecord({ port: 8787, sourceFrom: 'socket' }, paths);
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    fixture.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at)
      VALUES ('proj_1',?,?,'application/octet-stream','mt_fixture',1)`, [digest, bytes.length]);
    fixture.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title)
      VALUES ('proj_1','s_backup','m_fixture','mt_fixture',1,1,'Initial title')`);
    fixture.sqlite.query('VACUUM INTO ?').run(paths.databasePath);
    await diskBlobStore(paths.blobDir).put(`proj_1/${digest}`, new Response(bytes).body, { sha256: digest });
    live = new Database(paths.databasePath);
    live.exec('PRAGMA journal_mode=WAL');
    live.run("UPDATE sessions SET title='Committed WAL title' WHERE session_id='s_backup'");
    const version = live.query("SELECT value FROM schema_meta WHERE key='version'").get();
    const destination = path.join(root, 'archive');
    const result = await backupLocalDeployment({ destination, paths });
    expect(result.status).toBe('complete');
    expect(result.snapshot?.blobCount).toBe(1);
    expect(result.snapshot?.configuration).toMatchObject({ port: 8787, sourceFrom: 'socket' });
    expect(result.snapshot?.credentialsRequired).toContain('SECRET_WRAP_KEY');
    const restored = new Database(path.join(destination, 'myco.sqlite'), { readonly: true });
    try {
      expect(restored.query("SELECT title FROM sessions WHERE session_id='s_backup'").get()).toEqual({ title: 'Committed WAL title' });
      expect(restored.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'Committed'").all()).toHaveLength(1);
      expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { restored.close(); }
    expect(new Uint8Array(fs.readFileSync(path.join(destination, 'blobs', 'proj_1', digest)))).toEqual(bytes);
    expect(live.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual(version);
    expect(live.query("SELECT title FROM sessions WHERE session_id='s_backup'").get()).toEqual({ title: 'Committed WAL title' });
  } finally { live?.close(); fixture.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
