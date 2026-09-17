import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createBackup } from '@myco-server-worker/core/backup.js';
import { copyRecoveryBundle, copyRecoveryObjects, createRecoveryBundle, preparedObjectKeys, verifyRecoveryBundle, type RecoveryAdapter, type RecoveryObjectDestination } from '@myco/server/recovery-bundle.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

function fixture() {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recovery-'));
  const destination = path.join(root, 'backup');
  const bodies = new Map<string, string>();
  for (const body of ['first content', 'second content']) {
    const key = createHash('sha256').update(body).digest('hex');
    bodies.set(`proj_1/${key}`, body);
    source.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at)
      VALUES ('proj_1',?,?,'text/plain','mt_fixture',1)`, [key, Buffer.byteLength(body)]);
  }
  let snapshots = 0;
  const reads: string[] = [];
  const adapter: RecoveryAdapter = {
    source: { target: 'local', locator: 'fixture-source' },
    snapshot: async (file) => {
      snapshots += 1;
      source.sqlite.query('VACUUM INTO ?').run(file);
      return { configuration: { port: 8787 }, credentialsRequired: ['SECRET_WRAP_KEY'] };
    },
    blob: async (blob) => {
      reads.push(blob.key);
      const body = bodies.get(blob.key);
      if (body === undefined) throw new Error('fixture content unavailable');
      return new Response(body).body!;
    },
  };
  return { source, root, destination, bodies, adapter, reads, snapshots: () => snapshots,
    manifest: () => JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8')),
    cleanup: () => { source.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const digestOf = (body: string): string => createHash('sha256').update(body).digest('hex');

/** A catalogued backup; `recorded: false` is a row written before backups recorded their digest. */
function addBackup(f: ReturnType<typeof fixture>, id = 'pinned', { recorded = true } = {}) {
  const key = `backups/lineage__1__bk_${id}.jsonl`;
  const body = JSON.stringify({ format: 'myco-backup/1', deployment_id: 'lineage' });
  f.source.sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
    VALUES (?,?,1,?,'{}',13,'fixture',1,?)`, [id, key, Buffer.byteLength(body), recorded ? digestOf(body) : null]);
  f.bodies.set(key, body);
  return { key, body, bytes: Buffer.byteLength(body) };
}

/** The same number of bytes as `body` with different content. */
const sameLengthSubstitute = (body: string): string => body.replace('lineage', 'LINEAGE');

