/**
 * Session deletion as an accepted job: a deletion deletes only what it has been asked to, in bounded pages,
 * resumes after any interruption, stops for holds, and keeps what others still hold.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { acquireRecoveryHold, drainObjectReleases, releaseRecoveryHold } from '@myco-server-worker/core/object-release.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { advanceSessionDeletions, deletionProgress } from '@myco-server-worker/db/sessions/deletion.js';
import { DELETION_PHASES, assertBlobReferencesRouted } from '@myco-server-worker/db/sessions/deletion-phases.js';
import { backupSnapshot } from '@myco-server-worker/core/backup.js';
import { JOB_IMPLEMENTATIONS } from '@myco-server-worker/core/jobs-run.js';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { blobOnlyInDeletedSessions } from '@myco-server-worker/db/raw/resources.js';
import { credentialEvents } from '@myco-server-worker/db/credentials/activity.js';
import { machineActivity } from '@myco-server-worker/read/machines.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { search_searchProject as searchProject } from '@myco-server-worker/read/catalog/search.js';
import { plans_listProjectPlans as listProjectPlans } from '@myco-server-worker/read/catalog/plans.js';
import { plans_getPlan as getPlan } from '@myco-server-worker/read/catalog/plans.js';
import { sessions_getSession as getSession } from '@myco-server-worker/read/catalog/sessions.js';
import { projectStatistics } from '@myco-server-worker/db/sessions/statistics.js';
import { issueMemberToken } from './helpers/member-token.js';
import { memberAdmitted, membersAdmittedAmong } from '@myco-server-worker/db/raw/resources.js';
import worker from '@myco-server-worker/index.js';
import { registerBlob } from './helpers/d1.js';
import { OWNER_ENV, asOwner, asOwnerPost } from './helpers/owner.js';
import { count, envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { drainSessionDeletions } from './helpers/session-deletion.js';

const NOW = BLOB_RESERVATION_TTL_MS + 1_000_000;
const AGED = NOW - BLOB_RESERVATION_TTL_MS - 1;
const SCOPE = { projectId: 'proj_1' };
const S = 's1';

async function rig() {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.serverEnv.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const ctx = { projectId: SCOPE.projectId, machineId: 'machine_1', tokenId: issued.tokenId, bodyBytes: 10, now: NOW };
  const send = (over: Record<string, unknown>) => ingestEvent(e.serverEnv.db, ctx, envelope({ sessionId: S, ...over }));
  await send({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: NOW - 5 } });
  await send({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hello', origin: 'user' } });
  await send({ eventId: uuid(5), kind: 'plan', payload: { planKey: uuid(50), content: '# p', status: 'active', tags: ['plan'] } });
  return { ...e, send, ctx };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const attach = (e: Rig, n: number, key: string, session = S, at = AGED) => {
  registerBlob(e.sqlite, { projectId: 'proj_1', key, size: 1, receivedAt: at });
  e.sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
    VALUES ('proj_1', ?, ?, 'e', ?, 'image/png', 1, ?, 't', ?)`, [`att-${n}`, session, key, NOW, NOW]);
};
const key = (n: number) => n.toString(16).padStart(64, 'c');
const accept = (e: Rig, now = NOW) => tombstoneSession(e.serverEnv, SCOPE, S, 'mem_machine_1', now, 'asked');
const job = (e: Rig) => e.sqlite.query('SELECT state,phase,removed FROM session_deletion_jobs').get() as { state: string; phase: string; removed: number };
const stateOf = (e: Rig) => deletionProgress(e.serverEnv.db, 'proj_1', S, NOW);

describe('accepting a deletion', () => {
  it('commits the tombstone and a job at once, and hides the session from reads while the job has not run', async () => {
    const e = await rig();
    await e.send({ eventId: uuid(3), kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'hi' } });
    const accepted = await accept(e);
    expect(accepted?.state).toBe('running');
    expect(count(e.sqlite, 'session_tombstones')).toBe(1);
    expect(count(e.sqlite, 'session_deletion_jobs')).toBe(1);
    expect(count(e.sqlite, 'plans')).toBe(0);
    expect(count(e.sqlite, 'events')).toBeGreaterThan(0);
    expect(await getSession(e.db, SCOPE, S)).toBeNull();
    expect(await listProjectPlans(e.db, SCOPE)).toEqual([]);
    expect(await projectStatistics(e.db, 'proj_1', NOW)).toMatchObject({ state: 'ready', prompts: 0 });
  });

  it('refuses every new event for the session as a tombstoned session does, even while the job is still working', async () => {
    const e = await rig();
    await accept(e);
    const late = await e.send({ eventId: uuid(60), kind: 'prompt', payload: { promptId: uuid(61), text: 'late', origin: 'user' } });
    expect(late.persisted).toBe(false);
    expect(count(e.sqlite, 'events')).toBeGreaterThan(0);
  });

  it('accepting twice keeps one tombstone and one job', async () => {
    const e = await rig();
    await accept(e);
    const again = await accept(e, NOW + 5);
    expect(again?.state).toBe('running');
    expect([count(e.sqlite, 'session_tombstones'), count(e.sqlite, 'session_deletion_jobs')]).toEqual([1, 1]);
  });

  it('answers null for a session the Project never held, and writes nothing', async () => {
    const e = await rig();
    expect(await tombstoneSession(e.serverEnv, SCOPE, 'never-here', 'owner', NOW)).toBeNull();
    expect([count(e.sqlite, 'session_tombstones'), count(e.sqlite, 'session_deletion_jobs')]).toEqual([0, 0]);
  });

  it('a tombstoned turn card leaves search even before its page runs', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO turn_cards (project_id, session_id, turn_key, state, input_hash, card, signal, records, covered, last_seq, created_at, carded_at)
      VALUES ('proj_1', ?, 'turn-1', 'carded', 'h', ?, 'high', 1, 0, 1, ?, ?)`, [S, JSON.stringify({ prompt: 'searchcanaryword', response: 'searchcanaryword' }), NOW, NOW]);
    expect((await searchProject(e.db, SCOPE, { query: 'searchcanaryword', mode: 'fts' })).results.length).toBeGreaterThan(0);
    await accept(e);
    expect((await searchProject(e.db, SCOPE, { query: 'searchcanaryword', mode: 'fts' })).results).toHaveLength(0);
  });
});

describe('the deletion routes', () => {
  it('answers 202 with the job on accept, reports its progress, and 404s a session it does not hold', async () => {
    const e = await rig();
    const res = await worker.fetch(await asOwnerPost(e.db, `/api/projects/proj_1/sessions/${S}/tombstone`, {}), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ persisted: true, deletion: { state: 'running' } });
    const progress = await worker.fetch(await asOwner(e.db, `/api/projects/proj_1/sessions/${S}/deletion`), { ...e.env, ...OWNER_ENV });
    expect(progress.status).toBe(200);
    expect(await progress.json()).toMatchObject({ deletion: { state: 'running', pausedBy: null } });
    const missing = await worker.fetch(await asOwnerPost(e.db, '/api/projects/proj_1/sessions/never-here/tombstone', {}), { ...e.env, ...OWNER_ENV });
    expect(missing.status).toBe(404);
    const never = await worker.fetch(await asOwner(e.db, '/api/projects/proj_1/sessions/never-here/deletion'), { ...e.env, ...OWNER_ENV });
    expect(never.status).toBe(404);
  });
});

describe('a deleted session reads as gone', () => {
  it('its raw events and transcripts are no one\'s to read back the moment its tombstone commits', async () => {
    const e = await rig();
    await e.send({ eventId: uuid(70), kind: 'transcript.segment', payload: { transcriptId: 'tx_raw', baseOffset: 0, length: 1, blob: 'a'.repeat(64), agent: 'claude-code' } }).catch(() => undefined);
    e.sqlite.run(`INSERT OR IGNORE INTO transcripts (project_id, transcript_id, session_id, machine_id, size, segment_count, first_received_at, last_received_at, token_id, prompt_identity_scheme)
      VALUES ('proj_1','tx_raw',?,'machine_1',1,0,0,0,?,'offset-v1')`, [S, e.ctx.tokenId]);
    e.sqlite.run(`INSERT OR IGNORE INTO raw_resources (project_id, kind, resource_id, reference_id, owner_member_id, machine_id, token_id, revision) VALUES ('proj_1','transcript','tx_raw','r1','mem_machine_1','machine_1',?,1)`, [e.ctx.tokenId]);
    expect(await memberAdmitted(e.serverEnv.db, 'proj_1', 'transcript', 'tx_raw', 'mem_machine_1')).toBe(true);
    await accept(e);
    expect(await memberAdmitted(e.serverEnv.db, 'proj_1', 'transcript', 'tx_raw', 'mem_machine_1')).toBe(false);
    expect(await membersAdmittedAmong(e.serverEnv.db, 'proj_1', 'transcript', ['tx_raw'], 'mem_machine_1')).toEqual([]);
  });
});

describe('the deletion job', () => {
  it('removes every derived row of the session, keeps the tombstone and spores, and leaves a neighbouring session whole', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1','neighbour','machine_1','t',0,0)`);
    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0)`);
    e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, prompt_id, observation_type, status, content, agent_line, author, created_at) VALUES ('proj_1','kept','a',?,?,'decision','active','stays','stays','a',?)`, [S, uuid(20), NOW]);
    e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, agent_line, author, created_at) VALUES ('proj_1','other','a','neighbour','decision','active','stays','stays','a',?)`, [NOW]);
    attach(e, 9, key(9), 'neighbour');
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(job(e)).toMatchObject({ state: 'complete', phase: 'complete' });
    expect((await stateOf(e))!.state).toBe('complete');
    for (const table of ['session_prompts', 'session_chunks', 'plans', 'publish_queue', 'events', 'event_refs']) expect({ table, n: count(e.sqlite, table) }).toEqual({ table, n: 0 });
    expect(count(e.sqlite, 'attachments')).toBe(1);
    expect(e.sqlite.query('SELECT id,prompt_id FROM spores ORDER BY id').all()).toEqual([{ id: 'kept', prompt_id: null }, { id: 'other', prompt_id: null }]);
    expect(count(e.sqlite, 'session_tombstones')).toBe(1);
  });

  it('a blob shared with another session stays; one only this session names is released', async () => {
    const e = await rig();
    attach(e, 1, key(1));
    attach(e, 2, key(2));
    attach(e, 3, key(2), 'neighbour');
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(e.sqlite.query('SELECT key FROM blobs ORDER BY key').all()).toEqual([{ key: key(2) }]);
  });

  it('a blob held in another Project stays: the same key there is its own registration', async () => {
    const e = await rig();
    e.sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES('proj_2','two',0) ON CONFLICT DO NOTHING");
    attach(e, 1, key(1));
    registerBlob(e.sqlite, { projectId: 'proj_2', key: key(1), size: 1, receivedAt: AGED });
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(e.sqlite.query('SELECT project_id FROM blobs ORDER BY project_id').all()).toEqual([{ project_id: 'proj_2' }]);
  });

  it('a row with no generation of its own records the generation registered when its page commits', async () => {
    const e = await rig();
    attach(e, 1, key(1));
    await accept(e);
    const freshGeneration = crypto.randomUUID();
    e.sqlite.run("UPDATE blobs SET generation=? WHERE key=?", [freshGeneration, key(1)]);
    await drainSessionDeletions(e.serverEnv, NOW);
    // Released in the commit that removed its row, under the generation registered then, which is the one the row named.
    expect(count(e.sqlite, 'attachments')).toBe(0);
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect((e.sqlite.query('SELECT physical FROM object_releases').all() as Array<{ physical: string }>)[0]!.physical).toContain(freshGeneration);
  });

  it('a young blob waits out the upload grace as a pending candidate, then releases', async () => {
    const e = await rig();
    attach(e, 1, key(1), S, NOW);
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect(e.sqlite.query('SELECT generation FROM blob_release_candidates').get()).toEqual({ generation: '*' });
    await drainObjectReleases(e.serverEnv, NOW + BLOB_RESERVATION_TTL_MS + 1);
    expect(count(e.sqlite, 'blobs')).toBe(0);
  });

  it('a job that dies midway resumes and finishes: an interrupted commit changes nothing, and no row is deleted twice', async () => {
    const e = await rig();
    for (let n = 0; n < 300; n += 1) e.sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
      VALUES ('proj_1', ?, ?, 'e', ?, 'image/png', 1, ?, 't', ?)`, [`bulk-${n}`, S, key(1000 + n), NOW, NOW]);
    await accept(e);
    let batches = 0;
    const flaky: RelationalStore = { ...e.serverEnv.db, batch: async (statements) => { batches += 1; if (batches === 4) throw new Error('the instance went away'); return e.serverEnv.db.batch(statements); } };
    await advanceSessionDeletions(flaky, NOW);
    const after = count(e.sqlite, 'attachments');
    expect(after).toBeGreaterThan(0);
    expect((await stateOf(e))!.failure).not.toBeNull();
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(count(e.sqlite, 'attachments')).toBe(0);
    expect(job(e).removed).toBeGreaterThanOrEqual(300);
  });

  it('every page leaves the job resumable: the rows and candidates of a page are atomic', async () => {
    const e = await rig();
    for (let n = 0; n < 5; n += 1) attach(e, n, key(n));
    await accept(e);
    const real = e.serverEnv.db.batch.bind(e.serverEnv.db);
    let failed = false;
    const once: RelationalStore = { ...e.serverEnv.db, batch: async (statements) => {
      // Fails the first commit that removes attachments, after everything before it applied: the store rolls the whole batch back.
      if (!failed && statements.length > 3) { failed = true; throw new Error('commit lost'); }
      return real(statements);
    } };
    await advanceSessionDeletions(once, NOW);
    expect(count(e.sqlite, 'attachments')).toBe(5);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect([count(e.sqlite, 'attachments'), count(e.sqlite, 'blobs')]).toEqual([0, 0]);
  });

  it('pauses on a recovery hold, deleting nothing and recording nothing, and finishes once the hold is released', async () => {
    const e = await rig();
    attach(e, 1, key(1));
    await accept(e);
    expect(await acquireRecoveryHold(e.db, 'hold-1', NOW)).toBe(true);
    const before = count(e.sqlite, 'attachments') + count(e.sqlite, 'events');
    expect((await advanceSessionDeletions(e.serverEnv.db, NOW)).changed).toBe(0);
    expect(count(e.sqlite, 'attachments') + count(e.sqlite, 'events')).toBe(before);
    expect(count(e.sqlite, 'blob_release_candidates')).toBe(0);
    expect((await stateOf(e))!.pausedBy).toBe('recovery_hold');
    expect(await releaseRecoveryHold(e.db, 'hold-1', NOW + 1, 'closed')).toBe(true);
    await drainSessionDeletions(e.serverEnv, NOW + 1);
    expect(job(e).state).toBe('complete');
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect((await stateOf(e))!.pausedBy).toBeNull();
  });

  it('pauses while a restore owns the session document and goes on once it clears', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO session_documents (project_id, session_id, state, generation, updated_at, restore_hold, due_at) VALUES ('proj_1', ?, 'live', 1, 0, 'restore', ?)
      ON CONFLICT(project_id,session_id) DO UPDATE SET restore_hold='restore', due_at=excluded.due_at`, [S, NOW + 1000]);
    await accept(e);
    const before = count(e.sqlite, 'events');
    expect((await advanceSessionDeletions(e.serverEnv.db, NOW)).changed).toBe(0);
    expect(count(e.sqlite, 'events')).toBe(before);
    expect((await stateOf(e))!.pausedBy).toBe('restore');
    e.sqlite.run("UPDATE session_documents SET restore_hold=NULL,due_at=NULL WHERE session_id=?", [S]);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(job(e).state).toBe('complete');
  });

  it('a hold opened mid-job stops the next page in its own commit', async () => {
    const e = await rig();
    await accept(e);
    await advanceSessionDeletions(e.serverEnv.db, NOW);
    const state = job(e);
    await acquireRecoveryHold(e.db, 'hold-2', NOW);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(job(e)).toMatchObject({ state: 'running', phase: state.phase });
    expect(state.state).toBe('running');
  });

  it('reports no progress for a session never deleted, and complete for one deleted before jobs existed', async () => {
    const e = await rig();
    expect(await stateOf(e)).toBeNull();
    e.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES ('proj_1', ?, 1, 'owner')`, [S]);
    expect((await stateOf(e))!.state).toBe('complete');
  });

  it('a verification that finds a row a writer slipped in runs the phases again and removes it', async () => {
    const e = await rig();
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    // A row present after phases have run past its table is the only way completion can be wrong.
    e.sqlite.run('UPDATE session_deletion_jobs SET state=\'running\', phase=\'verify\' WHERE session_id=?', [S]);
    attach(e, 7, key(7));
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(job(e).state).toBe('complete');
    expect(count(e.sqlite, 'attachments')).toBe(0);
  });
});

describe('a Deployment backup while a deletion runs', () => {
  const NOW_MS = Date.now();
  const payload = (text: string) => JSON.stringify({ text, origin: 'user' });
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const sessionRow = (f: ReturnType<typeof sqliteEnv>, id: string) => f.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1',?,'m','token',1,1)`, [id]);
  const archived = (f: ReturnType<typeof sqliteEnv>, event: string, session: string, text: string) => f.sqlite.run(
    `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes,raw_revision) VALUES('proj_1',?,?,'token','prompt','import',?,?,1,1,?,1)`,
    [event, session, payload(text), digest(event), Buffer.byteLength(payload(text))]);
  const lines = async (f: ReturnType<typeof sqliteEnv>) => new TextDecoder().decode((await backupSnapshot(f.serverEnv.db, f.serverEnv.blobs, { producer: 'test', now: NOW_MS })).bytes)
    .split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line) as { t: string; r: Record<string, unknown> });

  it('succeeds at every phase boundary, with real archived rows, and carries none of the deleted session\'s rows or text', async () => {
    const f = sqliteEnv();
    sessionRow(f, 'doomed');
    sessionRow(f, 'kept');
    archived(f, 'evt_doomed', 'doomed', 'doomedcanarytext');
    archived(f, 'evt_kept', 'kept', 'keptcanarytext');
    let moved = 0;
    for (let pass = 0; pass < 8 && moved < 2; pass += 1) moved += await archiveRawSources(f.serverEnv, NOW_MS, 90);
    expect(moved).toBe(2);
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({ n: 2 });
    await tombstoneSession(f.serverEnv, SCOPE, 'doomed', 'owner', NOW_MS);
    const phases = new Set<string>();
    for (let step = 0; step < 400; step += 1) {
      const job = f.sqlite.query('SELECT phase,state FROM session_deletion_jobs').get() as { phase: string; state: string };
      phases.add(job.phase);
      const artifact = await lines(f);
      const doomed = artifact.filter(row => row.r.session_id === 'doomed').map(row => row.t);
      expect({ phase: job.phase, tables: [...new Set(doomed)].sort() }).toEqual({ phase: job.phase, tables: ['session_tombstones', 'sessions'] });
      expect(artifact.some(row => JSON.stringify(row.r).includes('doomedcanarytext'))).toBe(false);
      expect(artifact.filter(row => row.t === 'archive_bundles' && row.r.session_id === 'kept')).toHaveLength(1);
      expect(artifact.filter(row => row.t === 'events' && row.r.session_id === 'kept')).toHaveLength(1);
      if (job.state === 'complete') break;
      await advanceSessionDeletions(f.serverEnv.db, NOW_MS, 1);
    }
    expect(phases.has('complete')).toBe(true);
    expect(phases.has('events')).toBe(true);
    f.sqlite.close();
  });

  it('keeps a blob a live row still names when the deleted session named it too, and drops one only it named', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1','neighbour','machine_1','t',0,0)`);
    attach(e, 1, key(1));
    attach(e, 2, key(2));
    attach(e, 3, key(2), 'neighbour');
    await accept(e);
    const artifact = new TextDecoder().decode((await backupSnapshot(e.serverEnv.db, e.serverEnv.blobs, { producer: 'test', now: NOW })).bytes);
    const blobs = artifact.split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line) as { t: string; r: Record<string, unknown> }).filter(row => row.t === 'blobs').map(row => row.r.key);
    expect(blobs).toContain(key(2));
    expect(blobs).not.toContain(key(1));
  });
});

describe('plans past the first page of acceptance', () => {
  it('are gone from the plan lists and direct reads and search, before any job step', async () => {
    const e = await rig();
    for (let n = 0; n < 135; n += 1) await e.send({ eventId: uuid(1000 + n), kind: 'plan', payload: { planKey: uuid(5000 + n), content: `plancanaryword ${n}`, status: 'active', tags: ['plan'] } });
    expect((await listProjectPlans(e.db, SCOPE)).length).toBeGreaterThan(0);
    await accept(e);
    expect(count(e.sqlite, 'plans')).toBeGreaterThan(0);
    expect(await listProjectPlans(e.db, SCOPE)).toEqual([]);
    const remaining = e.sqlite.query('SELECT plan_key FROM plans LIMIT 1').get() as { plan_key: string };
    expect(await getPlan(e.db, SCOPE, remaining.plan_key)).toBeNull();
    expect((await searchProject(e.db, SCOPE, { query: 'plancanaryword', mode: 'fts' })).results).toHaveLength(0);
  });
});

describe('activity of a deleted session', () => {
  it('leaves the credential and machine event lists at once, and other sessions stay', async () => {
    const e = await rig();
    await ingestEvent(e.serverEnv.db, e.ctx, envelope({ sessionId: 'other', eventId: uuid(900), kind: 'session.start', payload: { agent: 'codex', startedAt: NOW - 1 } }));
    await accept(e);
    const sessions = (await credentialEvents(e.serverEnv.db, e.ctx.tokenId, null, 50)).map(row => row.session_id);
    expect(sessions).toEqual(['other']);
    const machine = await machineActivity(e.serverEnv.db, 'machine_1', {});
    expect([...new Set(machine.rows.map(row => row.sessionId))]).toEqual(['other']);
  });
});

describe('the raw read of a blob a deleted session named', () => {
  it('is withheld while only deleted sessions name it, and stays readable while a live one does', async () => {
    const e = await rig();
    attach(e, 1, key(1));
    attach(e, 2, key(2));
    attach(e, 3, key(2), 'neighbour');
    const only = () => blobOnlyInDeletedSessions(e.serverEnv.db, 'proj_1', key(1));
    const shared = () => blobOnlyInDeletedSessions(e.serverEnv.db, 'proj_1', key(2));
    expect([await only(), await shared()]).toEqual([false, false]);
    await accept(e);
    expect([await only(), await shared()]).toEqual([true, false]);
  });

  it('is readable with no reference at all when no deletion touched it, and withheld once its release is recorded', async () => {
    const e = await rig();
    registerBlob(e.sqlite, { projectId: 'proj_1', key: key(5), size: 1, receivedAt: AGED });
    expect(await blobOnlyInDeletedSessions(e.serverEnv.db, 'proj_1', key(5))).toBe(false);
    e.sqlite.run(`INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT project_id,key,?,generation FROM blobs WHERE key=?`, [NOW, key(5)]);
    expect(await blobOnlyInDeletedSessions(e.serverEnv.db, 'proj_1', key(5))).toBe(true);
  });
});

describe('completion and routes', () => {
  it('removes a pin with no transcript before it reports complete', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO document_transcript_pins(project_id,transcript_id,session_id,agent,prompt_identity_scheme,record_identity_scheme,role,read_before) VALUES('proj_1','tx-orphan',?,'codex','offset-v1','offset-v1','primary',0)`, [S]);
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(job(e).state).toBe('complete');
    expect(count(e.sqlite, 'document_transcript_pins')).toBe(0);
  });

  it('removes title work of the session', async () => {
    const e = await rig();
    await accept(e);
    e.sqlite.run(`INSERT INTO session_title_work(project_id,session_id,mode) VALUES('proj_1',?,'claim')`, [S]);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(count(e.sqlite, 'session_title_work')).toBe(0);
  });

  it('names a route to every table with a session id, or why it keeps its rows', () => {
    const e = sqliteEnv();
    const kept = new Map([
      ['sessions', 'a deleted session stays known by its identity'], ['session_tombstones', 'the deletion itself'],
      ['session_read_facts', 'facts maintained per session id'], ['kpi_fact', 'history zeroed by triggers on the rows above it'],
      ['machine_capture_heads', 'capture recency is per machine'], ['blob_reservations', 'an upload authority: released by the drain'],
      ['spores', 'knowledge survives its session'], ['resolution_events', 'lineage of knowledge survives'], ['spore_count_facts', 'spore counts'], ['spore_session_counts', 'spore counts'],
      ['knowledge_git_provenance', 'knowledge'], ['knowledge_release_state', 'knowledge'], ['injection_served_items', 'the snapshot is masked at acceptance'],
      ['document_publication_facts', 'kept by triggers on the document rows'], ['document_due', 'kept by triggers on the document rows'],
      ['document_publication_ready', 'kept by triggers on the document rows'], ['document_publication_contributions', 'kept by triggers on the document rows'],
      ['document_publication_totals', 'kept by triggers on the document rows'], ['run_output_membership', 'a run keeps its output membership'], ['work_window_sessions', 'a run window'],
      ['session_deletion_jobs', 'the job itself'], ['transcript_reread_jobs', 'an owner reread job'],
    ]);
    const phased = new Set(DELETION_PHASES.map(phase => phase.table));
    const missing = (e.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .filter(({ name }) => (e.sqlite.query(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some(column => column.name === 'session_id' || column.name === 'source_session_id'))
      .map(({ name }) => name).filter(name => !name.includes('_fts') && !phased.has(name) && !kept.has(name));
    expect(missing).toEqual([]);
    e.sqlite.close();
  });

  it('stops the load when a blob reference has no route from a session, run bodies aside', () => {
    expect(() => assertBlobReferencesRouted([{ table: 'run_bodies' }, { table: 'attachments' }])).not.toThrow();
    expect(() => assertBlobReferencesRouted([{ table: 'mystery_refs' }])).toThrow('mystery_refs');
  });

  it('records a candidate from a proof only for the generation the proof names', async () => {
    const e = await rig();
    const proof = (blob: string, generation: string) => e.sqlite.run(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      VALUES('proj_1',?,?,'document',?,'e','h',?,?,1,0,1)`, [blob, generation, blob, S, blob]);
    const stale = crypto.randomUUID(), matching = crypto.randomUUID();
    registerBlob(e.sqlite, { projectId: 'proj_1', key: key(1), size: 1, receivedAt: AGED, generation: crypto.randomUUID() });
    registerBlob(e.sqlite, { projectId: 'proj_1', key: key(2), size: 1, receivedAt: AGED, generation: matching });
    proof(key(1), stale);
    proof(key(2), matching);
    await accept(e);
    await drainSessionDeletions(e.serverEnv, NOW);
    expect(count(e.sqlite, 'registered_content_proofs')).toBe(0);
    expect(e.sqlite.query('SELECT key FROM blobs').all()).toEqual([{ key: key(1) }]);
    expect(count(e.sqlite, 'blob_release_candidates')).toBe(0);
  });
});

describe('a job that cannot step', () => {
  it('does not stop a younger job, and reports the failure until a step succeeds', async () => {
    const e = await rig();
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1','younger','machine_1','t',0,0)`);
    attach(e, 1, key(1));
    attach(e, 2, key(2), 'younger');
    await accept(e);
    await tombstoneSession(e.serverEnv, SCOPE, 'younger', 'owner', NOW + 1);
    e.sqlite.run(`CREATE TRIGGER boom BEFORE DELETE ON attachments WHEN OLD.session_id='${S}' BEGIN SELECT RAISE(ABORT,'boom'); END`);
    const log = spyOn(console, 'log');
    try {
      await drainSessionDeletions(e.serverEnv, NOW + 1);
      expect(log.mock.calls.some(call => String(call[0]).includes('session_deletion_step_failed'))).toBe(true);
    } finally { log.mockRestore(); }
    const state = (session: string) => e.sqlite.query('SELECT state,failure FROM session_deletion_jobs WHERE session_id=?').get(session) as { state: string; failure: string | null };
    expect(state('younger').state).toBe('complete');
    expect(state(S)).toMatchObject({ state: 'running' });
    expect((await deletionProgress(e.serverEnv.db, 'proj_1', S, NOW + 1))!.failure?.errorClass).toEqual(expect.any(String));
    await expect(JOB_IMPLEMENTATIONS['session-deletion']!(e.serverEnv, NOW + 2, 'active')).rejects.toThrow('session_deletion_failed');
    e.sqlite.run('DROP TRIGGER boom');
    await drainSessionDeletions(e.serverEnv, NOW + 2);
    expect(state(S)).toEqual({ state: 'complete', failure: null });
  });
});
