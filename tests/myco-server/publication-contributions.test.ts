import { engineAssertions } from '@myco-server-worker/core/tick.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { deferDocumentReadFailure } from '@myco-server-worker/ingest/document-read-failures.js';
import { statusMetadata } from '@myco-server-worker/read/meta.js';
import { afterEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V717, V717_STATEMENTS } from '@myco-server-worker/db/schema-v717.js';
import { publicationContributionSchema } from '@myco-server-worker/db/documents/contributions.js';
import { dueSessions, deferFailedPublication } from '@myco-server-worker/db/documents/publication.js';
import { deferObservedDocumentRead } from '@myco-server-worker/db/documents/failures.js';
import { readDocumentStatus, pendingPublication } from '@myco-server-worker/db/documents/status.js';
import { catchUpProjections, projectionReadiness, catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { seededSqlite, sqliteD1 } from './helpers/d1.js';

const stores: Database[] = [];
afterEach(() => { for (const db of stores.splice(0)) db.close(); });

function fixture(old = false) {
  const sqlite = old ? new Database(':memory:') : seededSqlite();
  stores.push(sqlite);
  if (old) for (const step of SCHEMA_STEPS.filter(step => step.version < V717)) for (const sql of step.statements) sqlite.exec(sql);
  sqlite.exec("INSERT INTO projects(project_id,name,created_at) VALUES('proj_pub','publication',1)");
  sqlite.exec("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_pub','s','m','t',1,1)");
  const db = sqliteRelationalStore(sqlite);
  const transcript = (id: string, bytes = 100, imported: number | null = null) => sqlite.query(`INSERT INTO transcripts
    (project_id,transcript_id,session_id,machine_id,token_id,agent,role,size,segment_count,first_received_at,last_received_at,imported_at)
    VALUES('proj_pub',?,'s','m','t','codex','subagent',?,1,1,1,?)`).run(id, bytes, imported);
  const publish = (id: string, generation: number, offset: number) => sqlite.query(`INSERT INTO transcript_publication
    (project_id,transcript_id,session_id,generation,published_offset,record_scheme,parser_version,updated_at)
    VALUES('proj_pub',?,'s',?,?,'legacy-session-v1',6,1)
    ON CONFLICT(project_id,transcript_id,generation) DO UPDATE SET published_offset=excluded.published_offset`).run(id, generation, offset);
  const facts = () => sqlite.query("SELECT transcripts,bytes,imported FROM document_publication_facts WHERE project_id='proj_pub' AND session_id='s'").get();
  const revision = () => (sqlite.query("SELECT publication_input_revision AS n FROM session_documents WHERE project_id='proj_pub' AND session_id='s'").get() as { n: number }).n;
  return { sqlite, db, transcript, publish, facts, revision };
}

it('keeps unread bytes, pending sources and import membership exact across growth, replay, generations and deletion', () => {
  const r = fixture();
  r.transcript('a', 100, 1); r.transcript('empty', 0, 1);
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 100, imported: 1 });
  r.publish('a', 1, 60);
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 40, imported: 1 });
  const rev = r.revision(); r.publish('a', 1, 60);
  expect(r.revision()).toBe(rev);
  r.publish('a', 1, 100);
  expect(r.facts()).toEqual({ transcripts: 0, bytes: 0, imported: 1 });
  r.sqlite.exec("UPDATE transcripts SET size=150 WHERE transcript_id='a'");
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 50, imported: 1 });
  r.publish('a', 2, 120);
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 50, imported: 1 });
  r.sqlite.exec("UPDATE session_documents SET generation=2 WHERE project_id='proj_pub' AND session_id='s'");
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 30, imported: 1 });
  r.sqlite.exec("UPDATE transcripts SET imported_at=NULL WHERE transcript_id='empty'");
  expect(r.facts()).toEqual({ transcripts: 1, bytes: 30, imported: 0 });
  r.sqlite.exec("UPDATE session_documents SET state='convert' WHERE project_id='proj_pub' AND session_id='s'");
  expect(r.facts()).toEqual({ transcripts: 0, bytes: 0, imported: 0 });
  r.sqlite.exec("UPDATE session_documents SET state='live' WHERE project_id='proj_pub' AND session_id='s'");
  r.sqlite.exec("DELETE FROM transcripts WHERE transcript_id='a'");
  expect(r.facts()).toEqual({ transcripts: 0, bytes: 0, imported: 0 });
  r.sqlite.exec("DELETE FROM transcript_publication WHERE transcript_id='a'");
  expect(r.facts()).toEqual({ transcripts: 0, bytes: 0, imported: 0 });
});

