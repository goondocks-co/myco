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
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='evt_archive'`).get())
      .toEqual({payload:'{}',payload_format:'archived'});
    expect(await eventContent(f.serverEnv,'proj_1','evt_archive')).toBe(payload);
    expect(f.sqlite.query(`SELECT disposition,archive_key,receipt_key FROM raw_archive_refs WHERE source_id='evt_archive'`).get())
      .toMatchObject({disposition:'archived',archive_key:digest(payload)});
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

it('advances a bounded due cursor past held rows to a sparse eligible event', async () => {
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
    f.sqlite.query(`UPDATE raw_archive_refs SET eligible_at=2 WHERE source_kind='event' AND source_id='evt_tail'`).run();
    const plan=f.sqlite.query(`EXPLAIN QUERY PLAN SELECT project_id,source_kind,source_id FROM raw_archive_refs
      INDEXED BY idx_raw_archive_refs_due WHERE disposition='hot' AND eligible_at<=?
      AND (eligible_at,project_id,source_kind,source_id)>(?,?,?,?)
      ORDER BY eligible_at,project_id,source_kind,source_id LIMIT ?`)
      .all(NOW, -1, '', '', '', 20) as Array<{detail:string}>;
    expect(plan.map(step=>step.detail).join(' ')).toMatch(/SEARCH .*idx_raw_archive_refs_due/);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(0);
    expect(f.sqlite.query(`SELECT payload FROM events WHERE event_id='evt_tail'`).get()).toEqual({payload});
    expect(await archiveRawSources(f.serverEnv,NOW,90)).toBe(1);
    expect(await eventContent(f.serverEnv,'proj_1','evt_tail')).toBe(payload);
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
    expect(f.sqlite.query(`SELECT cursor_project,cursor_id FROM raw_archive_state WHERE id=1`).get())
      .toEqual({cursor_project:'',cursor_id:''});
    expect(f.sqlite.query(`SELECT 1 FROM event_content_refs WHERE event_id='evt_fault'`).get()).toBeNull();
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

it('refuses stale event source revision and a due hint newer than the raw age window', async () => {
  for(const mismatch of ['revision','age'] as const) {
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
      if(mismatch==='revision') f.sqlite.query(`UPDATE raw_archive_refs SET raw_revision=raw_revision+1 WHERE source_id='e-guard'`).run();
      else f.sqlite.query(`UPDATE raw_archive_refs SET received_at=? WHERE source_id='e-guard'`).run(NOW);
      await expect(archiveRawSources(f.serverEnv,NOW,90)).rejects.toThrow();
      expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='e-guard'`).get())
        .toEqual({payload,payload_format:'inline'});
      expect(f.sqlite.query(`SELECT cursor_id FROM raw_archive_state WHERE id=1`).get()).toEqual({cursor_id:''});
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
      if(statements.some(statement=>(statement as {sql?:string}).sql?.includes('UPDATE raw_archive_refs SET archive_key='))) {
        f.sqlite.query(`DELETE FROM registered_content_proofs WHERE source_kind='receipt'`).run();
      }
      return db.batch(statements);
    }}};
    await expect(archiveRawSources(disturbed,NOW,90)).rejects.toThrow();
    expect(f.sqlite.query(`SELECT payload,payload_format FROM events WHERE event_id='e-receipt'`).get())
      .toEqual({payload,payload_format:'inline'});
    expect(f.sqlite.query(`SELECT cursor_id FROM raw_archive_state WHERE id=1`).get()).toEqual({cursor_id:''});
  } finally {f.sqlite.close();}
});
