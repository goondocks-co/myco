import { createHash } from 'node:crypto';
import { expect, it } from 'bun:test';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { listSegments } from '@myco-server-worker/read/transcript.js';
import { laneSelectionSql, PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { registerBlob } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW=Date.now();
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');

async function heldSegment(parsedOffset: number, parserContext: string | null = null) {
  const f=sqliteEnv();
  const text='retained source bytes';
  const blobKey=digest(text);
  f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES('proj_1','s-held','m','token',1,1)`).run();
  const physical=registerBlob(f.sqlite,{projectId:'proj_1',key:blobKey,size:Buffer.byteLength(text),receivedAt:1});
  f.bucket.seed(physical,{size:Buffer.byteLength(text),bytes:new TextEncoder().encode(text)});
  f.sqlite.query(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,
    first_received_at,last_received_at,token_id,parsed_offset,parser_context)
    VALUES('proj_1','tx-held','s-held','m','claude-code',?,1,1,'token',?,?)`)
    .run(Buffer.byteLength(text),parsedOffset,parserContext);
  f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
    created_at,received_at,payload_bytes,raw_revision)
    VALUES('proj_1','e-held','s-held','token','transcript.segment','cli','{}',?,1,?,2,1)`)
    .run(digest('held envelope'),NOW);
  f.sqlite.query(`INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,
    created_at,received_at,token_id) VALUES('proj_1','tx-held',0,? ,?,'e-held',1,1,'token')`)
    .run(Buffer.byteLength(text),blobKey);
  f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
  return f;
}

it('seeks the hot and cold segment indexes at the parser cursor', () => {
  const f=sqliteEnv();
  try {
    const plan=f.sqlite.query(`EXPLAIN QUERY PLAN ${laneSelectionSql('live',1,NOW)}`)
      .all(PARSER_VERSION) as Array<{detail:string}>;
    expect(plan.some(row=>/SEARCH s USING INDEX sqlite_autoindex_transcript_segments_1 .*base_offset>/.test(row.detail))).toBe(true);
    expect(plan.some(row=>/SEARCH r USING INDEX idx_raw_archive_refs_transcript .*base_offset>/.test(row.detail))).toBe(true);
    const rawPlan=f.sqlite.query(`EXPLAIN QUERY PLAN SELECT e.rowid,e.project_id,e.event_id
      FROM events e INDEXED BY idx_events_session LEFT JOIN raw_credentials c ON c.token_id=e.token_id
      WHERE (e.project_id,e.session_id,e.created_at,e.rowid)>(?,?,?,?)
      ORDER BY e.project_id,e.session_id,e.created_at,e.rowid LIMIT ?`)
      .all('','',-1,-1,20) as Array<{detail:string}>;
    expect(rawPlan.some(row=>/SEARCH e USING INDEX idx_events_session/.test(row.detail))).toBe(true);
  } finally {f.sqlite.close();}
});

it('archives an aged inline event exactly before clearing its stored body', async () => {
  const f=sqliteEnv();
  try {
    const payload='{"text":"exact  é  bytes","origin":"user"}';
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','sess_archive','m','token',1,1)`).run();
    f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision) VALUES('proj_1','evt_archive','sess_archive','token',
      'prompt','import',?,?,1,1,?,1)`).run(payload,digest('envelope'),Buffer.byteLength(payload));
    let archived=0;
    for(let pass=0;pass<6&&archived===0;pass+=1) archived=await archiveRawSources(f.serverEnv,NOW,90);
    expect(archived).toBe(1);
    expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='evt_archive'`).get())
      .toEqual({payload:'{}',payload_format:'archived'});
    expect(await eventContent(f.serverEnv,'proj_1','evt_archive')).toBe(payload);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE source_kind='event'`).get()).toEqual({n:0});
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles`).get()).toEqual({n:1});
  } finally {f.sqlite.close();}
});

it('splits one session at a claim-owner boundary while retaining exact event bytes', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-claims','m','token',1,1)`).run();
    f.sqlite.query(`INSERT INTO raw_credentials(token_id,owner_member_id,provenance)
      VALUES('token',NULL,'missing')`).run();
    f.sqlite.query(`INSERT INTO raw_claims(id,owner_member_id,cutoff_revision,min_revision,created_at,preview)
      VALUES('claim-a','mem_machine_1',1,1,1,'{}'),('claim-b','mem_machine_2',2,2,1,'{}')`).run();
    const bodies=['{"claim":"one"}','{"claim":"two"}'];
    for(const [index,payload] of bodies.entries()) {
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1',?,'s-claims','token','prompt','import',?,?,?,1,?,?)`)
        .run(`e-claim-${index}`,payload,digest(`claim-${index}`),index+1,Buffer.byteLength(payload),index+1);
    }
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles`).get()).toEqual({n:2});
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE source_kind='event'`).get()).toEqual({n:0});
    for(const [index,payload] of bodies.entries())
      expect(await eventContent(f.serverEnv,'proj_1',`e-claim-${index}`)).toBe(payload);
  } finally {f.sqlite.close();}
});

