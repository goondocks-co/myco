import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { preparePromptAcknowledgement } from './helpers/extraction.js';
import { expect, it } from 'bun:test';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { handleBlob, type BlobResult } from '@myco-server-worker/ingest/blobs.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { rawMemberResourceSql } from '@myco-server-worker/db/raw/resources.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { lastActivityAt } from '@myco-server-worker/core/activity.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { sessions_listProjects as listProjects } from '@myco-server-worker/read/catalog/sessions.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase } from './helpers/two-scale.js';

const PROJECT = 'proj_event_budget';
const BLOB = await sha256Hex('x');
const CONTEXT = { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', bodyBytes: 100, now: 2_000 };
const SIZES = [1_000, 5_000] as const;
/** The most rows a session's start may write, whatever the history around it. */
const SESSION_START_WRITE_CEILING = 64;
/**
 * Rows a request may read at the large size beyond the small one: a later session reads a few more of its own Project's
 * rows, and random event ids land in different places among them. A walk of the history grows by thousands.
 */
const BOUNDED_EXTRA = 10;
async function member(db: RelationalStore) {
  await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
  await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
  await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
}

/** A prompt naming the uploaded blob, admitted into a new session on the measured store. */
async function admitPrompt(db: RelationalStore, store: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>, sessionId: string) {
  await store.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES(?,?,'machine','credential',1,1)`).bind(PROJECT, sessionId).run();
  await store.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,?,'live',1,1)").bind(PROJECT, sessionId).run();
  const eventId = crypto.randomUUID();
  const planned = await planEventWrite(db, CONTEXT, {
    eventId, sessionId, kind: 'prompt', createdAt: 1_000, channel: 'import',
    producer: { adapter: 'claude-code', version: '1' }, payload: { promptId: crypto.randomUUID(), blob: BLOB, origin: 'user' },
  }, { db, blobs });
  if (!planned.ok) throw new Error(JSON.stringify(planned));
  expect(planned.write.interpret(await db.batch(planned.write.statements))).toEqual({ persisted: true, projected: true });
  expect(await store.prepare('SELECT owner_member_id,provenance FROM raw_credentials WHERE token_id=?').bind('credential').first())
    .toEqual({ owner_member_id: 'member', provenance: 'recorded' });
  expect((await store.prepare('SELECT raw_revision FROM events WHERE project_id=? AND event_id=?').bind(PROJECT, eventId).first<{ raw_revision: number }>())!.raw_revision).toBeGreaterThan(0);
  expect(await store.prepare('SELECT session_id FROM storage_cleanup_queue WHERE project_id=? AND resource_kind=? AND resource_id=?').bind(PROJECT, 'event', eventId).first())
    .toEqual({ session_id: sessionId });
}

it('D1 event admission costs the same as unrelated archive bundles, events and blobs grow', async () => {
  const blobs = memoryBlobStore();
  const costs = await d1TwoScale({
    sizes: SIZES,
    setup: async (db) => {
      await member(db);
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES(?,'session','machine','credential',1,1)`).bind(PROJECT).run();
      // A session whose lifecycle facts already stand: a first touch reconciles history once, and this reads the steady state after it.
      await db.prepare("INSERT INTO session_lifecycle_facts(project_id,session_id) VALUES(?,'session')").bind(PROJECT).run();
      const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const uploaded = await handleBlob(env, new Request(`http://127.0.0.1/blobs/${BLOB}`, {
        method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x',
      }), { ...CONTEXT, now: 1, clock: () => 1, contentLength: 1, params: { key: BLOB } });
      const stored = await uploaded.json() as BlobResult;
      if (!stored.stored) throw new Error(JSON.stringify(stored));
      await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,due_at) VALUES(?,'session','live',1,1,0)").bind(PROJECT).run();
      // The credential's first admission records its owner once; every admission measured after it is the steady state.
      await admitPrompt(db, db, blobs, 'first-admission');
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO archive_bundles(id,project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
        SELECT i + 1,?3,'session','credential','archive-event-'||i,'hash','archive-'||i,'receipt-'||i,'digest',1,1,1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,raw_revision)
        SELECT ?3,'seed-'||i,'session','credential','notification','cli','{}','hash',1,1,1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT ?3,printf('%064d',i),1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001' FROM n`, PROJECT);
    },
    cases: [{ name: 'prompt admission', extra: BOUNDED_EXTRA, run: (db, { scale, store }) => admitPrompt(db, store, blobs, `capture-${scale}`) }, {
      // An archive or receipt object is never a member's resource, however many the Project holds.
      name: 'archive objects are not member resources',
      run: async (db, { scale, store }) => {
        const admitted = (key: string) => db.prepare(`SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`).bind(PROJECT, key, 'member').first<{ admitted: number }>();
        expect(await admitted(BLOB)).toEqual({ admitted: 1 });
        for (const key of [`archive-${scale}`, `receipt-${scale}`]) {
          await store.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
            VALUES(?, ?,1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001')`).bind(PROJECT, key).run();
          expect(await admitted(key)).toEqual({ admitted: 0 });
        }
      },
    }],
  });
  expectTwoScale(costs);
}, 180_000);

