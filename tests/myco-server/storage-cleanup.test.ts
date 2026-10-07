import { describe,expect,it } from 'bun:test';
import { storageCleanup,storageCleanupPending,inputArchiveStatements } from '@myco-server-worker/core/storage-cleanup.js';
import { cleanupCandidate } from '@myco-server-worker/core/storage-cleanup.js';
import { eventContent,eventArchiveStatements,prepareArchive } from '@myco-server-worker/core/event-content.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { eventOrderingTimeSql,resolvePresentedDates } from '@myco-server-worker/ingest/projections.js';
import { measuredContentEnv,remainingContentBudget } from '@myco-server-worker/core/content-budget.js';
import { releaseBlobs } from '@myco-server-worker/core/object-release.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv,envelope,uuid } from './helpers/fixtures.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';

const now=Date.now();
type Rig=ReturnType<typeof sqliteEnv>;
const tokens=new WeakMap<Rig,string>();
async function tokenId(rig:Rig):Promise<string>{
  const old=tokens.get(rig);if(old)return old;
  const issued=await issueMemberToken(rig.db,{memberId:'mem_machine_1',machineId:'machine_1'},now);
  tokens.set(rig,issued.tokenId);return issued.tokenId;
}
async function oldEvent(rig:Rig,id=uuid(101),text='λ'.repeat(4000),origin='import'):Promise<string> {
  const body=envelope({eventId:id,kind:'response',channel:origin,payload:{responseId:id,text}});
  const result=await ingestEvent(rig.db,{projectId:'proj_1',machineId:'machine_1',tokenId:await tokenId(rig),bodyBytes:0,now,writeOrigin:'server'},body);
  expect(result.persisted).toBe(true);
  return JSON.stringify(body.payload);
}
async function drain(rig:Rig,env:Pick<ServerEnv,'db'|'blobs'>=rig.serverEnv):Promise<void> {
  for(let pass=0;pass<100 && await storageCleanupPending(rig.db);pass++) await storageCleanup(env,now);
  expect(await storageCleanupPending(rig.db)).toBe(false);
}

