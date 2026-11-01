import { expect,it } from 'bun:test';
import type { PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';







import worker from '@myco-server-worker/entry/cloudflare.js';
import { sqliteEnv,uuid } from './helpers/fixtures.js';
import { OWNER_ENV,ownerCookie,seedMemberRoleAccount,MEMBER_SUB,asOwner,asOwnerPatch } from './helpers/owner.js';

type Rig=ReturnType<typeof sqliteEnv>;
const now=Date.now();
it('bounds admin status by examined omission identities even when every source is gone',async()=>{
  const rig=sqliteEnv();
  try{
    const readSizes:number[]=[];
    const observe=(statement:PreparedStatement):PreparedStatement=>({
      ...statement,bind:(...values)=>observe(statement.bind(...values)),
      async all<T>(){const result=await statement.all<T>();readSizes.push(result.results.length);return result;},
    });
    rig.env.MYCO_DB={...rig.db,prepare:(sql:string)=>{
      const statement=rig.db.prepare(sql);
      return sql.includes('WITH page AS MATERIALIZED')?observe(statement):statement;
    },async batch(statements:PreparedStatement[]){
      const results=await rig.db.batch(statements);
      statements.forEach((statement,index)=>{
        if('sql' in statement&&typeof statement.sql==='string'&&statement.sql.includes('WITH page AS MATERIALIZED'))
          readSizes.push(results[index]!.results.length);
      });
      return results;
    }};
    for(let n=0;n<250;n++)rig.sqlite.query(`INSERT INTO storage_cleanup_omissions
      VALUES('proj_1','event',?,'retained-inline:net-gain',0)`).run(uuid(75000+n));
    let after:unknown=null,total=0;
    do{
      const path='/api/storage-cleanup'+(after?'?retainedAfter='+encodeURIComponent(JSON.stringify(after)):'');
      const response=await worker.fetch(await asOwner(rig.db, path),{...rig.env,...OWNER_ENV});
      expect(response.status).toBe(200);
      const body=await response.json() as {retainedInline:unknown[];retainedInlinePage:{examined:number;next:unknown}};
      expect(body.retainedInline).toEqual([]);expect(body.retainedInlinePage.examined).toBeLessThanOrEqual(100);
      total+=body.retainedInlinePage.examined;after=body.retainedInlinePage.next;
    }while(after);
    expect(total).toBe(250);
    expect(readSizes).toEqual([101,101,50]);
    expect((await worker.fetch(await asOwner(rig.db, '/api/storage-cleanup?retainedAfter=bad'),{...rig.env,...OWNER_ENV})).status).toBe(400);
  }finally{rig.sqlite.close();}
});

it('declares admin control, refuses other actors, validates the body and rechecks authority at write execution',async()=>{
  const rig=sqliteEnv();
  try{
    seedMemberRoleAccount(rig.sqlite);
    const env={...rig.env,...OWNER_ENV};
    const before=rig.sqlite.query('SELECT * FROM storage_cleanup_state').get();
    for(const method of ['GET','PATCH']){
      const response=await worker.fetch(new Request('https://s/api/storage-cleanup',{method,
        headers:{cookie:await ownerCookie(rig.db, now,MEMBER_SUB),origin:'https://s','cf-connecting-ip':'1.2.3.4'},
        ...(method==='PATCH'?{body:'{"paused":true}'}:{})}),env);
      expect(response.status).toBe(403);
    }
    const unauth=await worker.fetch(new Request('https://s/api/storage-cleanup',{headers:{'cf-connecting-ip':'1.2.3.4'}}),env);
    expect(unauth.status).toBe(401);
    for(const body of [{paused:'yes'},{paused:true,phase:0},{}])expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',body),env)).status).toBe(400);
    expect(rig.sqlite.query('SELECT * FROM storage_cleanup_state').get()).toEqual(before);
    expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',{paused:true}),env)).status).toBe(200);
    expect(await storageCleanupPending(rig.db)).toBe(false);
    expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',{paused:false}),env)).status).toBe(200);
    let intercepted=false;
    const raced=sqliteEnv({onSql(sql,sqlite){if(sql.startsWith('UPDATE storage_cleanup_state SET paused=')&&!intercepted){
      intercepted=true;sqlite.exec("UPDATE members SET role='member' WHERE id='mem_machine_1'");
    }}});
    try{
      expect((await worker.fetch(await asOwnerPatch(raced.db, '/api/storage-cleanup',{paused:true}),{...raced.env,...OWNER_ENV})).status).toBe(403);
      expect(raced.sqlite.query('SELECT paused FROM storage_cleanup_state').get()).toEqual({paused:0});
    }finally{raced.sqlite.close();}
  }finally{rig.sqlite.close();}
});