describe('verified recovery artifacts', () => {
  it('resumes verified object transfers after an interrupted upload, including pinned backups', async () => {
    const f = fixture();
    try {
      addBackup(f);
      await createRecoveryBundle(f.destination, f.adapter);
      const original = fs.readFileSync(path.join(f.destination, 'myco.sqlite'));
      const objects = new Map<string, string>();
      let fail = true;
      const target: RecoveryObjectDestination = {
        get: async (key) => objects.has(key) ? new Response(objects.get(key)!).body : null,
        put: async (key, body) => {
          if (fail && objects.size === 1) throw new Error('upload interrupted');
          objects.set(key, await body().text());
        },
      };
      await expect(copyRecoveryObjects(f.destination, target, preparedObjectKeys(path.join(f.destination, 'myco.sqlite')))).rejects.toThrow('upload interrupted');
      expect(objects.size).toBe(1);
      fail = false;
      expect(await copyRecoveryObjects(f.destination, target, preparedObjectKeys(path.join(f.destination, 'myco.sqlite')))).toEqual({ copied: 2, reused: 1 });
      expect(await copyRecoveryObjects(f.destination, target, preparedObjectKeys(path.join(f.destination, 'myco.sqlite')))).toEqual({ copied: 0, reused: 3 });
      expect(objects).toEqual(f.bodies);
      expect(fs.readFileSync(path.join(f.destination, 'myco.sqlite'))).toEqual(original);
    } finally { f.cleanup(); }
  });

  it('reads each blob from the object its snapshot row registered, keeps artifact paths logical, and refuses a row outside the stored grammar', async () => {
    const f = fixture();
    try {
      const [legacy, current] = [...f.bodies.keys()].map((logical) => logical.split('/')[1]!);
      const generation = crypto.randomUUID();
      f.source.sqlite.run('UPDATE blobs SET generation = ? WHERE key = ?', [generation, current]);
      const sources: string[] = [];
      const adapter: RecoveryAdapter = { ...f.adapter, blob: async (object) => { sources.push(object.source); return f.adapter.blob(object, ''); } };
      await createRecoveryBundle(f.destination, adapter);
      expect(sources.sort()).toEqual([`proj_1/${legacy}`, `proj_1/${current}~${generation}`].sort());
      for (const [logical, body] of f.bodies) expect(fs.readFileSync(path.join(f.destination, 'blobs', ...logical.split('/')), 'utf8')).toBe(body);

      const malformed = path.join(f.root, 'malformed');
      // A substituted mapping no writer produces: the stored CHECK is set aside to plant it in the snapshot's source.
      f.source.sqlite.run('PRAGMA ignore_check_constraints = ON');
      f.source.sqlite.run(`UPDATE blobs SET generation = '../${generation.slice(3)}' WHERE key = ?`, [current]);
      await expect(createRecoveryBundle(malformed, adapter)).rejects.toThrow();
      expect(fs.existsSync(path.join(malformed, 'recovery.json')) && JSON.parse(fs.readFileSync(path.join(malformed, 'recovery.json'), 'utf8')).status === 'complete').toBe(false);
    } finally { f.cleanup(); }
  });

  it('writes restored objects under the generation the prepared database registers, and refuses a prepared database that registers other blobs before writing', async () => {
    const f = fixture();
    try {
      await createRecoveryBundle(f.destination, f.adapter);
      const prepared = path.join(f.root, 'prepared.sqlite');
      fs.copyFileSync(path.join(f.destination, 'myco.sqlite'), prepared);
      const generation = crypto.randomUUID();
      const db = new Database(prepared);
      try { db.run('UPDATE blobs SET generation = ?', [generation]); } finally { db.close(); }
      const objects = new Map<string, string>();
      const target: RecoveryObjectDestination = {
        get: async (key) => objects.has(key) ? new Response(objects.get(key)!).body : null,
        put: async (key, body) => { objects.set(key, await body().text()); },
      };
      expect(await copyRecoveryObjects(f.destination, target, preparedObjectKeys(prepared))).toEqual({ copied: 2, reused: 0 });
      expect([...objects.keys()].sort()).toEqual([...f.bodies.keys()].map((logical) => `${logical}~${generation}`).sort());

      const other = new Database(prepared);
      try { other.run('DELETE FROM blobs WHERE rowid = (SELECT MIN(rowid) FROM blobs)'); } finally { other.close(); }
      let writes = 0;
      const counting: RecoveryObjectDestination = { get: async () => null, put: async () => { writes += 1; } };
      await expect(copyRecoveryObjects(f.destination, counting, preparedObjectKeys(prepared))).rejects.toThrow('does not register');
      expect(writes).toBe(0);
    } finally { f.cleanup(); }
  });

  it('refuses different destination bytes and detects an acknowledged but corrupt upload', async () => {
    const f = fixture();
    try {
      await createRecoveryBundle(f.destination, f.adapter);
      let writes = 0;
      const occupied: RecoveryObjectDestination = {
        get: async () => new Response('unrelated bytes').body,
        put: async () => { writes++; },
      };
      await expect(copyRecoveryObjects(f.destination, occupied, preparedObjectKeys(path.join(f.destination, 'myco.sqlite')))).rejects.toThrow('different bytes');
      expect(writes).toBe(0);
      const corrupt: RecoveryObjectDestination = {
        get: async () => writes === 0 ? null : new Response('wrong').body,
        put: async () => { writes++; },
      };
      await expect(copyRecoveryObjects(f.destination, corrupt, preparedObjectKeys(path.join(f.destination, 'myco.sqlite')))).rejects.toThrow('persisted verification');
      expect(writes).toBe(1);
    } finally { f.cleanup(); }
  });

  it('copies exact snapshot evidence and refuses changed source metadata on a repeat copy', async () => {
    const f = fixture();
    try {
      addBackup(f);
      const source = await createRecoveryBundle(f.destination, f.adapter);
      const destination = path.join(f.root, 'recovered');
      const copied = await copyRecoveryBundle(f.destination, destination);
      expect(copied.snapshot).toEqual(source.snapshot);
      expect(copied.format).toBe('myco-recovery/2');
      expect(fs.readFileSync(path.join(destination, 'myco.sqlite'))).toEqual(fs.readFileSync(path.join(f.destination, 'myco.sqlite')));
      const changed = f.manifest();
      changed.snapshot.configuration.port = 9000;
      fs.writeFileSync(path.join(f.destination, 'recovery.json'), JSON.stringify(changed));
      await expect(copyRecoveryBundle(f.destination, destination)).rejects.toThrow('different source snapshot');
      expect(JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8'))).toEqual(copied);
    } finally { f.cleanup(); }
  });

  it('resumes catalogued backup copies with persisted digests and verifies them offline', async () => {
    const f = fixture();
    try {
      const first = addBackup(f, 'first');
      const second = addBackup(f, 'second');
      await expect(createRecoveryBundle(f.destination, { ...f.adapter, blob: async (blob, workDir) => {
        if (blob.key === second.key) throw new Error('backup source unavailable');
        return f.adapter.blob(blob, workDir);
      } })).rejects.toThrow('backup source unavailable');
      expect(f.manifest().status).toBe('content');
      expect(f.manifest().backupObjects).toEqual([{ key: first.key, bytes: Buffer.byteLength(first.body),
        sha256: createHash('sha256').update(first.body).digest('hex') }]);
      f.bodies.delete(first.key);
      const result = await createRecoveryBundle(f.destination, f.adapter);
      expect(result.format).toBe('myco-recovery/2');
      expect(result.status).toBe('complete');
      expect(f.snapshots()).toBe(1);
      expect(f.reads.filter((key) => key === first.key)).toHaveLength(1);
      expect(fs.readFileSync(path.join(f.destination, 'blobs', first.key), 'utf8')).toBe(first.body);
      f.bodies.clear();
      expect(await createRecoveryBundle(f.destination, f.adapter)).toEqual(result);
      const file = path.join(f.destination, 'blobs', second.key);
      fs.writeFileSync(file, second.body.replace('lineage', 'changed'));
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('completed recovery blob no longer matches');
      expect(fs.readFileSync(file, 'utf8')).toContain('changed');
    } finally { f.cleanup(); }
  });

  it('does not certify incomplete backup coverage or trust uncatalogued receipt paths', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f, 'pinned', { recorded: false });
      f.bodies.set(backup.key, 'truncated');
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('unexpected size');
      expect(f.manifest().status).toBe('content');
      expect(f.manifest().backupObjects).toEqual([]);
      expect(fs.existsSync(path.join(f.destination, 'blobs', backup.key))).toBe(false);
      f.bodies.set(backup.key, backup.body);
      await createRecoveryBundle(f.destination, f.adapter);
      const saved = f.manifest();
      for (const backupObjects of [[], [{ ...saved.backupObjects[0], key: '../outside' }],
        [...saved.backupObjects, ...saved.backupObjects]]) {
        fs.writeFileSync(path.join(f.destination, 'recovery.json'), JSON.stringify({ ...saved, backupObjects }));
        await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('backup coverage');
      }
    } finally { f.cleanup(); }
  });

  it('refuses a same-length substitute for a catalogued backup with a recorded digest and keeps the last complete artifact usable', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f);
      const lastGood = await createRecoveryBundle(f.destination, f.adapter);
      const substitute = sameLengthSubstitute(backup.body);
      expect(Buffer.byteLength(substitute)).toBe(backup.bytes);
      f.bodies.set(backup.key, substitute);
      const next = path.join(f.root, 'next');
      await expect(createRecoveryBundle(next, f.adapter)).rejects.toThrow(`recovery object ${backup.key} was not stored: stored bytes do not match the declared sha256 digest`);
      const attempted = JSON.parse(fs.readFileSync(path.join(next, 'recovery.json'), 'utf8'));
      expect(attempted.status).toBe('content');
      expect(attempted.backupObjects).toEqual([]);
      expect(fs.readdirSync(path.join(next, 'blobs', 'backups'))).toEqual([]);
      expect(await verifyRecoveryBundle(f.destination)).toEqual(lastGood);
      expect(fs.readFileSync(path.join(f.destination, 'blobs', backup.key), 'utf8')).toBe(backup.body);
      f.bodies.set(backup.key, backup.body);
      expect(await createRecoveryBundle(next, f.adapter)).toMatchObject({
        status: 'complete', backupObjects: [{ key: backup.key, bytes: backup.bytes, sha256: digestOf(backup.body) }],
      });
    } finally { f.cleanup(); }
  });

  it('refuses a backup copy and receipt that agree with each other but not with the digest recorded at creation', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f);
      await createRecoveryBundle(f.destination, f.adapter);
      const substitute = sameLengthSubstitute(backup.body);
      const file = path.join(f.destination, 'blobs', backup.key);
      fs.writeFileSync(file, substitute);
      const saved = f.manifest();
      saved.backupObjects = [{ key: backup.key, bytes: backup.bytes, sha256: digestOf(substitute) }];
      fs.writeFileSync(path.join(f.destination, 'recovery.json'), JSON.stringify(saved));
      f.bodies.clear();
      await expect(verifyRecoveryBundle(f.destination)).rejects.toThrow('recovery backup coverage does not match its database');
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('recovery backup coverage does not match its database');
      expect(fs.readFileSync(file, 'utf8')).toBe(substitute);
      expect(f.manifest()).toEqual(saved);
    } finally { f.cleanup(); }
  });

  it('carries a backup the server wrote through recovery under the digest recorded at its creation', async () => {
    const f = fixture();
    try {
      const written = await createBackup(f.source.db, f.source.bucket, { producer: 'mem_fixture', now: 2 });
      const adapter: RecoveryAdapter = { ...f.adapter, blob: async (object, workDir) => {
        if (object.key !== written.key) return f.adapter.blob(object, workDir);
        return (await f.source.bucket.get(written.key))!.body;
      } };
      const result = await createRecoveryBundle(f.destination, adapter);
      expect(result).toMatchObject({ status: 'complete', backupObjects: [{ key: written.key, bytes: written.size_bytes, sha256: written.sha256 }] });
      expect(createHash('sha256').update(fs.readFileSync(path.join(f.destination, 'blobs', written.key))).digest('hex')).toBe(written.sha256!);
      const copied = await copyRecoveryBundle(f.destination, path.join(f.root, 'copied'));
      expect(copied).toMatchObject({ status: 'complete', backupObjects: [{ key: written.key, sha256: written.sha256 }] });
    } finally { f.cleanup(); }
  });

  it('keeps a catalogued backup with no recorded digest recoverable by size and reports that no creation digest exists', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f, 'legacy', { recorded: false });
      const reports: string[] = [];
      const result = await createRecoveryBundle(f.destination, f.adapter, (line) => reports.push(line));
      expect(result).toMatchObject({ status: 'complete', backupObjects: [{ key: backup.key, bytes: backup.bytes, sha256: digestOf(backup.body) }] });
      expect(reports).toContain('1 catalogued backup object has no digest recorded at creation; its copy is checked by size only');
      const snapshot = new Database(path.join(f.destination, 'myco.sqlite'), { readonly: true });
      try { expect(snapshot.query('SELECT sha256 FROM backups').all()).toEqual([{ sha256: null }]); } finally { snapshot.close(); }
      expect(f.source.sqlite.query('SELECT sha256 FROM backups').all()).toEqual([{ sha256: null }]);
      expect(await verifyRecoveryBundle(f.destination)).toEqual(result);
    } finally { f.cleanup(); }
  });

  it('reads a snapshot whose schema predates recorded backup digests', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f, 'legacy', { recorded: false });
      const adapter: RecoveryAdapter = { ...f.adapter, snapshot: async (file, workDir) => {
        const captured = await f.adapter.snapshot(file, workDir);
        const older = new Database(file);
        try {
          older.exec('ALTER TABLE backups DROP COLUMN sha256');
          older.exec("UPDATE schema_meta SET value = '40' WHERE key = 'version'");
        } finally { older.close(); }
        return captured;
      } };
      const result = await createRecoveryBundle(f.destination, adapter);
      expect(result).toMatchObject({ status: 'complete', snapshot: { schemaVersion: 40 }, backupObjects: [{ key: backup.key, bytes: backup.bytes }] });
      expect(await verifyRecoveryBundle(f.destination)).toEqual(result);
    } finally { f.cleanup(); }
  });

  it('verifies legacy registered content while explicitly reporting omitted catalogued backups', async () => {
    const f = fixture();
    try {
      const backup = addBackup(f);
      await createRecoveryBundle(f.destination, f.adapter);
      const { backupObjects: _backupObjects, ...saved } = f.manifest();
      const legacy = { ...saved, format: 'myco-recovery/1' };
      fs.writeFileSync(path.join(f.destination, 'recovery.json'), JSON.stringify(legacy));
      fs.rmSync(path.join(f.destination, 'blobs', backup.key));
      f.bodies.clear();
      const reports: string[] = [];
      expect(await createRecoveryBundle(f.destination, f.adapter, (line) => reports.push(line))).toEqual(legacy);
      expect(reports.join('\n')).toContain('1 catalogued backup object is outside this legacy artifact');
      expect(f.manifest()).toEqual(legacy);
    } finally { f.cleanup(); }
  });

  it('refuses a redirected content directory without writing outside the artifact', async () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    try {
      await expect(createRecoveryBundle(f.destination, { ...f.adapter, blob: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
      const external = path.join(f.root, 'external');
      fs.mkdirSync(external);
      const project = path.join(f.destination, 'blobs', 'proj_1');
      fs.rmSync(project, { recursive: true });
      fs.symlinkSync(external, project);
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('must not be a symlink');
      expect(fs.readdirSync(external)).toEqual([]);
    } finally { f.cleanup(); }
  });
  it('resumes the saved snapshot after an interrupted blob copy and reuses only verified bytes', async () => {
    const f = fixture();
    try {
      let calls = 0;
      await expect(createRecoveryBundle(f.destination, { ...f.adapter, blob: async (blob, workDir) => {
        if (++calls === 2) throw new Error('storage unavailable');
        return f.adapter.blob(blob, workDir);
      } })).rejects.toThrow('storage unavailable');
      expect(f.manifest().status).toBe('content');
      expect(f.snapshots()).toBe(1);
      f.source.sqlite.run('DELETE FROM blobs');
      const result = await createRecoveryBundle(f.destination, f.adapter);
      expect(result.status).toBe('complete');
      expect(result.snapshot?.blobCount).toBe(2);
      expect(f.snapshots()).toBe(1);
      expect(f.reads).toHaveLength(2);
      for (const [key, body] of f.bodies) expect(fs.readFileSync(path.join(f.destination, 'blobs', key), 'utf8')).toBe(body);
      const again = await createRecoveryBundle(f.destination, f.adapter);
      expect(again).toEqual(result);
      expect(f.reads).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  it('keeps a corrupt download incomplete and completes after its source is repaired', async () => {
    const f = fixture();
    try {
      await expect(createRecoveryBundle(f.destination, { ...f.adapter, blob: async () => new Response('wrong bytes').body! }))
        .rejects.toThrow('sha256');
      expect(f.manifest().status).toBe('content');
      expect((await createRecoveryBundle(f.destination, f.adapter)).status).toBe('complete');
      expect(f.snapshots()).toBe(1);
    } finally { f.cleanup(); }
  });

  it('refuses a snapshot whose tool payload references missing blob metadata', async () => {
    const f = fixture();
    try {
      f.source.sqlite.run(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input_blob_key,success,created_at,token_id,received_at)
        VALUES ('proj_1','tc_probe','s_probe','ev_probe','Read',?,1,1,'mt_fixture',1)`, ['a'.repeat(64)]);
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('tool_calls.input_blob_key');
      expect(f.manifest().status).toBe('snapshot');
      expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
      expect(f.reads).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('preserves unrelated files and refuses to resume a different Deployment into an owned artifact', async () => {
    const f = fixture();
    try {
      fs.mkdirSync(f.destination);
      const userFile = path.join(f.destination, 'keep.txt');
      fs.writeFileSync(userFile, 'user content');
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('unrelated files');
      expect(fs.readFileSync(userFile, 'utf8')).toBe('user content');
      expect(f.snapshots()).toBe(0);
      fs.rmSync(userFile);
      const completed = await createRecoveryBundle(f.destination, f.adapter);
      await expect(createRecoveryBundle(f.destination, { ...f.adapter, source: { target: 'local', locator: 'other' } }))
        .rejects.toThrow('another Deployment');
      expect(f.manifest()).toEqual(completed);
    } finally { f.cleanup(); }
  });

  it('refuses corrupted completed content without fetching or overwriting it', async () => {
    const f = fixture();
    try {
      await createRecoveryBundle(f.destination, f.adapter);
      const key = [...f.bodies.keys()][0]!;
      const file = path.join(f.destination, 'blobs', key);
      fs.writeFileSync(file, 'changed content');
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('completed recovery blob no longer matches');
      expect(fs.readFileSync(file, 'utf8')).toBe('changed content');
      expect(f.reads).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  it('admits only one writer for a destination', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = createRecoveryBundle(f.destination, { ...f.adapter, snapshot: async (file, workDir) => {
      entered(); await hold; return f.adapter.snapshot(file, workDir);
    } });
    try {
      await ready;
      await expect(createRecoveryBundle(f.destination, f.adapter)).rejects.toThrow('another backup owns');
      release();
      expect((await first).status).toBe('complete');
    } finally { release(); await first; f.cleanup(); }
  });
});
