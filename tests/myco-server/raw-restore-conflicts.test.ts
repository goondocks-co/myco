import { describe, expect, it } from 'bun:test';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { rawBackfill } from '@myco-server-worker/core/raw-backfill.js';
import { bootstrapOwnership, claimUnknownRaw, rawClaimPreview } from '@myco-server-worker/core/raw-claims.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { registerBlob, seedCredential } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';

type Fixture = ReturnType<typeof sqliteEnv>;
const TRANSCRIPT_ID = 'same-transcript';
const SESSION_ID = 'restored-session';
const TOKEN_ID = 'restore-capture-token';
const MACHINE_ID = 'restore-machine';
const BODY = new Uint8Array([0, 255, 7, 10, 128]);
const HELD_BODY = new Uint8Array([1, 0, 2, 3, 4]);
const SOURCE_BLOB = 'a'.repeat(64);
const HELD_BLOB = 'b'.repeat(64);

function reader(e: Fixture, memberId: string) {
  return new RawResourceReader(e.serverEnv, { projectId: 'proj_1' }, { kind: 'member', memberId });
}

function blob(e: Fixture, key: string, bytes = BODY) {
  const object = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId: TOKEN_ID });
  e.bucket.seed(object, { size: bytes.length, bytes });
}

function transcript(e: Fixture, options: { machine?: string; token?: string; path?: string; segments?: number; blob?: string } = {}) {
  const segments = options.segments ?? 0;
  for (let index = 0; index < segments; index++) {
    e.sqlite.run(`INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
      VALUES ('proj_1',?,?,?,?,?,1,1,?)`, [TRANSCRIPT_ID, index * BODY.length, BODY.length, options.blob ?? SOURCE_BLOB, `segment-${index}`, options.token ?? TOKEN_ID]);
  }
  e.sqlite.run(`INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,origin_path,size,segment_count,first_received_at,last_received_at,token_id)
    VALUES ('proj_1',?,?,?,?,?,?,1,1,?)`, [TRANSCRIPT_ID, SESSION_ID, options.machine ?? MACHINE_ID,
    options.path ?? '/sessions/source.jsonl', segments * BODY.length, segments, options.token ?? TOKEN_ID]);
}

async function artifact(e: Fixture): Promise<string> {
  const backup = await createBackup(e.db, e.bucket, { producer: 'raw restore gate', now: 10 });
  return (await backupArtifact(e.db, e.bucket, backup.id))!.text;
}

async function finish(e: Fixture): Promise<void> {
  for (let pass = 0; pass < 30; pass++) if (!(await rawBackfill(e.db, pass)).more) return;
  throw new Error('Raw provenance backfill did not finish');
}