it('preserves source identities and bytes through additive migration and interrupted catch-up', async () => {
  const r = fixture(true);
  for (let i = 0; i < 55; i++) { r.transcript(`t${String(i).padStart(3,'0')}`, 100, 1); r.publish(`t${String(i).padStart(3,'0')}`, 1, 40); }
  r.sqlite.exec("INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,ord,created_at,preview) VALUES('proj_pub','s',1,'canonical-prompt',0,1,'retained body')");
  const snapshot = () => ['transcripts','transcript_publication','session_prompts'].map(table => r.sqlite.query(`SELECT * FROM ${table} ORDER BY 1,2,3`).all());
  const before = snapshot(); const facts = r.facts();
  r.sqlite.transaction(() => { for (const sql of V717_STATEMENTS) r.sqlite.exec(sql); })();
  expect(snapshot()).toEqual(before);
  expect(r.facts()).toEqual(facts);
  expect(await readDocumentStatus(r.db)).toEqual({ state: 'building' });
  await expect(catchUpPhase(r.db, 'publicationSessions')).rejects.toThrow('publication_inputs_building');
  expect(r.facts()).toEqual(facts);
  await catchUpPhase(r.db, 'publicationInputs');
  expect(r.facts()).toEqual(facts);
  r.sqlite.exec("UPDATE transcripts SET size=110 WHERE transcript_id='t000'");
  r.publish('t054', 1, 70);
  r.transcript('late-key-before-cursor', 30, 1);
  for (let i = 0; i < 20 && await projectionReadiness(r.db, 'publication') === 'building'; i++) await catchUpProjections(r.db);
  expect(await projectionReadiness(r.db, 'publication')).toBe('ready');
  expect(r.facts()).toEqual({ transcripts: 56, bytes: 3310, imported: 1 });
  expect((await readDocumentStatus(r.db))).toMatchObject({ lagBytes: 3310 });
  const caught = r.facts();
  r.sqlite.exec("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication'");
  for (let i = 0; i < 10 && await projectionReadiness(r.db, 'publication') === 'building'; i++) await catchUpProjections(r.db);
  expect(r.facts()).toEqual(caught);
  expect(r.sqlite.query("SELECT prompt_id,preview FROM session_prompts WHERE project_id='proj_pub'").all()).toEqual([{ prompt_id: 'canonical-prompt', preview: 'retained body' }]);
  expect(r.sqlite.query("SELECT COUNT(*) AS n FROM transcripts WHERE project_id='proj_pub'").get()).toEqual({ n: 56 });
});

it('rejects stale failure backoff even when a queue dependency changes without changing counts or deadlines', async () => {
  const r = fixture(); r.transcript('a');
  r.sqlite.exec("INSERT INTO publish_queue(project_id,session_id,rank,created_at,event_id,retry_at,retry_cause) VALUES('proj_pub','s',0,1,'e',0,json_object('eventId','first'))");
  const [observed] = await dueSessions(r.db, 100, 1);
  r.sqlite.exec("UPDATE publish_queue SET retry_cause=json_object('eventId','second') WHERE project_id='proj_pub'");
  expect(r.revision()).toBeGreaterThan(observed!.revision);
  await deferFailedPublication(r.db, observed!, 100);
  expect(await dueSessions(r.db, 100, 1)).toHaveLength(1);
  const [current] = await dueSessions(r.db, 100, 1);
  await deferFailedPublication(r.db, current!, 100);
  expect(await dueSessions(r.db, 100, 1)).toHaveLength(0);
  const rev = r.revision();
  r.sqlite.exec("UPDATE publish_queue SET retry_cause=retry_cause WHERE project_id='proj_pub'");
  expect(r.revision()).toBe(rev);
});