it('holds a bundle when a claim changes one entry owner before adoption', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-claim-race','m','token',1,1)`).run();
    f.sqlite.query(`INSERT INTO raw_credentials(token_id,owner_member_id,provenance)
      VALUES('token',NULL,'missing')`).run();
    for(let index=1;index<=2;index+=1) {
      const payload=JSON.stringify({text:`claim race ${index}`});
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1',?,'s-claim-race','token','prompt','import',?,?,?,1,?,?)`)
        .run(`e-race-${index}`,payload,digest(`race-${index}`),index,Buffer.byteLength(payload),index);
    }
    const db=f.serverEnv.db;
    const disturbed={...f.serverEnv,db:{...db,batch:async (statements:Parameters<typeof db.batch>[0])=>{
      if(statements.some(statement=>(statement as {sql?:string}).sql?.includes('UPDATE events SET'))) {
        f.sqlite.query(`INSERT INTO raw_claims(id,owner_member_id,cutoff_revision,min_revision,created_at,preview)
          VALUES('claim-race','mem_machine_1',2,2,1,'{}')`).run();
      }
      return db.batch(statements);
    }}};
    await expect(archiveRawSources(disturbed,NOW,90)).rejects.toThrow();
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='s-claim-race' AND payload_format='inline'`).get())
      .toEqual({n:2});
    expect(f.sqlite.query(`SELECT cursor_project,cursor_session FROM raw_event_archive_state WHERE id=1`).get())
      .toEqual({cursor_project:'',cursor_session:''});
  } finally {f.sqlite.close();}
});

it('packs one session across distinct event revisions with the same uploader', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-packed','m','token',1,1)`).run();
    f.sqlite.query(`INSERT INTO raw_credentials(token_id,owner_member_id,provenance)
      VALUES('token','mem_machine_1','recorded')`).run();
    const bodies=Array.from({length:5},(_,i)=>JSON.stringify({text:`event ${i}`}));
    for(const [index,payload] of bodies.entries()) {
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1',?,'s-packed','token','prompt','import',?,?,?,1,?,?)`)
        .run(`e-packed-${index}`,payload,digest(`packed-${index}`),index+1,Buffer.byteLength(payload),index+1);
    }
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(5);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n,MAX(entry_count) AS entries FROM archive_bundles`).get())
      .toEqual({n:1,entries:5});
    for(const [index,payload] of bodies.entries())
      expect(await eventContent(f.serverEnv,'proj_1',`e-packed-${index}`)).toBe(payload);
  } finally {f.sqlite.close();}
});

it('keeps session archive and tombstone ownership separate for one uploader', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO raw_credentials(token_id,owner_member_id,provenance)
      VALUES('token','mem_machine_1','recorded')`).run();
    for(const [index,session] of ['s-first','s-second'].entries()) {
      f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES('proj_1',?,'m','token',1,1)`).run(session);
      const payload=JSON.stringify({session});
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1',?,?,'token','prompt','import',?,?,1,1,?,?)`)
        .run(`e-session-${index}`,session,payload,digest(session),Buffer.byteLength(payload),index+1);
    }
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(f.sqlite.query(`SELECT session_id,entry_count FROM archive_bundles ORDER BY session_id`).all())
      .toEqual([{session_id:'s-first',entry_count:1},{session_id:'s-second',entry_count:1}]);
  } finally {f.sqlite.close();}
});