describe('raw transcript ownership during additive restore', () => {
  it('preserves the destination owner when another owner used the same logical transcript ID', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_2', 1)", [MACHINE_ID]);
      destination.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_1', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_2', machineId: MACHINE_ID });
      seedCredential(destination.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_1', machineId: MACHINE_ID });
      transcript(source); transcript(destination);
      const held = destination.sqlite.query('SELECT * FROM transcripts').all();
      const heldProof = destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all();
      const outcome = await restoreArtifact(destination.db, { text: await artifact(source), allowForeignLineage: true });
      expect(outcome.tables.raw_resources?.inserted).toBe(0);
      expect(destination.sqlite.query('SELECT * FROM transcripts').all()).toEqual(held);
      expect(destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all()).toEqual(heldProof);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
      expect(await reader(destination, 'mem_machine_1').transcripts(SESSION_ID)).toMatchObject([{ originPath: '/sessions/source.jsonl' }]);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('does not grant imported ownership when identical transcript metadata holds different segment bytes', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_2', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_2', machineId: MACHINE_ID });
      blob(source, SOURCE_BLOB);
      blob(destination, SOURCE_BLOB); blob(destination, HELD_BLOB, HELD_BODY);
      transcript(source, { segments: 1 });
      transcript(destination, { segments: 1, blob: HELD_BLOB });
      const heldSegments = destination.sqlite.query('SELECT * FROM transcript_segments').all();
      const heldProof = destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all();
      expect(await reader(source, 'mem_machine_2').allows({ kind: 'transcript', id: TRANSCRIPT_ID }, 'read')).toBe(true);
      await restoreArtifact(destination.db, { text: await artifact(source), allowForeignLineage: true });
      expect(destination.sqlite.query('SELECT * FROM transcript_segments').all()).toEqual(heldSegments);
      expect(destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all()).toEqual(heldProof);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
      await finish(destination);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('preserves a partial machine member hint when the same bytes were recorded for another member elsewhere', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_2', 1)", [MACHINE_ID]);
      destination.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_1', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_2', machineId: MACHINE_ID });
      blob(source, SOURCE_BLOB); blob(destination, SOURCE_BLOB);
      transcript(source, { segments: 1 }); transcript(destination, { segments: 1 });
      const heldProof = destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all();
      expect(heldProof).toMatchObject([{ owner_member_id: null, claim_member_id: 'mem_machine_1', provenance: 'missing' }]);
      await restoreArtifact(destination.db, { text: await artifact(source), allowForeignLineage: true });
      expect(destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all()).toEqual(heldProof);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('keeps a held raw path private when the artifact names different transcript metadata', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_2', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_2', machineId: MACHINE_ID });
      transcript(source, { path: '/source/private.jsonl' });
      transcript(destination, { path: '/destination/private.jsonl' });
      const held = destination.sqlite.query('SELECT * FROM transcripts').all();
      const heldProof = destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all();
      await restoreArtifact(destination.db, { text: await artifact(source), allowForeignLineage: true });
      expect(destination.sqlite.query('SELECT * FROM transcripts').all()).toEqual(held);
      expect(destination.sqlite.query("SELECT * FROM raw_resources WHERE kind = 'transcript'").all()).toEqual(heldProof);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('refuses a competing attribution committed between the comparison and snapshot transaction', async () => {
    const source = sqliteEnv();
    let armed = false;
    let raced = false;
    const destination = sqliteEnv({ onSql: (sql, sqlite) => {
      if (!armed || raced || !sql.includes('transcript ownership conflicts with held raw data')) return;
      raced = true;
      sqlite.run(`INSERT INTO raw_resources (project_id,kind,resource_id,reference_id,owner_member_id,provenance,revision)
        VALUES ('proj_1','transcript',?,'competing-restore','mem_machine_2','recorded',1)`, [TRANSCRIPT_ID]);
    } });
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_1', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_1', machineId: MACHINE_ID });
      transcript(source); transcript(destination);
      const text = await artifact(source);
      armed = true;
      await expect(restoreArtifact(destination.db, { text, allowForeignLineage: true })).rejects.toThrow('raw_resources');
      expect(raced).toBe(true);
      expect(await reader(destination, 'mem_machine_1').allows({ kind: 'transcript', id: TRANSCRIPT_ID }, 'read')).toBe(false);
      expect(destination.sqlite.query("SELECT owner_member_id FROM raw_resources WHERE kind = 'transcript' AND provenance = 'recorded'").all())
        .toEqual([{ owner_member_id: 'mem_machine_2' }]);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('refuses a segment replacement after bounded comparisons even when metadata and owners stay unchanged', async () => {
    const source = sqliteEnv();
    let armed = false;
    let raced = false;
    const destination = sqliteEnv({ onSql: (sql, sqlite) => {
      if (!armed || raced || !sql.includes('transcript ownership conflicts with held raw data')) return;
      raced = true;
      sqlite.run(`UPDATE transcript_segments SET blob_key = ? WHERE project_id = 'proj_1' AND transcript_id = ? AND base_offset = 0`, [HELD_BLOB, TRANSCRIPT_ID]);
    } });
    try {
      source.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?, 'mem_machine_1', 1)", [MACHINE_ID]);
      seedCredential(source.sqlite, { id: TOKEN_ID, memberId: 'mem_machine_1', machineId: MACHINE_ID });
      blob(source, SOURCE_BLOB);
      blob(destination, SOURCE_BLOB); blob(destination, HELD_BLOB, HELD_BODY);
      transcript(source, { segments: 1 }); transcript(destination, { segments: 1 });
      const text = await artifact(source);
      armed = true;
      await expect(restoreArtifact(destination.db, { text, allowForeignLineage: true })).rejects.toThrow('raw_resources');
      expect(raced).toBe(true);
      expect(destination.sqlite.query('SELECT blob_key FROM transcript_segments').all()).toEqual([{ blob_key: HELD_BLOB }]);
      expect(await reader(destination, 'mem_machine_1').allows({ kind: 'transcript', id: TRANSCRIPT_ID }, 'read')).toBe(false);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('preserves a claimed transcript and its complete bytes across multiple segment pages and an idempotent retry', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("UPDATE members SET github_id = 'restore-owner' WHERE id = 'mem_machine_1'");
      await bootstrapOwnership(source.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      blob(source, SOURCE_BLOB); blob(destination, SOURCE_BLOB);
      transcript(source, { segments: 21 });
      await finish(source);
      await claimUnknownRaw(source.db, 'mem_machine_1', (await rawClaimPreview(source.db, 'mem_machine_1')).revision, 2);
      const text = await artifact(source);
      await restoreArtifact(destination.db, { text, allowForeignLineage: true });
      const restored = await reader(destination, 'mem_machine_1').transcripts(SESSION_ID);
      expect(restored).toHaveLength(1);
      expect(restored[0]!.segments).toHaveLength(21);
      const stored = await reader(destination, 'mem_machine_1').blob(SOURCE_BLOB);
      expect(stored).not.toBeNull();
      expect(new Uint8Array(await new Response(stored!.body).arrayBuffer())).toEqual(BODY);
      expect(await reader(destination, 'mem_machine_2').transcripts(SESSION_ID)).toEqual([]);
      const retry = await restoreArtifact(destination.db, { text, allowForeignLineage: true });
      expect(retry.tables.raw_resources?.inserted).toBe(0);
      expect(await reader(destination, 'mem_machine_1').transcripts(SESSION_ID)).toEqual(restored);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });
});
