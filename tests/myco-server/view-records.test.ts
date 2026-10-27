import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { getPlan, planInSession, setPlanStatus } from '@myco-server-worker/read/plans.js';
import { changePlanStatus } from '@myco-server-worker/core/plans.js';
import { getSession, sessionCounts } from '@myco-server-worker/read/sessions.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { withViewReadResponse } from '@myco-server-worker/read/view-store.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { blobPost, memberHeaders, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';
import { captureViewSession, withViewStores, withViewStorePair } from './helpers/view-stores.js';
import { mirrorViewSession, publishMirroredSession, setViewFieldBody } from './helpers/view-instances.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { withFrozenCIOracle, frozenReadPort, legacyPublicServer, type FrozenOracle } from '../helpers/view-read-legacy-fixtures.js';
import { emptyReadSql, emptyReadRows, activeCatalogueRows, appendCostHistory, COST_MATERIALS, explainReadPlan, proofPointPlanViolations } from './helpers/view-read-costs.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import legacy from './fixtures/view-read-legacy.json';

const scope = { projectId: 'project' };
const kinds = [ ['prompt', 20], ['response', 30], ['plan', 50], ['tool-input', 40], ['tool-output', 40] ] as const;

/** The sealed program supplies the baseline writer and its SQL. */
const frozenStatusStore = (db: RelationalStore,oracle?:FrozenOracle): RelationalStore => ({
  prepare:sql=>sql.startsWith('UPDATE plans ')||oracle===undefined?db.prepare(sql):oracle.replayStore(db).prepare(oracle.intern(sql)),
  batch:statements=>db.batch(statements),
});

it('record and session lookups retain their saved bytes after the frozen originals are gone', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    const blobs = memoryBlobStore();
    const read = async () => JSON.stringify([
      await getPlan(db, scope, uuid(50)), await getPlan(db, scope, uuid(50), { summary: true }),
      await planInSession(db, scope, 'session', uuid(50)), await getSession(db, scope, 'session'), await sessionCounts(db, scope, 'session'),
      ...await Promise.all(kinds.map(([kind, id]) => processedBody({ db, blobs }, scope, kind, uuid(id)))),
    ]);
    const expected = await read();
    await mirrorViewSession(db, { ...scope, sessionId: 'session', instanceId: 'parent', state: 'frozen' });
    await mirrorViewSession(db, { ...scope, sessionId: 'session', instanceId: 'tail', state: 'live', parent: 'parent' }, false);
    await publishMirroredSession(db, scope.projectId, 'session', 'tail', 'parent');
    expect(await read(), target + ' published').toBe(expected);
    await db.batch(['prompt_batches', 'responses', 'tool_calls', 'plans'].map(table => db.prepare(`DELETE FROM ${table} WHERE project_id='project'`)));
    expect(await read(), target + ' gone').toBe(expected);
    expect(await getPlan(db, { projectId: 'other' }, uuid(50)), target + ' foreign').toBeNull();
    expect(await getPlan(db, scope, 'missing'), target + ' missing').toBeNull();
  });
}, 60_000);

it('canonical status changes refuse view-only plans and leave every fact and instance byte unchanged', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    await mirrorViewSession(db, { ...scope, sessionId: 'session', instanceId: 'live', state: 'live' });
    await publishMirroredSession(db, scope.projectId, 'session', 'live');
    const recorded = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
    const snapshot = async () => JSON.stringify(await Promise.all([
      db.prepare('SELECT * FROM plans WHERE project_id=?').bind(scope.projectId).all(),
      db.prepare('SELECT * FROM view_plans WHERE project_id=?').bind(scope.projectId).all(),
      db.prepare('SELECT * FROM embedding_versions WHERE project_id=?').bind(scope.projectId).all(),
    ]).then(results => results.map(result => result.results)));
    for (const gone of [false, true]) {
      if (gone) await db.prepare('DELETE FROM plans WHERE project_id=?').bind(scope.projectId).run();
      const before = await snapshot();
      recorded.reset();
      await expect(changePlanStatus(recorded.db, scope, uuid(50), 'completed', 'member', 2)).rejects.toMatchObject({ code: 'view_plan_requires_promotion' });
      await recorded.drain();
      expect(await snapshot(), target + ' gone=' + gone).toBe(before);
      expect(recorded.statements.filter(row => /UPDATE plans/.test(row.sql)).every(row => (row.changes ?? 0) === 0)).toBe(true);
    }
  });
}, 60_000);