it('D1 recurring history readers cost the same as sessions, prompts and finished runs grow', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: SIZES,
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
        SELECT 'p',printf('session-%06d',i),'machine','token',i,i,i FROM n`);
      await eachUnit(db, from, to, `INSERT INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin)
        SELECT 'p',printf('prompt-%06d',i),printf('session-%06d',i),1,printf('prompt-%06d',i),i,i,'user' FROM n`);
      await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
        SELECT 'p',printf('run-%06d',i),'agent','extract-curate','completed',i*2,i*2 FROM n`);
    },
    cases: [
      { name: 'Project list', run: async (db) => expect((await listProjects(db)).map(row => row.projectId)).toEqual(['p']) },
      { name: 'finished-run retention', run: (db) => pruneTerminalRuns(db, 0, 500) },
      { name: 'last activity', run: async (db) => expect(await lastActivityAt(db)).toBeGreaterThan(0) },
    ],
  }));
}, 180_000);

type CaptureKind = 'session.start' | 'prompt' | 'notification' | 'session.end';

it('D1 capture writes cost the same as the Deployment\'s history grows, in the captured Project and others, and a session start stays under one ceiling', async () => {
  const blobs = memoryBlobStore();
  const sessionOf = (scale: number) => `capture-${scale}`;
  const deliveryOf = (scale: number) => `capture-${scale}-delivery`;
  const promptIds = new Map<number, string[]>();
  const clocks = new Map<number, number>();
  const event = async (db: RelationalStore, scale: number, kind: CaptureKind, payload: Record<string, unknown>) => {
    const now = (clocks.get(scale) ?? CONTEXT.now) + 10;
    clocks.set(scale, now);
    const planned = await planEventWrite(db, { ...CONTEXT, now }, {
      eventId: crypto.randomUUID(), sessionId: sessionOf(scale), kind, createdAt: now, channel: 'cli',
      producer: { adapter: 'claude-code', version: '1' }, payload,
    });
    if (!planned.ok) throw new Error(JSON.stringify(planned));
    expect(planned.write.interpret(await db.batch(planned.write.statements)))
      .toEqual(kind === 'notification' ? { persisted: true } : { persisted: true, projected: true });
  };
  const repeat = (count: number, act: (i: number) => Promise<unknown>) => async () => { for (let i = 0; i < count; i++) await act(i); };
  const cases: CostCase[] = [
    { name: 'session.start', run: (db, { scale }) => event(db, scale, 'session.start', { agent: 'claude-code' }) },
    { name: 'prompt', run: (db, { scale }) => repeat(5, async (i) => {
      const promptId = crypto.randomUUID();
      promptIds.set(scale, [...promptIds.get(scale) ?? [], promptId]);
      await event(db, scale, 'prompt', { promptId, text: `hello ${i}`, origin: 'user' });
    })() },
    { name: 'notification', run: (db, { scale }) => repeat(5, (i) => event(db, scale, 'notification', { message: `n${i}` }))() },
    { name: 'transcripts insert', run: (db, { scale }) => db.prepare(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id)
      VALUES(?,?,?,'machine',100,0,1,1,'credential')`).bind(PROJECT, sessionOf(scale), sessionOf(scale)).run() },
    { name: 'publication-progress UPDATE', run: async (db, { scale, store, restart }) => {
      await store.prepare("INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,updated_at) VALUES(?,?,1,?,0,'source-record-v1',1,1)")
        .bind(PROJECT, sessionOf(scale), sessionOf(scale)).run();
      restart();
      for (let i = 1; i <= 5; i++) await db.prepare('UPDATE transcript_publication SET published_offset=? WHERE project_id=? AND transcript_id=?').bind(i * 10, PROJECT, sessionOf(scale)).run();
    } },
    { name: 'transcript grows after full publish', run: async (db, { scale, store, restart }) => {
      for (let i = 1; i <= 5; i++) {
        await store.prepare('UPDATE transcript_publication SET published_offset=? WHERE project_id=? AND transcript_id=? AND generation=1')
          .bind(100 + (i - 1) * 10, PROJECT, sessionOf(scale)).run();
        if (i === 1) restart();
        await db.prepare('UPDATE transcripts SET size=? WHERE project_id=? AND transcript_id=?').bind(100 + i * 10, PROJECT, sessionOf(scale)).run();
      }
    } },
    { name: 'transcript grows during directory pass', run: async (db, { scale, store, restart }) => {
      await store.prepare('UPDATE transcript_publication SET published_offset=150 WHERE project_id=? AND transcript_id=?').bind(PROJECT, sessionOf(scale)).run();
      await store.prepare("UPDATE session_documents SET publication_after='[]' WHERE project_id=? AND session_id=?").bind(PROJECT, sessionOf(scale)).run();
      restart();
      await db.prepare('UPDATE transcripts SET size=160 WHERE project_id=? AND transcript_id=?').bind(PROJECT, sessionOf(scale)).run();
    } },
    { name: 'session.end', run: (db, { scale }) => event(db, scale, 'session.end', { endedAt: clocks.get(scale) }) },
    { name: 'document counters move', run: async (db, { scale, store, restart }) => {
      await store.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES(?,?,'machine','credential',1,1)`).bind(PROJECT, deliveryOf(scale)).run();
      await store.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,?,'live',1,1)`).bind(PROJECT, deliveryOf(scale)).run();
      restart();
      await db.prepare('UPDATE session_documents SET prompts=prompts+1,tool_calls=tool_calls+1 WHERE project_id=? AND session_id=?').bind(PROJECT, deliveryOf(scale)).run();
    } },
    { name: 'receipt selected', run: (db, { scale }) => db.prepare(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at) VALUES(?,?,'selected','selected-selected','selected','[]',1)`).bind(PROJECT, deliveryOf(scale)).run() },
    { name: 'receipt delivered', run: (db, { scale }) => db.prepare(`UPDATE spore_injections SET delivered_at=2,delivered_prompt_id='late-prompt' WHERE project_id=? AND session_id=? AND id='selected'`).bind(PROJECT, deliveryOf(scale)).run() },
    { name: 'served answer', run: (db, { scale }) => db.prepare(`INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,outcome,context_chars,parts,skipped,failures,selection,created_at) VALUES(?,?,'answer','answered','served',0,'[]','[]','[]','{}',1)`).bind(PROJECT, deliveryOf(scale)).run() },
    { name: 'prompt lands on a delivery', run: (db, { scale }) => db.prepare(`INSERT INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin) VALUES(?,'late-prompt',?,1,'late-prompt',1,1,'user')`).bind(PROJECT, deliveryOf(scale)).run() },
    ...['first', 'further'].map((id): CostCase => ({ name: `${id} attachment`, run: (db, { scale }) => db.prepare(`INSERT INTO attachments(project_id,attachment_id,session_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at) VALUES(?,?,?,?,'b','image/png',1,1,'t',1)`).bind(PROJECT, `${id}-${scale}`, deliveryOf(scale), `${id}-${scale}`).run() })),
    { name: 'tombstone', run: (db, { scale }) => db.prepare(`INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by) VALUES(?,?,NULL,1,'member')`).bind(PROJECT, deliveryOf(scale)).run() },
    { name: 'learning slice completion', run: async (db, { scale, store, restart }) => {
      const configured = serverEnvFromBindings({ MYCO_DB: store, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const now = clocks.get(scale)!;
      await publishDocuments({ ...configured, blobs }, now, { calls: 500, deadline: Infinity, clock: () => now });
      const acknowledge = await preparePromptAcknowledgement(db, { projectId: PROJECT }, promptIds.get(scale)![0]!);
      restart();
      expect(await acknowledge()).toBe(true);
    } },
  ];
  const costs = await d1TwoScale({
    sizes: SIZES,
    setup: async (db) => {
      promptIds.clear();
      clocks.clear();
      await member(db);
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_history','history',1)").run();
    },
    grow: async (db, from, to) => {
      // Half of each unit's history is the captured Project's own, half another Project's.
      const project = `CASE WHEN i % 2 = 0 THEN ?3 ELSE 'proj_history' END`;
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT ${project},'session-'||i,'machine','credential',1,1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin)
        SELECT ${project},'prompt-'||i,'session-'||i,1,'prompt-'||i,1,i,'user' FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id)
        SELECT ${project},'transcript-'||i,'session-'||i,'machine',100,0,1,1,'credential' FROM n`, PROJECT);
    },
    cases: cases.map(item => ({ extra: BOUNDED_EXTRA, ...item })),
    warm: true,
  });
  expectTwoScale(costs);
  for (const start of costs.filter(cost => cost.name === 'session.start')) {
    for (const written of start.writes) expect(written, `session.start rows written (statistics: ${start.statistics})`).toBeLessThanOrEqual(SESSION_START_WRITE_CEILING);
  }
}, 300_000);
