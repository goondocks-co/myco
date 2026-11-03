import { markPromptProcessed } from './helpers/extraction.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { expect, it } from 'bun:test';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { withDocumentStores, captureDocumentSession } from './helpers/document-stores.js';
import { envelope, publishFixture, sqliteEnv, uuid, memoryBlobStore } from './helpers/fixtures.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';

const NOW = 1_800_000_000_000;
const enable = "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')";
/** The pause window, before whole-session learning resumes, when the hold reads unread facts and unpublished transcripts. */
const paused = "DELETE FROM schema_meta WHERE key='learning_resumed_at'";

it('releases acknowledged facts while retaining the same prompt identity in another Project',async()=>{
  const f=sqliteEnv();
  try {
    f.sqlite.run(paused);
    await captureDocumentSession(f.db,'proj_1','shared-session');
    await captureDocumentSession(f.db,'proj_2','shared-session');
    await publishFixture(f);
    f.sqlite.run(enable);
    expect(await markPromptProcessed(f.db,{projectId:'proj_1'},uuid(20))).toBe(true);
    expect(await learningHolds(f.db,'proj_1','shared-session')).toBe(false);
    expect(await learningHolds(f.db,'proj_2','shared-session')).toBe(true);
    await tombstoneSession(f.serverEnv,{projectId:'proj_2'},'shared-session','owner',NOW+2);
    expect(await learningHolds(f.db,'proj_2','shared-session')).toBe(false);
  } finally {f.sqlite.close();}
});

it('retains unread facts without imposing session settlement and applies owner switches on both stores', async () => {
  await withDocumentStores(async db => {
    await db.prepare(paused).run();
    await captureDocumentSession(db);
    const blobs=memoryBlobStore();
    await publishDocuments({db,blobs},NOW,{calls:500,deadline:Date.now()+60000,clock:Date.now});
    await db.prepare(enable).run();
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    expect(await learningHolds(db, 'other', 'session')).toBe(false);
    await markPromptProcessed(db,{projectId:'project'},uuid(20));
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    await db.prepare("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,first_received_at,last_received_at,token_id) VALUES('project','t','session','m','claude-code',1,1,1,'token')").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks','{\"extract-curate\":{\"enabled\":false}}',1,'owner')").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    await db.prepare("UPDATE deployment_settings SET value='{\"extract-curate\":{\"enabled\":true}}' WHERE leaf='agent.tasks'").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    await db.prepare("UPDATE deployment_settings SET value='false' WHERE leaf='agent.scheduled_tasks_enabled'").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    await db.prepare("UPDATE deployment_settings SET value='true' WHERE leaf='agent.scheduled_tasks_enabled'").run();
    await db.prepare("INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES('project','vault_evolution',0,1,'owner')").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    await db.prepare("UPDATE project_capabilities SET enabled=1 WHERE project_id='project'").run();
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,updated_at)
      VALUES('project','t',1,'session',1,'source-record-v1',1,1)`).run();
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
  });
}, 30_000);

it('advances past learning-held inline sessions and revisits them after release', async () => {
  const f = sqliteEnv();
  try {
    f.sqlite.run(paused);
    await captureDocumentSession(f.db, 'proj_1', 'held');
    f.sqlite.run(enable);
    f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','unheld','m','token',1,1)");
    f.sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes,raw_revision)
      VALUES('proj_1','unheld-event','unheld','token','session.start','import','{}','hash',1,1,2,1)`);
    f.sqlite.run("UPDATE raw_archive_state SET phase=2 WHERE id=1");
    for (let pass=0;pass<6;pass++) await archiveRawSources(f.serverEnv,NOW,90);
    expect(f.sqlite.query("SELECT payload_format FROM events WHERE event_id='unheld-event'").get()).toEqual({ payload_format: 'archived' });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE session_id='held' AND payload_format='archived'").get()).toEqual({ n: 0 });
    await publishFixture(f,NOW);
    await markPromptProcessed(f.db,{projectId:'proj_1'},uuid(20));
    for (let pass=0;pass<8;pass++) await archiveRawSources(f.serverEnv,NOW,90);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE session_id='held' AND payload_format='inline'").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); }
});

it('refuses inline archival when an admitted prompt lands after selection, without changing selected source', async () => {
  const f = sqliteEnv();
  try {
    f.sqlite.run(paused);
    await captureDocumentSession(f.db, 'proj_1', 'race');
    f.sqlite.run(enable);
    await publishFixture(f,NOW);
    await markPromptProcessed(f.db,{projectId:'proj_1'},uuid(20));
    f.sqlite.run("UPDATE raw_archive_state SET phase=2 WHERE id=1");
    const tokenId = f.sqlite.query("SELECT created_by_token_id AS id FROM sessions WHERE session_id='race'").get() as { id: string };
    let inserted=false;
    let admission: unknown;
    const db=f.serverEnv.db;
    const env={...f.serverEnv,db:{...db,batch:async(statements:Parameters<typeof db.batch>[0])=>{
      if (!inserted && statements.some(statement=>(statement as {sql?:string}).sql?.includes('UPDATE events SET'))) {
        inserted=true;
        const result=await ingestEvent(f.db,{projectId:'proj_1',machineId:'machine',tokenId:tokenId.id,bodyBytes:1,now:NOW},
          envelope({eventId:uuid(90),sessionId:'race',kind:'prompt',payload:{promptId:uuid(91),text:'new unread fact',origin:'user'}}),
          {db:f.db,blobs:f.bucket});
        admission=result;
      }
      return db.batch(statements);
    }}};
    await expect(archiveRawSources(env,NOW,90)).rejects.toThrow();
    expect(inserted).toBe(true);
    expect(admission).toMatchObject({persisted:true});
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE session_id='race' AND payload_format='archived'").get()).toEqual({ n: 0 });
    expect(f.sqlite.query("SELECT cursor_project FROM raw_event_archive_state WHERE id=1").get()).toEqual({ cursor_project: '' });
  } finally { f.sqlite.close(); }
});