it('canonical status changes preserve unknown, same-status and fact outcomes and the frozen empty-world statement sequence', async () => {
  await withFrozenCIOracle(async oracle => {
    const port = frozenReadPort(oracle);
    for (const target of ['native', 'D1'] as const) for (const [key, status] of [[uuid(50), 'active'], [uuid(50), 'completed'], ['missing', 'completed']] as const) {
      await withViewStorePair(target, db => captureViewSession(db), async (baseline, candidate) => {
        const before = statementRecorder(baseline, { accounting: target === 'D1' ? 'd1' : 'native', captureRows: true });
        const after = statementRecorder(candidate, { accounting: target === 'D1' ? 'd1' : 'native', captureRows: true });
        await port('plans', 'setPlanStatus', [frozenStatusStore(before.db), scope, key, status, 'member', 2]);
        const expected = await port('plans', 'getPlan', [oracle.replayStore(before.db), scope, key]);
        expect<unknown>(await changePlanStatus(after.db, scope, key, status, 'member', 2), target + ' ' + key + '/' + status).toEqual(expected);
        await before.drain(); await after.drain();
        const work = (recorder: typeof before) => recorder.statements.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,changes}) =>
          ({sql:emptyReadSql(sql),binds,method,rows:emptyReadRows(rows),rowCount,rowsRead,rowsWritten,changes}));
        expect(work(after), target + ' statement results and work').toEqual(work(before));
        expect(after.statements.length).toBe(key === 'missing' ? 2 : 3);
      });
    }
  });
}, 60_000);

it('fact-only status primitive retains the frozen result and complete empty-world statement work', async () => {
  await withFrozenCIOracle(async oracle => {
    const port = frozenReadPort(oracle);
    for (const target of ['native', 'D1'] as const) for (const [key, status] of [[uuid(50), 'active'], [uuid(50), 'completed'], ['missing', 'completed']] as const) {
      await withViewStorePair(target, db => captureViewSession(db), async (baseline, candidate) => {
        const before = statementRecorder(baseline, { accounting: target === 'D1' ? 'd1' : 'native', captureRows: true });
        const after = statementRecorder(candidate, { accounting: target === 'D1' ? 'd1' : 'native', captureRows: true });
        const expected = await port('plans', 'setPlanStatus', [frozenStatusStore(before.db), scope, key, status, 'member', 2]);
        expect<unknown>(await setPlanStatus(after.db, scope, key, status, 'member', 2), target + ' primitive result').toEqual(expected);
        await before.drain(); await after.drain();
        const work = (recorder: typeof before) => recorder.statements.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,changes}) =>
          ({sql:emptyReadSql(sql),binds,method,rows:emptyReadRows(rows),rowCount,rowsRead,rowsWritten,changes}));
        expect(work(after), target + ' primitive statement work').toEqual(work(before));
        expect(after.statements.length).toBe(1);
      });
    }
  });
}, 60_000);

