import { describe, expect, it } from 'bun:test';
import { CHAINED_WAKE_MS, engineAssertions, runTick } from '@myco-server-worker/core/tick.js';
import worker from '@myco-server-worker/index.js';
import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET, rawBackfill } from '@myco-server-worker/core/raw-backfill.js';
import { bootstrapOwnership, claimUnknownRaw, rawClaimPreview, ownershipPreview } from '@myco-server-worker/core/raw-claims.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { registerBlob } from './helpers/d1.js';
import { backupArtifact, createBackup, restoreArtifact, BACKUP_FORMAT, deploymentId } from '@myco-server-worker/core/backup.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

function missing(e: ReturnType<typeof sqliteEnv>, id: string, at: number, token = 'lost-token') {
  e.sqlite.run("INSERT OR IGNORE INTO sessions (project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES ('proj_1','history','lost-token',0,0)");
  e.sqlite.run(`INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation) VALUES ('proj_1',?,1,'text/plain',?,?,'00000000-0000-4000-8000-000000000001')`, [id, token, at]);
  e.sqlite.run(`INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    VALUES ('proj_1',?,'history',?,'notification','cli','raw bytes','digest',?,?)`, [id, token, at, at]);
  e.sqlite.run(`INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id)
    VALUES ('proj_1',?,'history','lost-machine',0,?,?,?)`, [id, at, at, token]);
}
async function complete(e: ReturnType<typeof sqliteEnv>) {
  for (let n = 0; n < 50; n++) if (!(await rawBackfill(e.db, Date.now())).more) return;
  throw new Error('backfill not complete');
}
const reader = (e: ReturnType<typeof sqliteEnv>, memberId: string) => new RawResourceReader(e.serverEnv, { projectId: 'proj_1' }, { kind: 'member', memberId });

