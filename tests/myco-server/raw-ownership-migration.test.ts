import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { restoreArtifact, deploymentId, BACKUP_FORMAT } from '@myco-server-worker/core/backup.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';

function historical() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const step of SCHEMA_STEPS.filter((step) => step.version < 70)) for (const sql of step.statements) sqlite.exec(sql);
  sqlite.run("INSERT INTO projects (project_id, name, created_at) VALUES ('p','p',0)");
  sqlite.run("INSERT INTO members (id, created_at) VALUES ('a',0),('b',0)");
  sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES ('ma','a',0),('mb','b',0)");
  for (const [id, member, machine] of [['ca','a','ma'], ['cb','b','mb'], ['conflict','b','ma']]) {
    sqlite.run('INSERT INTO member_credentials (id,member_id,machine_id,token_hash,issued_at,expires_at,revoked_at,lineage_root,lineage_started_at) VALUES (?,?,?,?,0,1,1,?,0)', [id!,member!,machine!,id!,id!]);
  }
  return sqlite;
}

describe('raw ownership schema step 70', () => {
  it('restores a legacy mixed transcript without prematurely granting raw ownership', async () => {
    const sqlite = historical();
    try {
      for (const sql of SCHEMA_STEPS.find((step) => step.version === 70)!.statements) sqlite.exec(sql);
      const db = sqliteRelationalStore(sqlite);
      sqlite.run("INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation) VALUES ('p','restored-blob',12,'text/plain','ca',0,'00000000-0000-4000-8000-000000000001')");
      const transcript = { project_id: 'p', transcript_id: 'restored', session_id: 'session', machine_id: 'ma', size: 24, segment_count: 2,
        first_received_at: 0, last_received_at: 0, token_id: 'ca' };
      const segments = ['ca', 'cb'].map((token_id, index) => ({ project_id: 'p', transcript_id: 'restored', base_offset: index * 12,
        length: 12, blob_key: 'restored-blob', event_id: `restored-${index}`, created_at: 0, received_at: 0, token_id }));
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(db), schemaVersion: 69, createdAt: 0, producer: 'test',
        counts: { transcripts: 1, transcript_segments: 2 } };
      // Artifact row order is independent of the restore capability's table order.
      const text = [header, { t: 'transcripts', r: transcript }, ...segments.map((r) => ({ t: 'transcript_segments', r }))].map((row) => JSON.stringify(row)).join('\n');
      await restoreArtifact(db, { text });
      expect(sqlite.query("SELECT owner_member_id FROM raw_resources WHERE kind = 'transcript' AND resource_id = 'restored'").get())
        .toEqual({ owner_member_id: null });
      expect(sqlite.query('SELECT COUNT(*) AS n FROM transcript_segments').get()).toEqual({ n: 2 });
      const reader = new RawResourceReader({ db, blobs: memoryBlobStore() }, { projectId: 'p' }, { kind: 'member', memberId: 'a' });
      expect(await reader.transcripts('session')).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('backfills only consistent historical evidence, preserves bytes and locks attribution against later identity changes', async () => {
    const sqlite = historical();
    try {
      for (const [id, token] of [['known','ca'], ['unknown','missing'], ['conflicting','conflict']]) {
        sqlite.run("INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation) VALUES ('p',?,12,'text/plain',?,0,'00000000-0000-4000-8000-000000000001')",[id!,token!]);
      }
      for (const [id, machine, token] of [['known','ma','ca'], ['unknown','absent','missing'], ['conflicting','ma','cb'], ['mixed','ma','ca']]) {
        sqlite.run("INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) VALUES ('p',?,'session',?,12,0,0,?)",[id!,machine!,token!]);
      }
      sqlite.run("INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id) VALUES ('p','mixed',0,12,'known','event',0,0,'cb')");
      const bytes = sqlite.query('SELECT * FROM blobs').all();
      const transcripts = sqlite.query('SELECT * FROM transcripts').all();
      for (const sql of SCHEMA_STEPS.find((step) => step.version === 70)!.statements) sqlite.exec(sql);
      expect(sqlite.query('SELECT * FROM blobs').all()).toEqual(bytes);
      expect(sqlite.query('SELECT * FROM transcripts').all()).toEqual(transcripts);
      expect(sqlite.query('SELECT kind,resource_id,owner_member_id FROM raw_resources ORDER BY kind,resource_id').all()).toEqual([
        { kind: 'blob', resource_id: 'conflicting', owner_member_id: null },
        { kind: 'blob', resource_id: 'known', owner_member_id: 'a' },
        { kind: 'blob', resource_id: 'unknown', owner_member_id: null },
        { kind: 'transcript', resource_id: 'conflicting', owner_member_id: null },
        { kind: 'transcript', resource_id: 'known', owner_member_id: 'a' },
        { kind: 'transcript', resource_id: 'mixed', owner_member_id: null },
        { kind: 'transcript', resource_id: 'unknown', owner_member_id: null },
      ]);
      expect(() => sqlite.run("UPDATE raw_resources SET owner_member_id = 'b' WHERE resource_id = 'known'")).toThrow('immutable');
      expect(() => sqlite.run("UPDATE raw_resources SET classification = 'processed'")).toThrow('immutable');
      sqlite.run("INSERT INTO processed_resources (project_id,kind,resource_id,blob_key,source_token_id,event_id) VALUES ('p','plan','shared','known','ca','event')");
      expect(() => sqlite.run("UPDATE processed_resources SET source_token_id = 'cb'")).toThrow('immutable');
      sqlite.run("UPDATE machine_claims SET member_id = 'b' WHERE machine_id = 'ma'");
      for (const sql of SCHEMA_STEPS.find((step) => step.version === 70)!.statements) sqlite.exec(sql);
      const db = sqliteRelationalStore(sqlite);
      const blobs = memoryBlobStore();
      blobs.get = async () => { throw new Error('policy check must not read bytes'); };
      const reader = (subject: ConstructorParameters<typeof RawResourceReader>[2]) => new RawResourceReader({ db, blobs }, { projectId: 'p' }, subject);
      expect(await reader({ kind: 'member', memberId: 'a' }).allows({ kind: 'blob', id: 'known' }, 'read')).toBe(true);
      expect(await reader({ kind: 'member', memberId: 'b' }).allows({ kind: 'blob', id: 'known' }, 'read')).toBe(false);
      for (const subject of [{ kind: 'run', id: 'run' }, { kind: 'grant', id: 'grant' }] as const) {
        expect(await reader(subject).allows({ kind: 'blob', id: 'known' }, 'read')).toBe(false);
      }
      sqlite.run("UPDATE members SET revoked_at = 2 WHERE id = 'a'");
      expect(await reader({ kind: 'member', memberId: 'a' }).allows({ kind: 'blob', id: 'known' }, 'read')).toBe(false);
    } finally { sqlite.close(); }
  });
});