it('cold status-only MCP preserves its frozen empty-world statements and refuses published plans by name', async () => {
  const request = (token:string,key:string,status:string) => new Request('https://s/mcp', {
    method:'POST',headers:memberHeaders(token,{[PROJECT_HEADER]:'project','content-type':'application/json',accept:'application/json, text/event-stream'}),
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'myco_plans',arguments:{project:'project',op:'save',id:key,session_id:'session',status}}}),
  });
  await withFrozenCIOracle(async oracle => {
    for (const target of ['native', 'D1'] as const) for (const [key,status] of [[uuid(50),'active'],[uuid(50),'completed'],['missing','completed']] as const) {
      let token='';
      await withViewStorePair(target,async db=>{token=(await captureViewSession(db)).token;},async(baseline,candidate)=>{
        await baseline.prepare("UPDATE schema_meta SET value=? WHERE key='version'").bind(String(legacy.schema.steps.at(-1)!.version)).run();
        const before=statementRecorder(baseline,{accounting:target==='D1'?'d1':'native',captureRows:true});
        const after=statementRecorder(candidate,{accounting:target==='D1'?'d1':'native',captureRows:true});
        const expected=await legacyPublicServer(frozenStatusStore(before.db,oracle),oracle)(request(token,key,status));
        const actual=await legacyPublicServer(after.db)(request(token,key,status));
        expect(await actual.text(),target+' MCP body').toBe(await expected.text());
        expect(actual.status,target+' MCP HTTP status').toBe(expected.status);
        await before.drain();await after.drain();
        const work=(recorder:typeof before,version:number)=>recorder.statements.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,changes})=>
          ({sql:emptyReadSql(sql),binds,method,rows:activeCatalogueRows(emptyReadRows(rows),version),rowCount,rowsRead,rowsWritten,changes}));
        expect(work(after,SCHEMA_STEPS.at(-1)!.version),target+' cold MCP statement work').toEqual(work(before,legacy.schema.steps.at(-1)!.version));
      });
    }
  });
  await withViewStores(async(db,target)=>{
    const {token}=await captureViewSession(db);
    await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
    await publishMirroredSession(db,scope.projectId,'session','live');
    const before=await getPlan(db,scope,uuid(50));
    const response=await legacyPublicServer(db)(request(token,uuid(50),'completed'));
    expect(await response.text(),target+' promotion refusal').toContain('view_plan_requires_promotion');
    expect(await getPlan(db,scope,uuid(50)),target+' unchanged selected plan').toEqual(before);
  });
},60_000);