describe('explicit owner claim of missing raw uploader', () => {
  it('excludes a missing reference when another member already owns the same hash at review', async () => {
    const e = sqliteEnv();
    try {
      const text = 'bytes already owned by another member';
      const bytes = new TextEncoder().encode(text);
      const key = await sha256Hex(text);
      const object = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId: 'missing-upload' });
      e.bucket.seed(object, { size: bytes.length, bytes });
      const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
      const upload = await worker.fetch(new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(other.token,
        { 'content-type': 'text/plain', 'content-length': String(bytes.length) }), body: bytes }), e.env);
      expect(await upload.json()).toMatchObject({ stored: true, duplicate: true });
      missing(e, 'claimable-other-identity', 1);
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      await complete(e);
      const preview = await rawClaimPreview(e.db, 'mem_machine_1');
      expect(preview.projects[0]!.kinds.find((kind) => kind.kind === 'blob')!.count).toBe(1);
      await claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 2);
      expect(await reader(e, 'mem_machine_1').allows({ kind: 'blob', id: key }, 'read')).toBe(false);
      const held = await reader(e, 'mem_machine_2').blob(key);
      expect(held).not.toBeNull(); expect(await new Response(held!.body).text()).toBe(text);
      expect((await rawClaimPreview(e.db, 'mem_machine_1')).projects).toEqual([]);
    } finally { e.sqlite.close(); }
  });

  it('preserves an explicit claim when a second member later uploads the same complete bytes', async () => {
    const e = sqliteEnv();
    try {
      const text = 'historical bytes with two legitimate owners';
      const bytes = new TextEncoder().encode(text);
      const key = await sha256Hex(text);
      const object = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId: 'missing-upload' });
      e.bucket.seed(object, { size: bytes.length, bytes });
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      await complete(e);
      await claimUnknownRaw(e.db, 'mem_machine_1', (await rawClaimPreview(e.db, 'mem_machine_1')).revision, 2);
      expect(await reader(e, 'mem_machine_1').allows({ kind: 'blob', id: key }, 'read')).toBe(true);
      const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
      const upload = await worker.fetch(new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(other.token,
        { 'content-type': 'text/plain', 'content-length': String(bytes.length) }), body: bytes }), e.env);
      expect(await upload.json()).toMatchObject({ stored: true, duplicate: true });
      for (const actor of ['mem_machine_1','mem_machine_2']) {
        const held = await reader(e, actor).blob(key);
        expect(held).not.toBeNull(); expect(await new Response(held!.body).text()).toBe(text);
      }
      expect((await rawClaimPreview(e.db, 'mem_machine_1')).projects).toEqual([]);
    } finally { e.sqlite.close(); }
  });

  it('continues pending provenance work on a quiet Deployment without a dashboard activity stamp', async () => {
    const e = sqliteEnv();
    try {
      const rows = RAW_BACKFILL_BATCH * Math.floor(RAW_BACKFILL_BUDGET.calls / 6) + 1;
      e.sqlite.exec(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${rows})
        INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation)
        SELECT 'proj_1', printf('%064x', i), 1, 'text/plain', 'lost-token', 0, '00000000-0000-4000-8000-000000000001' FROM seq`);
      e.sqlite.run('UPDATE raw_provenance_backfill SET complete = 0 WHERE id = 1');
      const now = Date.now();
      expect(await engineAssertions(e.serverEnv, now)).toContainEqual({ name: 'raw-provenance:pending', maxDepth: 'sleep' });
      const woke = await runTick(e.serverEnv, now);
      expect(woke.state).toBe('sleep');
      expect(woke.jobs.find((job) => job.name === 'raw-provenance-backfill')).toMatchObject({ failed: null, more: true });
      expect(woke.nextWakeMs).toBe(CHAINED_WAKE_MS);
      await complete(e);
      expect(await engineAssertions(e.serverEnv, now)).not.toContainEqual({ name: 'raw-provenance:pending', maxDepth: 'sleep' });
    } finally { e.sqlite.close(); }
  });

  it('previews exact counts/date ranges, changes only missing identities, keeps later raw unclaimed and receipts immutable through backup', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE members SET github_id = 'owner-account' WHERE id = 'mem_machine_1'");
      expect(await ownershipPreview(e.db)).toMatchObject({ ownerMemberId: null, revision: '0' });
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 100);
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM deployment_ownership_audit').get()).toEqual({ n: 1 });
      missing(e, 'missing-old', 10); missing(e, 'missing-new', 20);
      e.sqlite.run(`INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation) VALUES ('proj_2','project-two',1,'text/plain','lost-token',15,'00000000-0000-4000-8000-000000000002')`);
      const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, 100);
      missing(e, 'other-member', 30, other.tokenId);
      e.sqlite.run("UPDATE transcripts SET machine_id = 'machine_2' WHERE transcript_id = 'other-member'");
      // Contradictory recorded credentials are unavailable and excluded from a claim.
      e.sqlite.run("INSERT INTO member_credentials (id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES ('ambiguous','mem_machine_2','machine_1','ambiguous',0,99999,'ambiguous',0)");
      missing(e, 'ambiguous', 40, 'ambiguous');
      await complete(e);
      const preview = await rawClaimPreview(e.db, 'mem_machine_1');
      expect(preview.complete).toBe(true);
      expect(preview.projects).toEqual([{ projectId: 'proj_1', name: 'a', kinds: [
        { kind: 'blob', count: 2, oldestAt: 10, newestAt: 20 },
        { kind: 'event', count: 2, oldestAt: 10, newestAt: 20 },
        { kind: 'transcript', count: 2, oldestAt: 10, newestAt: 20 },
      ] }, { projectId: 'proj_2', name: 'b', kinds: [{ kind: 'blob', count: 1, oldestAt: 15, newestAt: 15 }] }]);
      for (const kind of ['blob','event','transcript'] as const) {
        expect(await reader(e, 'mem_machine_1').allows({ kind, id: 'missing-old' }, 'read')).toBe(false);
      }
      const result = await claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 50);
      expect(result.claimId).not.toBeNull(); expect(result.preview.projects).toEqual([]);
      for (const kind of ['blob','event','transcript'] as const) {
        expect(await reader(e, 'mem_machine_1').allows({ kind, id: 'missing-old' }, 'read')).toBe(true);
        expect(await reader(e, 'mem_machine_2').allows({ kind, id: 'missing-old' }, 'read')).toBe(false);
        expect(await reader(e, 'mem_machine_1').allows({ kind, id: 'other-member' }, 'read')).toBe(false);
        expect(await reader(e, 'mem_machine_1').allows({ kind, id: 'ambiguous' }, 'read')).toBe(false);
      }
      expect(await reader(e, 'mem_machine_2').allows({ kind: 'blob', id: 'other-member' }, 'read')).toBe(true);
      expect(await reader(e, 'mem_machine_1').event('missing-old')).toBe('raw bytes');
      expect((await claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 51)).claimId).toBeNull();
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM raw_claims').get()).toEqual({ n: 1 });
      missing(e, 'later', 60);
      for (const kind of ['blob','event','transcript'] as const) expect(await reader(e, 'mem_machine_1').allows({ kind, id: 'later' }, 'read')).toBe(false);
      await expect(claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 61)).rejects.toThrow('revision_conflict');
      expect(() => e.sqlite.run('UPDATE raw_claims SET cutoff_revision = 999999')).toThrow('immutable');
      expect(() => e.sqlite.run("UPDATE deployment_ownership_audit SET member_id = 'mem_machine_2'")).toThrow('immutable');
      const backup = await createBackup(e.db, e.bucket, { producer: 'claim gate', now: 70 });
      const artifact = await backupArtifact(e.db, e.bucket, backup.id);
      expect(artifact!.text).toContain('"t":"raw_claims"');
      expect(artifact!.text).toContain('"t":"deployment_ownership"');
    } finally { e.sqlite.close(); }
  });

  it('claims partial transcript evidence only for its recorded machine member', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("INSERT OR IGNORE INTO machine_claims (machine_id,member_id,claimed_at) VALUES ('machine_1','mem_machine_1',0),('machine_2','mem_machine_2',0)");
      const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
      const partial = (id: string, machine: string, token: string) => {
        e.sqlite.run(`INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
          VALUES ('proj_1',?,0,1,'partial-blob',?,1,1,?)`, [id, id, token]);
        e.sqlite.run(`INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
          VALUES ('proj_1',?,'partial-session',?,1,1,1,1,'missing-header')`, [id, machine]);
      };
      partial('own-partial', 'machine_1', 'missing-segment');
      partial('foreign-partial', 'machine_2', 'missing-segment');
      partial('conflicting-partial', 'machine_1', other.tokenId);
      e.sqlite.run(`INSERT INTO blobs (project_id,key,size,media_type,token_id,received_at,generation) VALUES ('proj_1','partial-blob',1,'text/plain','missing-segment',1,'00000000-0000-4000-8000-000000000003')`);
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      await complete(e);
      expect(e.sqlite.query("SELECT resource_id,provenance,claim_member_id FROM raw_resources WHERE kind = 'transcript' ORDER BY resource_id").all()).toEqual([
        { resource_id: 'conflicting-partial', provenance: 'ambiguous', claim_member_id: null },
        { resource_id: 'foreign-partial', provenance: 'missing', claim_member_id: 'mem_machine_2' },
        { resource_id: 'own-partial', provenance: 'missing', claim_member_id: 'mem_machine_1' },
      ]);
      expect(await reader(e, 'mem_machine_1').transcripts('partial-session')).toEqual([]);
      const preview = await rawClaimPreview(e.db, 'mem_machine_1');
      expect(preview.projects[0]!.kinds).toEqual([{ kind: 'blob', count: 1, oldestAt: 1, newestAt: 1 }, { kind: 'transcript', count: 1, oldestAt: 1, newestAt: 1 }]);
      await claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 2);
      expect((await reader(e, 'mem_machine_1').transcripts('partial-session')).map((row) => row.transcriptId)).toEqual(['own-partial']);
      for (const actor of ['mem_machine_1','mem_machine_2']) expect(await reader(e, actor).allows({ kind: 'transcript', id: 'foreign-partial' }, 'read')).toBe(false);
      expect(() => e.sqlite.run("UPDATE raw_resources SET claim_member_id = 'mem_machine_1' WHERE resource_id = 'foreign-partial'")).toThrow('immutable');
    } finally { e.sqlite.close(); }
  });

  it('commits owner selection and its immutable audit receipt atomically', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run(`CREATE TRIGGER audit_gate BEFORE INSERT ON deployment_ownership_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
      await expect(bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1)).rejects.toThrow('audit unavailable');
      expect(await ownershipPreview(e.db)).toMatchObject({ ownerMemberId: null, revision: '0' });
      e.sqlite.run('DROP TRIGGER audit_gate');
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 2);
      expect(e.sqlite.query('SELECT member_id,actor_id,created_at FROM deployment_ownership_audit').all())
        .toEqual([{ member_id: 'mem_machine_1', actor_id: 'mem_machine_1', created_at: 2 }]);
    } finally { e.sqlite.close(); }
  });

  it('refuses incomplete, nonowner, revoked and stale actions; bootstrap cannot replace the recorded owner', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE members SET github_id = 'owner-account' WHERE id = 'mem_machine_1'");
      await expect(rawClaimPreview(e.db, 'mem_machine_1')).rejects.toThrow('not_owner');
      e.sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_2'");
      await expect(bootstrapOwnership(e.db, 'mem_machine_2', 'mem_machine_2', '0', 1)).rejects.toThrow('not_admin');
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      missing(e, 'held', 1);
      e.sqlite.run('UPDATE raw_provenance_backfill SET complete = 0 WHERE id = 1');
      const pending = await rawClaimPreview(e.db, 'mem_machine_1');
      await expect(claimUnknownRaw(e.db, 'mem_machine_1', pending.revision, 2)).rejects.toThrow('backfill_pending');
      e.sqlite.run("UPDATE members SET role = 'admin', github_id = 'second-admin' WHERE id = 'mem_machine_3'");
      await complete(e);
      for (const actor of ['mem_machine_2','mem_machine_3']) {
        await expect(rawClaimPreview(e.db, actor)).rejects.toThrow('not_owner');
        await expect(claimUnknownRaw(e.db, actor, '0', 3)).rejects.toThrow('not_owner');
      }
      await expect(bootstrapOwnership(e.db, 'mem_machine_3', 'mem_machine_3', '1', 3)).rejects.toThrow('owner_already_recorded');
      expect((await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 4)).revision).toBe('1');
      const preview = await rawClaimPreview(e.db, 'mem_machine_1');
      missing(e, 'unreviewed', 5);
      await expect(claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 6)).rejects.toThrow('revision_conflict');
      e.sqlite.run("UPDATE members SET revoked_at = 7 WHERE id = 'mem_machine_1'");
      await expect(claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 8)).rejects.toThrow('not_owner');
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM raw_claims').get()).toEqual({ n: 0 });
    } finally { e.sqlite.close(); }
  });

  it('restores owner receipts and disjoint claim revision ranges without claiming destination or later raw', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      await bootstrapOwnership(source.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      source.sqlite.run('UPDATE raw_provenance_state SET revision = 10000 WHERE id = 1');
      const event = (e: ReturnType<typeof sqliteEnv>, id: string, token: string) => {
        e.sqlite.run("INSERT OR IGNORE INTO sessions (project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES ('proj_1','history','source-missing',0,0)");
        e.sqlite.run(`INSERT INTO events
        (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
        VALUES ('proj_1',?,'history',?,'notification','cli','full raw bytes','digest',1,1)`, [id, token]);
      };
      event(source, 'source-claimed', 'source-missing');
      const preview = await rawClaimPreview(source.db, 'mem_machine_1');
      await claimUnknownRaw(source.db, 'mem_machine_1', preview.revision, 2);
      const backup = await createBackup(source.db, source.bucket, { producer: 'restore claim gate', now: 3 });
      const artifact = (await backupArtifact(source.db, source.bucket, backup.id))!;
      event(destination, 'destination-unreviewed', 'destination-missing');
      await restoreArtifact(destination.db, { text: artifact.text, allowForeignLineage: true });
      expect(await ownershipPreview(destination.db)).toMatchObject({ ownerMemberId: 'mem_machine_1', revision: '1' });
      expect(destination.sqlite.query('SELECT member_id,actor_id FROM deployment_ownership_audit').all())
        .toEqual([{ member_id: 'mem_machine_1', actor_id: 'mem_machine_1' }]);
      expect(await reader(destination, 'mem_machine_1').event('source-claimed')).toBe('full raw bytes');
      expect(await reader(destination, 'mem_machine_1').event('destination-unreviewed')).toBeNull();
      event(destination, 'new-after-recovery', 'source-missing');
      expect(await reader(destination, 'mem_machine_1').event('new-after-recovery')).toBeNull();
      await complete(destination);
      expect(await reader(destination, 'mem_machine_1').event('destination-unreviewed')).toBeNull();
      await restoreArtifact(destination.db, { text: artifact.text, allowForeignLineage: true });
      expect(await reader(destination, 'mem_machine_1').event('new-after-recovery')).toBeNull();
      expect(destination.sqlite.query('SELECT COUNT(*) AS n FROM raw_restore_revisions').get()).toEqual({ n: 1 });
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('reconciles legacy retained transcripts above an existing claim cutoff and counts restored logical identities once', async () => {
    const e = sqliteEnv();
    try {
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      missing(e, 'old-claimed', 1);
      await complete(e);
      await claimUnknownRaw(e.db, 'mem_machine_1', (await rawClaimPreview(e.db, 'mem_machine_1')).revision, 2);
      const transcript = { project_id: 'proj_1', transcript_id: 'legacy-retained', session_id: 'history', machine_id: 'missing-old-machine',
        size: 10, segment_count: 2, first_received_at: 3, last_received_at: 3, token_id: 'missing-old-token' };
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(e.db), schemaVersion: 70, createdAt: 3, producer: 'legacy', counts: { transcripts: 1 } };
      await restoreArtifact(e.db, { text: [header, { t: 'transcripts', r: transcript }].map((r) => JSON.stringify(r)).join('\n') });
      expect(e.sqlite.query('SELECT complete FROM raw_provenance_backfill').get()).toEqual({ complete: 0 });
      await complete(e);
      expect(await reader(e, 'mem_machine_1').allows({ kind: 'transcript', id: 'legacy-retained' }, 'read')).toBe(false);
      const raw = e.sqlite.query<{ project_id: string; kind: string; resource_id: string; machine_id: string | null; token_id: string | null; provenance: string; revision: number }, []>("SELECT * FROM raw_resources WHERE resource_id = 'legacy-retained'").get()!;
      e.sqlite.run(`INSERT INTO raw_resources (project_id,kind,resource_id,reference_id,owner_member_id,machine_id,token_id,provenance,revision)
        VALUES (?,?,?,?,?,?,?,?,?)`, [raw.project_id, raw.kind, raw.resource_id, 'restore-proof', null, raw.machine_id, raw.token_id, raw.provenance, raw.revision]);
      const preview = await rawClaimPreview(e.db, 'mem_machine_1');
      expect(preview.projects[0]!.kinds).toEqual([{ kind: 'transcript', count: 1, oldestAt: 3, newestAt: 3 }]);
      await claimUnknownRaw(e.db, 'mem_machine_1', preview.revision, 4);
      expect(await reader(e, 'mem_machine_1').allows({ kind: 'transcript', id: 'legacy-retained' }, 'read')).toBe(true);
    } finally { e.sqlite.close(); }
  });

  it('preserves another owner’s claimed logical transcript across additive restore snapshots', async () => {
    const source = sqliteEnv(); const destination = sqliteEnv();
    try {
      source.sqlite.run("UPDATE members SET github_id = 'other-human' WHERE id = 'mem_machine_2'");
      await bootstrapOwnership(source.db, 'mem_machine_2', 'mem_machine_2', '0', 1);
      await bootstrapOwnership(destination.db, 'mem_machine_1', 'mem_machine_1', '0', 1);
      source.sqlite.run("INSERT INTO sessions (project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES ('proj_1','history','missing-token',0,0)");
      source.sqlite.run(`INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id)
        VALUES ('proj_1','foreign-claimed','history','missing-machine',0,1,1,'missing-token')`);
      await complete(source);
      await claimUnknownRaw(source.db, 'mem_machine_2', (await rawClaimPreview(source.db, 'mem_machine_2')).revision, 2);
      const backup = await createBackup(source.db, source.bucket, { producer: 'foreign claim', now: 3 });
      await restoreArtifact(destination.db, { text: (await backupArtifact(source.db, source.bucket, backup.id))!.text, allowForeignLineage: true });
      await complete(destination);
      expect(await reader(destination, 'mem_machine_2').allows({ kind: 'transcript', id: 'foreign-claimed' }, 'read')).toBe(true);
      expect((await rawClaimPreview(destination.db, 'mem_machine_1')).projects).toEqual([]);
      expect((await claimUnknownRaw(destination.db, 'mem_machine_1', (await rawClaimPreview(destination.db, 'mem_machine_1')).revision, 4)).claimId).toBeNull();
      expect(await reader(destination, 'mem_machine_1').allows({ kind: 'transcript', id: 'foreign-claimed' }, 'read')).toBe(false);
    } finally { source.sqlite.close(); destination.sqlite.close(); }
  });

  it('rejects ownership restore without its matching immutable receipt before selecting an owner', async () => {
    const e = sqliteEnv();
    try {
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(e.db), schemaVersion: 71, createdAt: 1, producer: 'test', counts: { deployment_ownership: 1 } };
      const text = [header, { t: 'deployment_ownership', r: { id: 1, member_id: 'mem_machine_1', revision: 1 } }].map((r) => JSON.stringify(r)).join('\n');
      await expect(restoreArtifact(e.db, { text })).rejects.toThrow('matching audit receipt');
      expect(await ownershipPreview(e.db)).toMatchObject({ ownerMemberId: null, revision: '0' });
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM deployment_ownership_audit').get()).toEqual({ n: 0 });
    } finally { e.sqlite.close(); }
  });

  it('uses the same operation through dashboard and owner bearer API, without exposing a raw claim to an admin', async () => {
    const e = sqliteEnv();
    try {
      const cookie = await ownerCookie();
      const headers = { cookie, origin: 'https://s', 'cf-connecting-ip': '1.2.3.4' };
      const request = async (path: string, body?: unknown) => worker.fetch(new Request(`https://s${path}`, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...e.env, ...OWNER_ENV });
      const before = await request('/api/raw-claims'); expect(before.status).toBe(403);
      const bootstrap = await request('/api/ownership', { ownerMemberId: 'mem_machine_1', revision: '0' }); expect(bootstrap.status).toBe(200);
      expect(await (await request('/auth/me')).json()).toMatchObject({ owner: true });
      missing(e, 'http', 1); await complete(e);
      const token = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      const bearerHeaders = memberHeaders(token.token, { 'x-myco-project': '' });
      const preview = await worker.fetch(new Request('https://s/members/raw-claims', { headers: bearerHeaders }), e.env);
      expect(preview.status).toBe(200);
      const value = await preview.json() as { revision: string };
      const claimed = await worker.fetch(new Request('https://s/members/raw-claims', { method: 'POST', headers: bearerHeaders, body: JSON.stringify({ revision: value.revision }) }), e.env);
      expect(claimed.status).toBe(200);
      expect((await (await request('/api/raw-claims')).json()) as unknown).toMatchObject({ projects: [] });
    } finally { e.sqlite.close(); }
  });
});