describe('archive-before-clear storage cleanup',()=>{
  it('seeks the next Project even when its event id sorts before the previous Project cursor',async()=>{
    const rig=sqliteEnv();
    try{
      const first=await oldEvent(rig,uuid(999),'first Project');
      for(let n=1000;n<1019;n++)await oldEvent(rig,uuid(n),'first Project page');
      const next=envelope({eventId:uuid(1),kind:'response',channel:'import',payload:{responseId:uuid(1),text:'second Project'}});
      expect((await ingestEvent(rig.db,{projectId:'proj_2',machineId:'machine_1',tokenId:await tokenId(rig),bodyBytes:0,now,
        writeOrigin:'server'},next)).persisted).toBe(true);
      rig.sqlite.exec('DELETE FROM storage_cleanup_queue');
      await drain(rig);
      expect(await eventContent(rig.serverEnv,'proj_1',uuid(999))).toBe(first);
      expect(await eventContent(rig.serverEnv,'proj_2',uuid(1))).toBe(JSON.stringify(next.payload));
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE payload_format='archived'").get()).toEqual({n:21});
    }finally{rig.sqlite.close();}
  });
  it('keeps exact UTF-8 spelling, projections, privacy and a behind-cursor import without transcript reconstruction',async()=>{
    const rig=sqliteEnv();
    try {
      const text=await oldEvent(rig);
      const before=rig.sqlite.query('SELECT * FROM responses').all();
      const beforeFts=rig.sqlite.query('SELECT rowid,text FROM responses_fts').all();
      await drain(rig);
      const row=rig.sqlite.query('SELECT payload,payload_format FROM events WHERE event_id=?').get(uuid(101));
      expect(row).toEqual({payload:'{}',payload_format:'archived'});
      expect(await eventContent(rig.serverEnv,'proj_1',uuid(101))).toBe(text);
      expect(rig.sqlite.query('SELECT * FROM responses').all()).toEqual(before);
      expect(rig.sqlite.query('SELECT rowid,text FROM responses_fts').all()).toEqual(beforeFts);
      expect(await new RawResourceReader(rig.serverEnv,{projectId:'proj_1'},{kind:'member',memberId:'mem_machine_1'}).event(uuid(101))).toBe(text);
      for(const memberId of ['mem_machine_2','mem_machine_3','mem_machine_4']) expect(await new RawResourceReader(rig.serverEnv,{projectId:'proj_1'},{kind:'member',memberId}).event(uuid(101))).toBeNull();
      for(const kind of ['run','grant'] as const) expect(await new RawResourceReader(rig.serverEnv,{projectId:'proj_1'},{kind,id:'run'}).event(uuid(101))).toBeNull();
      const late=await oldEvent(rig,uuid(1),'behind cursor');
      expect(await storageCleanupPending(rig.db)).toBe(true);
      await drain(rig);
      expect(await eventContent(rig.serverEnv,'proj_1',uuid(1))).toBe(late);
    }finally{rig.sqlite.close();}
  });

  it('requires durable publication even when unflushed objects are immediately readable',async()=>{
    const rig=sqliteEnv();
    try {
      const original=await oldEvent(rig);
      const env={...rig.serverEnv,blobs:{...rig.bucket,put:async(...args:Parameters<typeof rig.bucket.put>)=>({size:(await rig.bucket.put(...args)).size})}};
      await expect(storageCleanup(env,now)).rejects.toThrow('content_durability_unavailable');
      rig.bucket.objects.clear();
      expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:0});
    }finally{rig.sqlite.close();}
  });

  it('verifies the bytes again when reusing a same-sized registered archive',async()=>{
    const rig=sqliteEnv();
    try{
      const original=await oldEvent(rig);
      const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'event',resource_id:uuid(101)});
      await prepareArchive(rig.serverEnv,'event',row!,now);
      const env={...rig.serverEnv,blobs:{...rig.bucket,get:async(...args:Parameters<typeof rig.bucket.get>)=>{
        const object=await rig.bucket.get(...args);
        if(object===null)return null;
        return {...object,body:new Blob([new Uint8Array(object.size).fill(32)]).stream()};
      }}};
      await expect(storageCleanup(env,now)).rejects.toThrow('content_archive_digest_mismatch');
      expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
    }finally{rig.sqlite.close();}
  });

  it('holds the original through PUT, body read-back and receipt faults, then retries once',async()=>{
    for(const fault of ['put','body','receipt'] as const){
      const rig=sqliteEnv();
      try {
        const original=await oldEvent(rig);
        let puts=0,gets=0;
        const env={...rig.serverEnv,blobs:{...rig.bucket,
          put:async(...args:Parameters<typeof rig.bucket.put>)=>{puts++;if(fault==='put' || (fault==='receipt'&&puts===2)) throw new Error('injected_put');return rig.bucket.put(...args);},
          get:async(...args:Parameters<typeof rig.bucket.get>)=>{gets++;if(fault==='body'&&gets===1)return null;return rig.bucket.get(...args);},
        }};
        await expect(storageCleanup(env,now)).rejects.toThrow();
        expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
        expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:0});
        await drain(rig);
        expect(await eventContent(rig.serverEnv,'proj_1',uuid(101))).toBe(original);
        const converted=rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get();
        await storageCleanup(rig.serverEnv,now);
        expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual(converted);
      }finally{rig.sqlite.close();}
    }
  });

  it('refuses a stale checkpoint and a source mutation after publication atomically',async()=>{
    for(const fault of ['checkpoint','source','tombstone'] as const){
      const rig=sqliteEnv();
      try {
        const original=await oldEvent(rig);
        let puts=0;
        const env={...rig.serverEnv,blobs:{...rig.bucket,put:async(...args:Parameters<typeof rig.bucket.put>)=>{
          const stored=await rig.bucket.put(...args);
          if(++puts===2){
            if(fault==='checkpoint')rig.sqlite.exec('UPDATE storage_cleanup_state SET revision=revision+1');
            if(fault==='source')rig.sqlite.query('UPDATE events SET payload=? WHERE event_id=?').run('{"changed":true}',uuid(101));
            if(fault==='tombstone')rig.sqlite.query('INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES(?,?,?,?)').run('proj_1','sess_1',now,'mem_machine_1');
          }
          return stored;
        }}};
        await expect(storageCleanup(env,now)).rejects.toThrow();
        expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:0});
        expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:fault==='source'?'{"changed":true}':original,payload_format:'inline'});
      }finally{rig.sqlite.close();}
    }
  });

  it('archives a legacy large input, retains complete facts and output bytes, and refuses a missing full proof',async()=>{
    const rig=sqliteEnv();
    try {
      const id=uuid(150);
      const output='out'.repeat(1300);
      await ingestEvent(rig.db,{projectId:'proj_1',machineId:'machine_1',tokenId:await tokenId(rig),bodyBytes:0,now},envelope({eventId:id,kind:'tool.use',payload:{toolCallId:id,toolName:'Edit',input:{file_path:'whole.ts'},output,success:true}}),rig.serverEnv);
      const input=JSON.stringify({text:'🦋'.repeat(2000),file_path:'late-path.ts'});
      rig.sqlite.query('UPDATE tool_calls SET input=?,files_affected=? WHERE tool_call_id=?').run(input,JSON.stringify(['late-path.ts']),id);
      const facts=rig.sqlite.query('SELECT tool_name,files_affected,output_preview,output_blob_key,success,token_id FROM tool_calls').get();
      await drain(rig);
      const row=rig.sqlite.query('SELECT input,input_blob_key,input_bytes FROM tool_calls').get() as {input:string;input_blob_key:string;input_bytes:number};
      expect(new TextEncoder().encode(row.input).length).toBeLessThanOrEqual(2048);
      expect(row.input_bytes).toBe(new TextEncoder().encode(input).length);
      expect(await processedBody(rig.serverEnv,{projectId:'proj_1'},'tool-input',id)).toBe(input);
      expect(rig.sqlite.query('SELECT tool_name,files_affected,output_preview,output_blob_key,success,token_id FROM tool_calls').get()).toEqual(facts);
      rig.sqlite.query("DELETE FROM registered_content_proofs WHERE source_kind='bundle'").run();
      await expect(processedBody(rig.serverEnv,{projectId:'proj_1'},'tool-input',id)).rejects.toThrow('event_content_reference_invalid');
    }finally{rig.sqlite.close();}
  });

  it('streams an oversized row under revision guards and completes only after an empty confirmation page',async()=>{
    const seen=new Set<string>();
    const rig=sqliteEnv({onSql(sql,sqlite){
      if(!/SELECT rowid AS source_rowid,project_id,(event_id|tool_call_id) AS resource_id/.test(sql))return;
      seen.add(sql.includes('FROM tool_calls')?'tool_calls':'events');
      expect(sql).toContain('(project_id,session_id,created_at,rowid)>(?,?,?,?)');
      expect(sql).toMatch(/ORDER BY project_id,session_id,created_at,rowid LIMIT \?/);
      for(const cursor of [['','',-1,-1],['proj_1','s1',now-1000,1],['proj_1','s1',now,999]]){
        const plan=sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...cursor,20);
        expect(JSON.stringify(plan)).toContain('SEARCH');
        expect(JSON.stringify(plan)).toMatch(/idx_(events|tool_calls)_session/);
        expect(JSON.stringify(plan)).not.toMatch(/SCAN (events|tool_calls)|TEMP B-TREE/);
      }
    }});
    try {
      const original=JSON.stringify({text:'x'.repeat(1500000)});
      await oldEvent(rig,uuid(101),'small');
      rig.sqlite.query('UPDATE events SET payload=?,payload_bytes=?,envelope_hash=? WHERE event_id=?')
        .run(original,new TextEncoder().encode(original).length,await sha256Hex(original),uuid(101));
      await drain(rig);
      expect(await eventContent(rig.serverEnv,'proj_1',uuid(101))).toBe(original);
      expect(rig.sqlite.query('SELECT complete FROM storage_cleanup_state').get()).toEqual({complete:1});
      expect([...seen].sort()).toEqual(['events','tool_calls']);
    }finally{rig.sqlite.close();}
  });

  it('keeps a released archive generation inadmissible even after successful read-back',async()=>{
    for(const released of ['body','receipt'] as const){
      const rig=sqliteEnv();
      try{
        await oldEvent(rig);
        const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'event',resource_id:uuid(101)});
        const archive=await prepareArchive(rig.serverEnv,'event',row!,now);
        rig.sqlite.query('DELETE FROM registered_content_proofs WHERE key=?').run(archive[released].key);
        await releaseBlobs(rig.db,[{projectId:'proj_1',key:archive[released].key}],now);
        await expect(rig.db.batch(eventArchiveStatements(rig.db,row!,archive))).rejects.toThrow();
        expect(rig.sqlite.query('SELECT payload_format FROM events').get()).toEqual({payload_format:'inline'});
      }finally{rig.sqlite.close();}
    }
  });
  it('refuses a tombstone that arrives after body and receipt publication',async()=>{
    const rig=sqliteEnv();
    try{
      const original=await oldEvent(rig);
      const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'event',resource_id:uuid(101)});
      const archive=await prepareArchive(rig.serverEnv,'event',row!,now);
      rig.sqlite.query('INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES(?,?,?,?)')
        .run('proj_1','sess_1',now,'mem_machine_1');
      await expect(rig.db.batch(eventArchiveStatements(rig.db,row!,archive))).rejects.toThrow();
      expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:0});
    }finally{rig.sqlite.close();}
  });
  it('refuses a changed input event identity in the same clear transaction',async()=>{
    const rig=sqliteEnv();
    try{
      const id=uuid(160);
      await ingestEvent(rig.db,{projectId:'proj_1',machineId:'machine_1',tokenId:await tokenId(rig),bodyBytes:0,now},envelope({eventId:id,kind:'tool.use',payload:{toolCallId:id,toolName:'Read',input:{path:'x'},success:true}}),rig.serverEnv);
      const full=JSON.stringify({body:'x'.repeat(3000)});
      rig.sqlite.query('UPDATE tool_calls SET input=? WHERE tool_call_id=?').run(full,id);
      const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'tool-input',resource_id:id});
      const writes=await inputArchiveStatements(rig.serverEnv,row!,now);
      rig.sqlite.query('UPDATE events SET envelope_hash=? WHERE event_id=?').run('changed',id);
      await expect(rig.db.batch(writes)).rejects.toThrow();
      expect(rig.sqlite.query('SELECT input,input_blob_key FROM tool_calls').get()).toEqual({input:full,input_blob_key:null});
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM processed_resources WHERE kind='tool-input'").get()).toEqual({n:0});
    }finally{rig.sqlite.close();}
  });

  it('rejects same-size corrupted body and receipt read-backs before clear',async()=>{
    for(const fault of ['body','receipt'] as const){
      const rig=sqliteEnv();
      try{
        const original=await oldEvent(rig);
        let gets=0;
        const env={...rig.serverEnv,blobs:{...rig.bucket,get:async(...args:Parameters<typeof rig.bucket.get>)=>{
          const result=await rig.bucket.get(...args);
          const corrupt=++gets===(fault==='body'?1:2);
          if(!result||!corrupt)return result;
          return {...result,body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(result.size).fill(32));controller.close();}})};
        }}};
        await expect(storageCleanup(env,now)).rejects.toThrow('content_archive_digest_mismatch');
        expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
        expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:0});
      }finally{rig.sqlite.close();}
    }
  });

  it('retains absent and null origin, title-only ends and end-first lifecycle ordering',async()=>{
    for(const origin of [undefined,null,'system','user']){
      const rig=sqliteEnv();
      try{
        const ctx={projectId:'proj_1',machineId:'machine_1',tokenId:await tokenId(rig),bodyBytes:0,now,writeOrigin:'server' as const};
        const items=[
          envelope({eventId:uuid(170),kind:'session.end',channel:'import',createdAt:500,payload:{title:'import title'}}),
          envelope({eventId:uuid(171),kind:'session.end',channel:'import',createdAt:700,payload:{endedAt:900}}),
          envelope({eventId:uuid(169),kind:'session.start',channel:'import',createdAt:400,payload:{startedAt:400,agent:'claude-code'}}),
          envelope({eventId:uuid(172),kind:'prompt',channel:'import',createdAt:600,payload:{promptId:uuid(173),text:'captured',origin:'user'}}),
          envelope({eventId:uuid(174),kind:'prompt',channel:'cli',createdAt:1000,payload:{promptId:uuid(175),text:'after end',...(origin===undefined?{}:{origin})}}),
        ];
        for(const item of items){
          const admitted=await ingestEvent(rig.db,ctx,item,rig.serverEnv);
          if((origin===null||origin===undefined)&&item.eventId===uuid(174)){
            // Stored legacy scalars preserve SQL semantics across archival.
            if(!admitted.persisted){
              await ingestEvent(rig.db,ctx,{...item,payload:{promptId:uuid(175),text:'after end',origin:'system'}},rig.serverEnv);
            }
            rig.sqlite.query('UPDATE events SET payload=? WHERE event_id=?').run(JSON.stringify(item.payload),item.eventId);
          }else expect(admitted.persisted).toBe(true);
        }
        await resolvePresentedDates(rig.db,'proj_1','sess_1').run();
        const before=rig.sqlite.query('SELECT occurred_started_at,occurred_ended_at,ended_at,title FROM sessions').get();
        const ordering=()=>rig.sqlite.query(`SELECT ${eventOrderingTimeSql('e','endedAt')} AS at FROM events e WHERE event_id=?`).get(uuid(171));
        expect(ordering()).toEqual({at:900});
        const rows=rig.sqlite.query('SELECT event_id FROM events').all() as {event_id:string}[];
        for(const {event_id} of rows){
          const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'event',resource_id:event_id},true);
          await rig.db.batch(eventArchiveStatements(rig.db,row!,await prepareArchive(rig.serverEnv,'event',row!,now)));
        }
        await resolvePresentedDates(rig.db,'proj_1','sess_1').run();
        expect(rig.sqlite.query('SELECT occurred_started_at,occurred_ended_at,ended_at,title FROM sessions').get()).toEqual(before);
        expect(ordering()).toEqual({at:900});
        expect(rig.sqlite.query('SELECT archived_title_only_end AS title_only_end,archived_ended_at AS ended_at FROM events WHERE event_id=?').get(uuid(170))).toEqual({title_only_end:1,ended_at:500});
        expect(rig.sqlite.query('SELECT archived_prompt_origin AS prompt_origin FROM events WHERE event_id=?').get(uuid(174))).toEqual({prompt_origin:origin??null});
      }finally{rig.sqlite.close();}
    }
  });

  it('holds clearing when a publication consumes the wall allowance, then resumes',async()=>{
    const rig=sqliteEnv();
    try{
      const original=await oldEvent(rig);
      let clock=0;
      const env={...rig.serverEnv,blobs:{...rig.bucket,put:async(...args:Parameters<typeof rig.bucket.put>)=>{
        const result=await rig.bucket.put(...args);clock=10000;return result;
      }}};
      expect(await storageCleanup(env,now,{clock:()=>clock,wallMs:2000})).toEqual({changed:0,more:true});
      expect(rig.sqlite.query('SELECT payload,payload_format FROM events').get()).toEqual({payload:original,payload_format:'inline'});
      await drain(rig);
      expect(await eventContent(rig.serverEnv,'proj_1',uuid(101))).toBe(original);
    }finally{rig.sqlite.close();}
  });

  it('shares remaining invocation admission and refuses disabled statement and blob reserves',async()=>{
    const rig=sqliteEnv();
    try{
      await oldEvent(rig);
      const outer=measuredContentEnv(rig.serverEnv,{statements:120,blobCalls:60,wallMs:2000});
      for(let i=0;i<80;i++)await outer.env.db.prepare('SELECT 1').first();
      expect(remainingContentBudget(outer.env.db).statements).toBe(40);
      expect(await storageCleanup(outer.env,now)).toEqual({changed:0,more:true});
      expect(outer.usage.statements).toBeLessThanOrEqual(82);
      expect(rig.sqlite.query('SELECT payload_format FROM events').get()).toEqual({payload_format:'inline'});
      for(const limits of [{statements:41},{blobCalls:7}]){
        expect(await storageCleanup(rig.serverEnv,now,limits)).toEqual({changed:0,more:true});
        expect(rig.sqlite.query('SELECT payload_format FROM events').get()).toEqual({payload_format:'inline'});
      }
    }finally{rig.sqlite.close();}
  });

});