it('settles a current read failure atomically and leaves newer generations, inputs and cards ready', async () => {
  const r = fixture(); r.transcript('a');
  r.sqlite.exec("INSERT INTO turn_cards(project_id,session_id,turn_key,state,changes,settle_at,created_at) VALUES('proj_pub','s','turn','pending',1,0,1)");
  const observed = { project_id: 'proj_pub', session_id: 's', generation: 1, publication_input_revision: r.revision(), turnKey: 'turn', changes: 1 };
  const deadlines = () => [r.sqlite.query("SELECT rollup_due,rollup_failure FROM session_documents WHERE project_id='proj_pub'").get(), r.sqlite.query("SELECT settle_at FROM turn_cards WHERE project_id='proj_pub'").get()];
  const before = deadlines();
  r.sqlite.exec("UPDATE session_documents SET generation=2 WHERE project_id='proj_pub'");
  await deferObservedDocumentRead(r.db, observed, 'document_blob_missing', 100);
  expect(deadlines()).toEqual(before);
  const current = { ...observed, generation: 2, publication_input_revision: r.revision() };
  r.sqlite.exec("UPDATE turn_cards SET changes=2 WHERE project_id='proj_pub'");
  await deferObservedDocumentRead(r.db, current, 'document_blob_missing', 100);
  expect(deadlines()).toEqual(before);
  await deferObservedDocumentRead(r.db, { ...current, changes: 2 }, 'document_blob_missing', 100);
  expect(deadlines()).toEqual([{ rollup_due: 60100, rollup_failure: 'document_blob_missing' }, { settle_at: 60100 }]);
  r.sqlite.exec("CREATE TRIGGER refuse_read_failure BEFORE UPDATE OF rollup_failure ON session_documents BEGIN SELECT RAISE(ABORT,'probe rollback'); END");
  await expect(deferObservedDocumentRead(r.db, { ...current, changes: 2 }, 'document_blob_missing', 60100)).rejects.toThrow('probe rollback');
  expect(deadlines()).toEqual([{ rollup_due: 60100, rollup_failure: 'document_blob_missing' }, { settle_at: 60100 }]);
});

it('pins the immutable step to the contribution generator', () => {
  expect(V717_STATEMENTS).toEqual(publicationContributionSchema());
});