it('archives a full session page within the raw job admission budget', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-full','m','token',1,1)`).run();
    for(let index=0;index<20;index+=1) {
      const payload=JSON.stringify({text:`page event ${index}`});
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes)
        VALUES('proj_1',?,'s-full','token','prompt','import',?,?,?,1,?)`)
        .run(`e-full-${index}`,payload,digest(`full-${index}`),index,Buffer.byteLength(payload));
    }
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(20);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n,MAX(entry_count) AS entries FROM archive_bundles`).get())
      .toEqual({n:1,entries:20});
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE source_kind='event'`).get()).toEqual({n:0});
  } finally {f.sqlite.close();}
});

it('revisits a young event after the bounded session cursor wraps', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-wrap','m','token',1,1)`).run();
    const young='{"age":"young"}',old='{"age":"old"}';
    for(const [id,payload,created,received] of [['e-young',young,1,NOW],['e-old',old,2,1]] as const) {
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes)
        VALUES('proj_1',?,'s-wrap','token','prompt','import',?,?,?,?,?)`)
        .run(id,payload,digest(id),created,received,Buffer.byteLength(payload));
    }
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(f.sqlite.query(`SELECT payload_format FROM events WHERE event_id='e-young'`).get())
      .toEqual({payload_format:'inline'});
    expect(await archiveRawSources(f.serverEnv,NOW+100*86_400_000,90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv,NOW+100*86_400_000,90)).toBe(1);
    expect(await eventContent(f.serverEnv,'proj_1','e-young')).toBe(young);
    expect(await eventContent(f.serverEnv,'proj_1','e-old')).toBe(old);
  } finally {f.sqlite.close();}
});

it('streams a source beyond the ordinary page target without blocking a later due event', async () => {
  const f=sqliteEnv();
  try {
    const large=JSON.stringify({text:'é'.repeat(600_000)});
    const small='{"later":true}';
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','sess_large','m','token',1,1)`).run();
    for (const [id,payload] of [['a-large',large],['b-later',small]] as const) {
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1',?,'sess_large','token','prompt','import',?,?,1,1,?,1)`)
        .run(id,payload,digest(id),Buffer.byteLength(payload));
    }
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(f.sqlite.query(`SELECT cursor_id FROM raw_archive_state WHERE id=1`).get()).toEqual({cursor_id:''});
    expect(f.sqlite.query(`SELECT payload_format FROM events WHERE event_id='a-large'`).get()).toEqual({payload_format:'inline'});
    let archived=0;
    for(let pass=0;pass<8&&archived===0;pass+=1) archived=await archiveRawSources(f.serverEnv,NOW,90);
    expect(archived).toBe(1);
    expect(await eventContent(f.serverEnv,'proj_1','a-large')).toBe(large);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(await eventContent(f.serverEnv,'proj_1','b-later')).toBe(small);
  } finally {f.sqlite.close();}
});

it('retains exact parsed transcript bytes and their offset after removing the hot segment row', async () => {
  const f=sqliteEnv();
  try {
    const text='transcript bytes';
    const key=digest(text);
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','sess_segment','m','token',1,1)`).run();
    const physical=registerBlob(f.sqlite,{projectId:'proj_1',key,size:Buffer.byteLength(text),receivedAt:1});
    f.bucket.seed(physical,{size:Buffer.byteLength(text),bytes:new TextEncoder().encode(text)});
    f.sqlite.query(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,
      first_received_at,last_received_at,token_id,parsed_offset)
      VALUES('proj_1','tx_segment','sess_segment','m','claude-code',?,1,1,'token',?)`)
      .run(Buffer.byteLength(text),Buffer.byteLength(text));
    f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision)
      VALUES('proj_1','evt_segment','sess_segment','token','transcript.segment','cli','{}',?,1,1,2,1)`)
      .run(digest('segment envelope'));
    f.sqlite.query(`INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,
      created_at,received_at,token_id) VALUES('proj_1','tx_segment',0,? ,?,'evt_segment',1,1,'token')`)
      .run(Buffer.byteLength(text),key);
    f.sqlite.query(`UPDATE transcripts SET parser_context=? WHERE transcript_id='tx_segment'`)
      .run(JSON.stringify({mycoParserState:{},mycoParserUnfinished:0}));
    for(let pass=0;pass<10;pass+=1) await archiveRawSources(f.serverEnv,NOW,90);
    expect(f.sqlite.query(`SELECT 1 FROM transcript_segments WHERE transcript_id='tx_segment'`).get()).toBeNull();
    expect(f.sqlite.query(`SELECT disposition,archive_key FROM raw_archive_refs
      WHERE source_kind='transcript' AND transcript_id='tx_segment'`).get())
      .toEqual({disposition:'archived',archive_key:key});
    expect(await listSegments(f.db,{projectId:'proj_1'},'tx_segment'))
      .toEqual([{baseOffset:0,length:Buffer.byteLength(text),blobKey:key,createdAt:1,availability:'archived'}]);
    const held=await f.serverEnv.blobs.get(physical);
    expect(held===null?null:await new Response(held.body).text()).toBe(text);
  } finally {f.sqlite.close();}
});

