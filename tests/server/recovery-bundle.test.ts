import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecoveryBundle, type RecoveryAdapter } from '@myco/server/recovery-bundle.js';
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

describe('verified recovery artifacts', () => {
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