it('keeps due sessions and both power assertions live while publication measures are building', async () => {
  const r = fixture(true);
  for (let i=0;i<55;i++) r.transcript(`old-${String(i).padStart(3,'0')}`);
  r.sqlite.transaction(() => { for (const sql of V717_STATEMENTS) r.sqlite.exec(sql); })();
  expect(await catchUpPhase(r.db, 'publicationInputs')).toBe(50);
  r.sqlite.exec("UPDATE session_documents SET due_at=NULL WHERE session_id='s'");
  for (const [session, imported] of [['new', null], ['import', 1]] as const) {
    r.sqlite.query("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_pub',?,'m','t',1,1)").run(session);
    r.sqlite.query("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,token_id,size,first_received_at,last_received_at,imported_at) VALUES('proj_pub',?,?,'m','t',100,1,1,?)").run(session, session, imported);
  }
  for (const step of SCHEMA_STEPS.filter(step => step.version > V717)) for (const sql of step.statements) r.sqlite.exec(sql);
  const env = serverEnvFromBindings({ MYCO_DB: sqliteD1(r.sqlite), BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
  expect(await pendingPublication(r.db, 100)).toEqual({ state: 'building', sessions: 2, transcripts: null, bytes: null,
    imported: { sessions: null, transcripts: null, bytes: null } });
  expect(await engineAssertions(env, 100)).toEqual(expect.arrayContaining([
    { name: 'transcript:pending', maxDepth: 'active' }, { name: 'import:pending', maxDepth: 'idle' },
  ]));
  r.sqlite.exec("UPDATE session_documents SET state='convert',due_at=77,build=json_object('report',json_object('classes',json_object('omitted',2))) WHERE session_id='new'");
  expect((await pendingPublication(r.db, 100)).sessions).toBe(1);
  expect(r.sqlite.query("SELECT state,due_at,classes FROM document_publication_facts WHERE session_id='new'").get()).toEqual({state:'convert',due_at:77,classes:'{}'});
  r.sqlite.exec("UPDATE session_documents SET state='live',due_at=NULL WHERE session_id='import'");
  expect((await pendingPublication(r.db, 100)).sessions).toBe(0);
  expect((await engineAssertions(env, 100)).filter(row => ['transcript:pending','import:pending'].includes(row.name))).toEqual([]);
  r.sqlite.exec("UPDATE session_documents SET state='live',due_at=0 WHERE session_id IN ('new','import')");
  for (let i=0;i<20 && await projectionReadiness(r.db,'publication')==='building';i++) {
    await catchUpPhase(r.db,'publicationInputs'); await catchUpPhase(r.db,'publicationSessions');
  }
  expect(await pendingPublication(r.db, 100)).toEqual({ sessions: 2, transcripts: 2, bytes: 200, imported: { sessions: 1, transcripts: 1, bytes: 100 } });
});

it('retires superseded derived generations and empty totals while preserving publication sources', () => {
  const r=fixture(); r.transcript('a');
  for(let generation=1;generation<=20;generation++) r.publish('a',generation,100);
  const sources=r.sqlite.query('SELECT * FROM transcript_publication ORDER BY generation').all();
  r.sqlite.exec("UPDATE session_documents SET generation=20 WHERE session_id='s'");
  r.sqlite.exec("UPDATE transcripts SET size=110 WHERE transcript_id='a'");
  expect(r.facts()).toEqual({transcripts:1,bytes:10,imported:0});
  expect(r.sqlite.query("SELECT generation FROM document_publication_contributions WHERE kind='frontier'").all()).toEqual([{generation:20}]);
  expect(r.sqlite.query("SELECT generation FROM document_publication_totals WHERE kind='frontier'").all()).toEqual([{generation:20}]);
  expect(r.sqlite.query('SELECT * FROM transcript_publication ORDER BY generation').all()).toEqual(sources);
  r.sqlite.exec("DELETE FROM session_documents WHERE session_id='s'");
  r.sqlite.exec("DELETE FROM transcripts WHERE transcript_id='a'");
  expect(r.sqlite.query('SELECT * FROM document_publication_totals').all()).toEqual([]);
});

it('reports stale failures only as telemetry and defers a card alone when no live document exists', async () => {
  const r=fixture(); r.transcript('a');
  r.sqlite.exec("INSERT INTO turn_cards(project_id,session_id,turn_key,state,changes,settle_at,created_at) VALUES('proj_pub','s','turn','pending',1,0,1)");
  const observed={project_id:'proj_pub',session_id:'s',generation:1,publication_input_revision:r.revision()};
  r.sqlite.exec("UPDATE transcripts SET size=110 WHERE transcript_id='a'");
  const log=spyOn(console,'log').mockImplementation(() => {});
  try {
    await deferDocumentReadFailure(r.db,observed,new Error('document_blob_missing'),100);
    expect(log.mock.calls.flat().map(value => JSON.parse(String(value)))).toContainEqual(expect.objectContaining({kind:'document_read_failure_stale',error:'document_blob_missing'}));
    expect((await statusMetadata(r.db)).documentPublishFailure).toBeNull();
  } finally { log.mockRestore(); }
  expect(await deferObservedDocumentRead(r.db,observed,'document_blob_missing',100)).toBe(false);
  r.sqlite.exec("UPDATE session_documents SET state='convert' WHERE session_id='s'");
  const card={...observed,generation:null,publication_input_revision:null,turnKey:'turn',changes:1};
  expect(await deferObservedDocumentRead(r.db,card,'document_blob_missing',100)).toBe(true);
  expect(r.sqlite.query("SELECT settle_at FROM turn_cards WHERE turn_key='turn'").get()).toEqual({settle_at:60100});
  expect(r.sqlite.query("SELECT rollup_failure FROM session_documents WHERE session_id='s'").get()).toEqual({rollup_failure:null});
  r.sqlite.exec("UPDATE turn_cards SET changes=2,settle_at=0 WHERE turn_key='turn'");
  expect(await deferObservedDocumentRead(r.db,card,'document_blob_missing',200)).toBe(false);
  expect(r.sqlite.query("SELECT settle_at FROM turn_cards WHERE turn_key='turn'").get()).toEqual({settle_at:0});
  r.sqlite.exec("UPDATE session_documents SET state='live' WHERE session_id='s'");
  expect(await deferObservedDocumentRead(r.db,{...card,changes:2},'document_blob_missing',200)).toBe(false);
});


it('settles a frontier against the transcript’s current session after it moves', () => {
  const r=fixture(); r.transcript('a'); r.publish('a',1,40);
  r.sqlite.exec("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_pub','other','m','t',1,1)");
  r.sqlite.exec("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,due_at) VALUES('proj_pub','other','live',1,1,0)");
  r.sqlite.exec("UPDATE transcripts SET session_id='other' WHERE transcript_id='a'");
  r.publish('a',1,60);
  expect(r.sqlite.query("SELECT session_id,bytes FROM document_publication_facts ORDER BY session_id").all())
    .toEqual([{session_id:'other',bytes:40},{session_id:'s',bytes:0}]);
  r.sqlite.exec("DELETE FROM transcript_publication WHERE transcript_id='a'");
  expect(r.sqlite.query("SELECT bytes FROM document_publication_facts WHERE session_id='other'").get()).toEqual({bytes:100});
});


it('keeps sessions added after refused activation inside the eventual initialization frontier', async () => {
  const r=fixture(true); r.transcript('a');
  r.sqlite.transaction(() => { for(const sql of V717_STATEMENTS) r.sqlite.exec(sql); })();
  await expect(catchUpPhase(r.db,'publicationSessions')).rejects.toThrow('publication_inputs_building');
  r.sqlite.exec("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_pub','z','m','t',1,1)");
  r.sqlite.exec("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,token_id,size,first_received_at,last_received_at) VALUES('proj_pub','z','z','m','t',100,1,1)");
  await catchUpPhase(r.db,'publicationInputs');
  await catchUpPhase(r.db,'publicationSessions');
  expect(await projectionReadiness(r.db,'publication')).toBe('ready');
  expect(await pendingPublication(r.db,100)).toEqual({sessions:2,transcripts:2,bytes:200,imported:{sessions:0,transcripts:0,bytes:0}});
});


it("publication rows that predate their session's document row still settle exactly", () => {
  const r=fixture(); r.publish('d',1,100);
  const publication=r.sqlite.query("SELECT * FROM transcript_publication WHERE transcript_id='d'").all();
  r.transcript('d',75);
  expect(r.facts()).toEqual({transcripts:0,bytes:0,imported:0});
  expect(r.sqlite.query("SELECT * FROM transcript_publication WHERE transcript_id='d'").all()).toEqual(publication);
  const totals=()=>r.sqlite.query("SELECT kind,generation,bytes,pending,sources,imported FROM document_publication_totals WHERE session_id='s' ORDER BY kind,generation").all();
  expect(totals()).toEqual([
    {kind:'frontier',generation:1,bytes:-75,pending:-1,sources:0,imported:0},
    {kind:'source',generation:0,bytes:75,pending:1,sources:1,imported:0},
  ]);
  r.sqlite.exec("DELETE FROM session_documents WHERE session_id='s'");
  r.publish('d',1,50); r.publish('d',2,10);
  expect(totals()).toEqual([
    {kind:'frontier',generation:1,bytes:-50,pending:0,sources:0,imported:0},
    {kind:'frontier',generation:2,bytes:-10,pending:0,sources:0,imported:0},
    {kind:'source',generation:0,bytes:75,pending:1,sources:1,imported:0},
  ]);
  r.sqlite.exec("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,due_at) VALUES('proj_pub','s','live',1,1,0)");
  expect(r.facts()).toEqual({transcripts:1,bytes:25,imported:0});
  r.sqlite.exec("UPDATE session_documents SET generation=2 WHERE session_id='s'");
  expect(r.facts()).toEqual({transcripts:1,bytes:65,imported:0});
});