it('archives a due event while a bounded transcript cursor crosses held rows', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-tail','m','token',1,1)`).run();
    for(let n=1;n<=40;n+=1) {
      const transcript=`tx-held-${n}`;
      f.sqlite.query(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,
        first_received_at,last_received_at,token_id,parsed_offset)
        VALUES('proj_1',?,'s-tail','m',1,1,1,'token',0)`).run(transcript);
      f.sqlite.query(`INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,size,received_at,
        transcript_id,base_offset,length,token_id,eligible_at)
        VALUES('proj_1','transcript',?,'s-tail',1,1,?,0,1,'token',?)`).run(transcript,transcript,1);
    }
    const payload='{"tail":true}';
    f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision)
      VALUES('proj_1','evt_tail','s-tail','token','prompt','import',?,?,1,1,?,1)`)
      .run(payload,digest('tail-envelope'),Buffer.byteLength(payload));
    const plan=f.sqlite.query(`EXPLAIN QUERY PLAN SELECT project_id,source_kind,source_id FROM raw_archive_refs
      INDEXED BY idx_raw_archive_refs_due WHERE disposition='hot' AND eligible_at<=?
      AND (eligible_at,project_id,source_kind,source_id)>(?,?,?,?)
      ORDER BY eligible_at,project_id,source_kind,source_id LIMIT ?`)
      .all(NOW, -1, '', '', '', 20) as Array<{detail:string}>;
    expect(plan.map(step=>step.detail).join(' ')).toMatch(/SEARCH .*idx_raw_archive_refs_due/);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(await eventContent(f.serverEnv,'proj_1','evt_tail')).toBe(payload);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE source_kind='event'`).get()).toEqual({n:0});
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE disposition='hot'`).get()).toEqual({n:40});
  } finally {f.sqlite.close();}
});

it('reaches a parsed transcript after same-age held transcript pages', async () => {
  const f=await heldSegment(Buffer.byteLength('retained source bytes'));
  try {
    for(let index=0;index<40;index+=1) {
      const id=`tx-${String(index).padStart(3,'0')}`;
      f.sqlite.query(`INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,size,received_at,
        transcript_id,base_offset,length,token_id,eligible_at)
        VALUES('proj_1','transcript',?,'s-held',1,1,?,0,1,'token',1)`).run(id,id);
    }
    let archived=false;
    for(let pass=0;pass<8&&!archived;pass+=1) {
      await archiveRawSources(f.serverEnv,NOW,90);
      archived=f.sqlite.query(`SELECT 1 FROM transcript_segments WHERE transcript_id='tx-held'`).get()===null;
    }
    expect(archived).toBe(true);
    expect(f.sqlite.query(`SELECT disposition FROM raw_archive_refs WHERE transcript_id='tx-held'`).get())
      .toEqual({disposition:'archived'});
  } finally {f.sqlite.close();}
});