it('a view body requires its selected instance proof even when the hidden original has an admitted proof for the same blob', async () => {
  await withViewStores(async (db, target) => {
    const blobs = memoryBlobStore();
    const issued = await captureViewSession(db, scope.projectId, 'session', { blobs });
    const body = 'Complete body from exact stored instance';
    const bytes = new TextEncoder().encode(body);
    const key = await sha256Hex(body);
    const env = { MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
    expect((await worker.fetch(blobPost(issued.token, key, bytes, 'text/plain', { [PROJECT_HEADER]: scope.projectId }), env)).status, target + ' admitted upload').toBe(200);
    await db.prepare('UPDATE prompt_batches SET text=NULL,blob_key=? WHERE project_id=? AND prompt_id=?').bind(key, scope.projectId, uuid(20)).run();
    expect(await processedBody({ db, blobs }, scope, 'prompt', uuid(20)), target + ' fact proof control').toBe(body);
    await mirrorViewSession(db, { ...scope, sessionId: 'session', instanceId: 'parent', state: 'frozen' });
    await mirrorViewSession(db, { ...scope, sessionId: 'session', instanceId: 'tail', state: 'live', parent: 'parent' }, false);
    await publishMirroredSession(db, scope.projectId, 'session', 'tail', 'parent');
    for (const [kind, id] of kinds) {
      const value = { ...scope, sessionId: 'session', instanceId: 'parent', kind, recordId: uuid(id), key, size: bytes.length };
      await setViewFieldBody(db, { ...value, proved: false });
      expect(await processedBody({ db, blobs }, scope, kind, uuid(id)), target + ' ' + kind + ' missing proof').toBeNull();
      await setViewFieldBody(db, { ...value, proved: true });
      expect(await processedBody({ db, blobs }, scope, kind, uuid(id)), target + ' ' + kind + ' parent proof').toBe(body);
    }
  });
}, 60_000);


it('record proofs keep exact-key native and D1 work as unrelated proof history grows',async()=>{
 const planErrors:string[]=[];
 const frozenByTarget=new Map<string,Map<string,{rows:number[];sql:unknown}>>();
 const body='Complete body from exact stored instance',raw=new TextEncoder().encode(body),key=await sha256Hex(body);
 for(const history of [400,1200,5000]){
 const blobs=memoryBlobStore();
 await withViewStorePair('native-D1',async db=>{
  const issued=await captureViewSession(db,scope.projectId,'session',{blobs});
  const noise=await captureViewSession(db,scope.projectId,'proof-noise',{blobs,idOffset:8000000});
  const noiseBody='hidden history',noiseBytes=new TextEncoder().encode(noiseBody),noiseKey=await sha256Hex(noiseBody);
  const env={MYCO_DB:db,BUCKET:blobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()};
  expect((await worker.fetch(blobPost(issued.token,key,raw,'text/plain',{[PROJECT_HEADER]:scope.projectId}),env)).status).toBe(200);
  expect((await worker.fetch(blobPost(noise.token,noiseKey,noiseBytes,'text/plain',{[PROJECT_HEADER]:scope.projectId}),env)).status).toBe(200);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'tail',state:'live',parent:'parent'},false);
  await publishMirroredSession(db,scope.projectId,'session','tail','parent');
  for(const [kind,id]of kinds)await setViewFieldBody(db,{...scope,sessionId:'session',instanceId:'parent',kind,recordId:uuid(id),key,size:raw.length,proved:true});
  await appendCostHistory(db,{...scope,sessionId:'proof-noise',tokenId:noise.tokenId,material:COST_MATERIALS[0],from:0,through:history,blobKey:noiseKey});
 },async(native,d1)=>{
  for(const [db,target]of [[native,'native'],[d1,'D1']]as const){
   const frozen=frozenByTarget.get(target)??new Map<string,{rows:number[];sql:unknown}>();
   frozenByTarget.set(target,frozen);
   for(const [kind,id]of [...kinds,['full-plan',50] as const]){
    const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
    if(kind==='full-plan'){
     const plan=await getPlan(observed.db,scope,uuid(id));expect(plan?.blobKey).toBe(key);expect(plan?.objectKey).toBeString();
    }else expect(await processedBody({db:observed.db,blobs},scope,kind,uuid(id))).toBe(body);
    await observed.drain();
    const shape=observed.statements.map(query=>({sql:query.sql,binds:query.binds,method:query.method}));
    const rows=observed.statements.map(query=>{
     if(target==='D1'&&query.rowsRead===undefined)throw new Error('Proof read has no D1 row accounting');return query.rowsRead??0;
    });
    if(history===400)frozen.set(kind,{rows,sql:shape});
    const bound=frozen.get(kind)!;expect<unknown>(shape).toEqual(bound.sql);
    if(target==='D1')for(const [index,read]of rows.entries())expect(read,kind+'/'+history+'/'+index+' frozen proof-history bound').toBeLessThanOrEqual(bound.rows[index]!);
    let seeks=0;
    for(const query of observed.statements){
     const plan=proofPointPlanViolations(await explainReadPlan(db,query));seeks+=plan.seeks;
     planErrors.push(...plan.errors.map(error=>target+'/'+kind+'/'+history+': '+error));
    }
    if(seeks===0)planErrors.push(target+'/'+kind+'/'+history+': missing proof seeks');
    console.info('VIEW_PROOF_HISTORY',JSON.stringify({target,kind,history,reads:target==='D1'?rows:null,bound:target==='D1'?bound.rows:null,seeks}));
   }
  }
 },'native');
 }
 expect(planErrors).toEqual([]);
},180_000);