it('keeps inline bytes and its cursor when publication lacks a durability acknowledgement', async () => {
  const f=sqliteEnv();
  try {
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-fault','m','token',1,1)`).run();
    const payload='{"held":"original"}';
    f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision)
      VALUES('proj_1','evt_fault','s-fault','token','prompt','import',?,?,1,1,?,1)`)
      .run(payload,digest('fault-envelope'),Buffer.byteLength(payload));
    const put=f.bucket.put.bind(f.bucket);
    f.bucket.put=async(key,value,options)=>{
      const stored=await put(key,value,options);
      return {size:stored.size};
    };
    await expect(archiveRawSources(f.serverEnv,NOW,90)).rejects.toThrow('content_durability_unavailable');
    expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='evt_fault'`).get())
      .toEqual({payload,payload_format:'inline'});
    expect(f.sqlite.query(`SELECT cursor_project,cursor_session FROM raw_event_archive_state WHERE id=1`).get())
      .toEqual({cursor_project:'',cursor_session:''});
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles`).get()).toEqual({n:0});
  } finally {f.sqlite.close();}
});

it('holds unread and pending-parser transcript source bytes', async () => {
  for(const [offset,context] of [[0,null],[Buffer.byteLength('retained source bytes'),'{"mycoParserUnfinished":1}']] as const) {
    const f=await heldSegment(offset,context);
    try {
      expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
      expect(f.sqlite.query(`SELECT 1 FROM transcript_segments WHERE transcript_id='tx-held'`).get()).not.toBeNull();
      expect(f.sqlite.query(`SELECT disposition FROM raw_archive_refs WHERE source_kind='transcript'`).get())
        .toEqual({disposition:'hot'});
    } finally {f.sqlite.close();}
  }
});

it('holds a parsed transcript source throughout an active recovery hold', async () => {
  const f=await heldSegment(Buffer.byteLength('retained source bytes'));
  try {
    f.sqlite.query(`INSERT INTO recovery_holds(token,acquired_at) VALUES('recovery',1)`).run();
    await expect(archiveRawSources(f.serverEnv,NOW,90)).rejects.toThrow();
    expect(f.sqlite.query(`SELECT 1 FROM transcript_segments WHERE transcript_id='tx-held'`).get()).not.toBeNull();
    expect(f.sqlite.query(`SELECT disposition FROM raw_archive_refs WHERE source_kind='transcript'`).get())
      .toEqual({disposition:'hot'});
  } finally {f.sqlite.close();}
});

it('keeps a parsed segment hot when its prepared receipt loses proof before clear', async () => {
  const f=await heldSegment(Buffer.byteLength('retained source bytes'));
  try {
    const db=f.serverEnv.db;
    const disturbed={...f.serverEnv,db:{...db,batch:async (statements:Parameters<typeof db.batch>[0])=>{
      if(statements.some(statement=>(statement as {sql?:string}).sql?.includes("UPDATE raw_archive_refs SET archive_key="))) {
        f.sqlite.query(`DELETE FROM registered_content_proofs WHERE source_kind='receipt'`).run();
      }
      return db.batch(statements);
    }}};
    await expect(archiveRawSources(disturbed,NOW,90)).rejects.toThrow();
    expect(f.sqlite.query(`SELECT 1 FROM transcript_segments WHERE transcript_id='tx-held'`).get()).not.toBeNull();
    expect(f.sqlite.query(`SELECT disposition FROM raw_archive_refs WHERE source_kind='transcript'`).get())
      .toEqual({disposition:'hot'});
  } finally {f.sqlite.close();}
});

it('refuses a changed source or a source that crosses the raw age boundary before clear', async () => {
  for(const mismatch of ['content','age'] as const) {
    const f=sqliteEnv();
    try {
      const payload='{"source":"held"}';
      f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES('proj_1','s-guard','m','token',1,1)`).run();
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes,raw_revision)
        VALUES('proj_1','e-guard','s-guard','token','prompt','import',?,?,1,1,?,1)`)
        .run(payload,digest('guard envelope'),Buffer.byteLength(payload));
      f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
      const db=f.serverEnv.db;
      const disturbed={...f.serverEnv,db:{...db,batch:async (statements:Parameters<typeof db.batch>[0])=>{
        if(statements.some(statement=>(statement as {sql?:string}).sql?.includes('UPDATE events SET'))) {
          if(mismatch==='content') f.sqlite.query(`UPDATE events SET payload='{"source":"changed"}' WHERE event_id='e-guard'`).run();
          else f.sqlite.query(`UPDATE events SET received_at=? WHERE event_id='e-guard'`).run(NOW);
        }
        return db.batch(statements);
      }}};
      await expect(archiveRawSources(disturbed,NOW,90)).rejects.toThrow();
      expect(f.sqlite.query(`SELECT payload_format FROM events WHERE event_id='e-guard'`).get())
        .toEqual({payload_format:'inline'});
      expect(f.sqlite.query(`SELECT cursor_project,cursor_session FROM raw_event_archive_state WHERE id=1`).get())
        .toEqual({cursor_project:'',cursor_session:''});
    } finally {f.sqlite.close();}
  }
});

it('keeps inline event bytes when a prepared receipt loses its registered proof before clear', async () => {
  const f=sqliteEnv();
  try {
    const payload='{"receipt":"required"}';
    f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','s-receipt','m','token',1,1)`).run();
    f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision)
      VALUES('proj_1','e-receipt','s-receipt','token','prompt','import',?,?,1,1,?,1)`)
      .run(payload,digest('receipt envelope'),Buffer.byteLength(payload));
    f.sqlite.query(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
    const db=f.serverEnv.db;
    const disturbed={...f.serverEnv,db:{...db,batch:async (statements:Parameters<typeof db.batch>[0])=>{
      if(statements.some(statement=>(statement as {sql?:string}).sql?.includes('UPDATE events SET'))) {
        f.sqlite.query(`DELETE FROM registered_content_proofs WHERE source_kind='receipt'`).run();
      }
      return db.batch(statements);
    }}};
    await expect(archiveRawSources(disturbed,NOW,90)).rejects.toThrow();
    expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='e-receipt'`).get())
      .toEqual({payload,payload_format:'inline'});
    expect(f.sqlite.query(`SELECT cursor_project,cursor_session FROM raw_event_archive_state WHERE id=1`).get())
      .toEqual({cursor_project:'',cursor_session:''});
  } finally {f.sqlite.close();}
});
