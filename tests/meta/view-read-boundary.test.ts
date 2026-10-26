import {LEGACY_ONLY_OPERATIONS} from '@myco-server-worker/read/view-store.js';
import {preparationOrigins,preparationOriginEnvelope,preparationSourcePins,preparationSourceInventory} from '../helpers/view-read-policy.js';
import { createHash } from 'node:crypto';
import legacy from '../myco-server/fixtures/view-read-legacy.json';
import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import {withViewStores} from '../myco-server/helpers/view-stores.js';
import type {StatementException,ExceptionClosure,ParameterCaller} from '../helpers/view-read-contract.js';
import {statementRecorder,preparationOwner,isSqlPreparation,preparationSourcePaths,instrumentReadPreparations,checkedPreparationOrigins,checkedPreparationSource,readPreparationViolations,withReadPreparation,withPreparedRead,withPreparedBatch,preparedMethodReceiver,withPhysicalPreparation,protectedRelations,OPEN_RELATION_PREPARATIONS} from '../helpers/statement-recorder.js';
import {Database} from 'bun:sqlite';
import {sqliteRelationalStore} from '@myco-server-worker/platform/bun/sqlite.js';
import ts from 'typescript-v6';
import {nativeReadObservations,instrumentReadSource} from '../setup/view-read-preload.js';
import {planTotals} from '@myco-server-worker/read/plans.js';
import {listTurns} from '@myco-server-worker/read/turns.js';
import {projectExists} from '@myco-server-worker/read/sessions.js';
import {seededSqlite,sqliteD1} from '../myco-server/helpers/d1.js';

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { VIEW_READ_OPERATIONS } from '../helpers/view-read-operations.js';
import { sourceBoundary, runtimeBoundary, viewSchemaViolations, armPlanViolations, significantRead, protectedSql,durableObservationViolations } from '../helpers/view-read-contract.js';

const owner = 'packages/myco-server/src/read/view-store.ts';
const reader = 'packages/myco-server/src/read/probe.ts';
const operation = 'M24:plans_planTotals:0';
const tagged = '/*vs:' + operation + '*/SELECT prompt_id FROM prompt_batches WHERE project_id=?';
test('preparation loading and origin identity agree for Windows native and mixed paths',()=>{
 const source=readFileSync(owner,'utf8');
 for(const root of ['D:\\a\\myco\\myco','D:/a/myco/myco']){
  const paths=preparationSourcePaths(root);
  for(const file of ['D:\\a\\myco\\myco\\packages\\myco-server\\src\\read\\view-store.ts','D:/a/myco/myco/packages/myco-server/src/read/view-store.ts','d:/a/myco/myco/packages\\myco-server/src/read/view-store.ts']){
   expect(paths.filter.test(file)).toBe(true);
   expect(paths.relative(file)).toBe(owner);
   expect(instrumentReadPreparations(ts,source,paths.relative(file),[],'recorder')).toContain('__viewPreparedRead({...{"kind":"module"},capture}');
  }
  const file='D:\\a\\myco\\myco\\tests\\fixture.ts';
  const origin={kind:'exception' as const,id:'fixture',file:'tests/fixture.ts',owner:'rows',expression:"'SELECT * FROM plans'",phase:'T' as const};
  expect(paths.filter.test(file)).toBe(true);
  expect(instrumentReadPreparations(ts,"function rows(db){return db.prepare('SELECT * FROM plans')}",paths.relative(file),[origin],'recorder')).toContain('"id":"fixture"');
  expect(paths.filter.test('D:/a/myco/myco-other/tests/fixture.ts')).toBe(false);
 }
});
test('preparation instrumentation preserves awaited RegExp execution in schema contracts',()=>{
 const file='tests/myco-server/view-store-schema.test.ts';
 const instrumented=instrumentReadSource(readFileSync(file,'utf8'),file);
 expect(()=>new Bun.Transpiler({loader:'ts'}).transformSync(instrumented)).not.toThrow();
 expect(instrumented).toContain('/\\bWHERE\\s+(.+)$/i.exec(await sql(name))');
 expect(instrumented).toContain('__viewPreparedRead(');
});
test('every declared Durable Object has one classified observation owner',()=>{
 const source=readFileSync('packages/myco-server/wrangler.toml','utf8');
 const classes=[...source.matchAll(/^class_name\s*=\s*"([^"]+)"/gm)].map(match=>match[1]!);
 expect(durableObservationViolations(classes)).toEqual([]);
 expect(durableObservationViolations([...classes,'UnknownObject'])).toContain('unclassified Durable Object UnknownObject');
 for(const name of classes)expect(durableObservationViolations(classes.filter(value=>value!==name))).toContain('requires one observed '+name);
});

describe('view read source boundary controls', () => {
  test('rejects literal and concatenated dynamic SQL outside the owner', () => {
    for (const body of [
      "db.prepare('SELECT * FROM prompt_batches')",
      "const table='prompt_'+'batches'; db.prepare('SELECT * FROM '+table)",
      "const make=()=>({sql:'SELECT * FROM plans',type:'plan'}); db.prepare(make().sql)",
      "db.prepare('SELECT * FROM sessions s, prompt_batches pb')",
      "db.prepare('SELECT * FROM json_each(?) w, responses r')",
      "db.prepare('SELECT * FROM (sessions s, tool_calls t)')",
    ]) expect(sourceBoundary(new Map([[reader, body]]))).toContain(reader + '#<module>: protected SQL preparation outside owner');
    for(const method of ['query','exec'])expect(sourceBoundary(new Map([[reader,'db.'+method+'('+JSON.stringify('/*a*/ --b\n SELECT * FROM main.plans')+')']]))).toContain(reader+'#<module>: protected SQL preparation outside owner');
  });

  test('source census has one order across source-map permutations and path separators',()=>{
    const sink='packages/myco-server/src/sink.ts',other='packages/myco-server/src/other.ts',caller='packages/myco-server/src/caller.ts';
    const entries:[string,string][]=[[sink,"export function rows(db,value){return db.prepare(value.sql)}"],[other,"export function otherRows(db,sql){return db.prepare(sql)}"],[caller,"import {rows} from './sink.js';import {otherRows} from './other.js';export function call(db){rows(db,{sql:'SELECT * FROM plans'});return otherRows(db,'SELECT * FROM responses')}"]];
    const census=(entries:readonly [string,string][])=>{
      const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
      const errors=sourceBoundary(new Map(entries),[{id:'census',file:sink,owner:'rows',expression:'value.sql',phase:'P'},{id:'other',file:other,owner:'otherRows',expression:'sql',phase:'P'}],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row)});
      return {errors,closures,callers};
    };
    const expected=census(entries);
    expect(expected.closures.length).toBeGreaterThan(0);
    expect(expected.callers.length).toBeGreaterThan(0);
    expect(census([...entries].reverse())).toEqual(expected);
    expect(census(entries.map(([file,text])=>[file.replaceAll('/','\\'),text]))).toEqual(expected);
  });

  test('tracks SQL descriptors through aliases, re-exports and type-only property consumers', () => {
    const sources = new Map([
      [owner, "export const source={sql:'SELECT * FROM responses',type:'response'};"],
      ['packages/myco-server/src/read/relay.ts', "export {source as other} from './view-store.js';"],
      [reader, "import {other as alias} from './relay.js'; const kind=alias.type;"],
    ]);
    expect(sourceBoundary(sources)).toContain(reader + ': SQL-bearing import other');
    expect(sourceBoundary(new Map([[owner,"export const source={sql:'SELECT * FROM responses',type:'response'};"],[reader,"export * from './view-store.js';"]]))).toContain(reader+': SQL-bearing star re-export');
    expect(sourceBoundary(new Map([[owner, "export async function rows(db){return db.prepare('SELECT * FROM responses').all()}"], [reader, "import {rows} from './view-store.js'; rows(db)"]]))).toEqual([]);
  });

  test('rejects forged known tags outside the sole preparation module', () => {
    expect(sourceBoundary(new Map([[reader, "db.prepare(" + JSON.stringify(tagged) + ')']]))).toContain(reader + ': outside tag construction');
  });

  test('admits only exact maintenance statement tuples', () => {
    const expression = "'SELECT * FROM plans'";
    const text = 'function restore(db){return db.prepare(' + expression + ')}';
    const tuple = {id:'restore-1',file:reader,owner:'restore',expression,phase:'P' as const};
    expect(sourceBoundary(new Map([[reader,text]]),[tuple])).toEqual([]);
    expect(sourceBoundary(new Map([[reader,text.replace('restore','read')]]),[tuple])).not.toEqual([]);
  });

  test('pins declarations interpolated into admitted exception sites',()=>{
    const file='packages/myco-server/src/core/learning-hold.ts',text=readFileSync(file,'utf8');
    const exceptions=legacy.sourceExceptions.map(item=>({...item,phase:exceptionPhase(item.phase)}));
    const tuple=exceptions.find(item=>item.id==='maintenance-learning-hold')!;
    const sources=new Map([...new Set([file,...tuple.dependencies.map(item=>item.file)])].map(file=>[file,readFileSync(file,'utf8')]));
    expect(sourceBoundary(sources,exceptions,legacy.foundationImports).filter(error=>error.startsWith(file+'#learningHolds:'))).toEqual([]);
    const mutant=text.replace('AND NOT EXISTS (SELECT 1 FROM session_tombstones','AND (SELECT COUNT(*) FROM prompt_batches WHERE project_id = ${project} AND session_id = ${session}) >= 0\n    AND NOT EXISTS (SELECT 1 FROM session_tombstones');
    expect(mutant).not.toBe(text);
    expect(sourceBoundary(new Map(sources).set(file,mutant),exceptions,legacy.foundationImports)).toContain(file+'#learningHolds: SQL exception dependencies differ');
    const dependency='packages/myco-server/src/core/settings.ts',original=sources.get(dependency)!;
    const importedMutant=original.replace('export function learningEnabledSql(): string {','export function learningEnabledSql(): string {\n return `(SELECT COUNT(*) FROM prompt_batches) >= 0`;');
    expect(importedMutant).not.toBe(original);
    expect(sourceBoundary(new Map(sources).set(dependency,importedMutant),exceptions,legacy.foundationImports)).toContain(file+'#learningHolds: SQL exception dependencies differ');
  });

  test('parses each file once and shares declaration analysis across importers and cycles',()=>{
    const foundation='packages/myco-server/src/foundation.ts',relay='packages/myco-server/src/relay.ts';
    const base=new Map([[foundation,"export const left=()=>right();export const right=()=>({next:left,sql:'SELECT * FROM plans'});"],[relay,"export {left,right} from './foundation.js';export * from './relay.js';"]]);
    const scan=(count:number)=>{
      const sources=new Map(base);
      for(let index=0;index<count;index++)sources.set('packages/myco-server/src/importer'+index+'.ts',"import {left,right} from './relay.js';");
      const metrics={parses:0,importEdges:0,taintNodes:0};
      const errors=sourceBoundary(sources,[],[],{importsOnly:true,metrics});
      expect(metrics.parses).toBe(sources.size);
      expect(metrics.importEdges).toBe(count*2);
      expect(errors.filter(error=>error.includes('SQL-bearing import'))).toHaveLength(count*2);
      return metrics;
    };
    expect(scan(128).taintNodes).toBe(scan(1).taintNodes);
  });
});

describe('view read runtime boundary controls', () => {
  const row = {sql:tagged,operation:'turn-page',phase:'logical',statementId:'first',origin:{kind:'module' as const}};
  test('requires one closed module tag on every protected statement', () => {
    expect(runtimeBoundary([row])).toEqual([]);
    expect(significantRead(tagged)).toBe('SELECT prompt_id FROM prompt_batches WHERE project_id=?');
    expect(runtimeBoundary([{...row,sql:'SELECT * FROM '+'tool_calls'}])).not.toEqual([]);
    expect(runtimeBoundary([{...row,sql:'/*vs:M99:unknown:0*/SELECT * FROM plans'}])).not.toEqual([]);
    expect(() => significantRead('/*vs:' + operation + '*/' + tagged)).toThrow('multiple');
  });

  test('a removed legacy member exercises the nonmember missing-capture branch', () => {
    expect(runtimeBoundary([row],{legacy:new Set()})).toEqual(['nonmember missing source capture: ' + operation]);
    expect(runtimeBoundary([{...row,captured:true}],{legacy:new Set()})).toEqual([]);
  });

  test('maintenance admission requires id, operation, phase, statement identity and SQL together', () => {
    const sql='DELETE FROM plans WHERE project_id=?';
    const exception={id:'delete-plans',operation:'forget-session',phase:'P',statementId:'plans',sql};
    const row={...exception,exceptionId:exception.id};
    expect(runtimeBoundary([row],{exceptions:[exception]})).toEqual([]);
    for(const field of ['operation','phase','statementId','sql','exceptionId'] as const) {
      expect(runtimeBoundary([{...row,[field]:row[field]+'-other'}],{exceptions:[exception]})).not.toEqual([]);
    }
  });

  test('an admitted exception origin cannot add a protected relation through an SQL fragment',async()=>{
    const origins=preparationOrigins,origin=origins.find(row=>row.id==='maintenance-learning-hold')!;
    expect(origin.relations).toEqual(['session_views']);
    const statement={sql:'SELECT 1 FROM session_views',operation:'probe',phase:origin.phase,statementId:'hold',exceptionId:origin.id,origin};
    const options={known:new Set<string>(),legacy:new Set<string>(),origins};
    expect(readPreparationViolations([statement],options)).toEqual([]);
    const sql=statement.sql+' WHERE (SELECT COUNT(*) FROM prompt_batches) >= 0';
    expect(readPreparationViolations([{...statement,sql}],options)).toEqual(['exception adds protected relations: maintenance-learning-hold: prompt_batches']);
    expect(readPreparationViolations([{...statement,sql,origin:{...origin,relations:['session_views','prompt_batches']}}],options)).not.toEqual([]);
    const other={...origin,owner:'another-maintenance-reader',relations:['session_views','prompt_batches']};
    expect(readPreparationViolations([{...statement,sql}],{...options,origins:[other,origin]})).toEqual(['exception adds protected relations: maintenance-learning-hold: prompt_batches']);
  });
});

test('deferred statement forwarding preserves sealed provenance only for exact SQL bytes',async()=>{
 const physical={kind:'exception' as const,id:'transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 let forwarded=tagged;
 const make=()=>({
  bind(..._args:unknown[]){withPhysicalPreparation(physical,forwarded,'query',()=>({get(){return {n:1}}})).get();return this},
  async first(){await Promise.resolve();return withPhysicalPreparation(physical,forwarded,'query',()=>({get(){return {n:1}}})).get()},
 });
 const statement=withPreparedRead({kind:'module'},tagged,make).bind('project');
 await Promise.resolve();
 expect(await statement.first()).toEqual({n:1});
 forwarded=tagged+' ';
 await expect(statement.first()).rejects.toThrow('forged module operation');
 forwarded=tagged.replace('prompt_batches','tool_calls');
 await expect(statement.first()).rejects.toThrow('forged module operation');
 expect(()=>withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}}))).toThrow('forged module operation');
});

test('sqliteD1 forwards the module project-existence query through its inner recorder',async()=>{
 const sqlite=seededSqlite();
 try{
  const db=sqliteD1(sqlite);
  expect(await projectExists(db,'proj_1')).toBe(true);
  expect(await projectExists(db,'absent-project')).toBe(false);
 }finally{sqlite.close()}
});

test('synchronous adapter forwarding requires the preparation SQL bytes',()=>{
 const observed=statementRecorder({prepare:()=>({bind(){return this},async first(){return null},async all(){return {results:[]}},async run(){return {results:[],meta:{changes:0}}}}),async batch(){return []}},{accounting:'native'});
 expect(()=>withPreparedRead({kind:'module'},tagged,()=>observed.db.prepare(tagged))).not.toThrow();
 for(const sql of [tagged+' ',tagged.replace('prompt_batches','tool_calls')]){
  expect(()=>withPreparedRead({kind:'module'},tagged,()=>observed.db.prepare(sql))).toThrow('forged module operation');
 }
});

test('nested adapter batches retain each adapter’s bound statement identity',async()=>{
 const physical={kind:'exception' as const,id:'opaque',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const innerHeld=new WeakSet<object>(),outerHeld=new WeakSet<object>();
 interface OpaqueStatement {bind(...args:unknown[]):OpaqueStatement}
 const make=():OpaqueStatement=>{
  const statement={bind(..._args:unknown[]){return make()}};innerHeld.add(statement);return statement;
 };
 const inner={
  prepare(_sql:string){return make()},
  async batch(statements:unknown){
   if(!Array.isArray(statements))throw new Error('expected statement array');
   return statements.map(statement=>{
    if(!innerHeld.has(statement))throw new Error('foreign inner statement');
    return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get();
   });
  },
 };
 const outer={
  prepare(sql:string){
   const statement=withPreparedRead({kind:'module'},sql,()=>inner.prepare(sql));
   return {bind(...values:unknown[]){const bound=statement.bind(...values);outerHeld.add(bound);return bound}};
  },
  async batch(statements:unknown){
   if(!Array.isArray(statements))throw new Error('expected statement array');
   for(const statement of statements)if(!outerHeld.has(statement))throw new Error('foreign outer statement');
   return inner.batch(statements);
  },
 };
 const statement=withPreparedRead({kind:'module'},tagged,()=>outer.prepare(tagged)).bind('project');
 expect(await outer.batch([statement])).toEqual([{n:1}]);
});

test('batch scopes exclude ambient provenance and untracked statements',()=>{
 const physical={kind:'exception' as const,id:'opaque',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const make=()=>({bind(){return this}});
 const owned=withPreparedRead({kind:'module'},tagged,make),foreign=withPreparedRead({kind:'module'},tagged+' ',make);
 const execute=()=>withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get();
 expect(()=>withPreparedBatch([[owned,make()]],execute)).toThrow('forged module operation');
 expect(()=>withPreparedRead({kind:'module'},tagged,()=>withPreparedBatch([[foreign]],execute))).toThrow('forged module operation');
 expect(()=>withPreparedRead({kind:'module'},tagged,()=>withPreparedBatch([[make()]],execute))).toThrow('forged module operation');
});

test('prepared handles retain identity through bind and batch aliases',async()=>{
 const held=new WeakSet<object>(),physical={kind:'exception' as const,id:'opaque',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 interface Statement {bind():Statement}
 const make=():Statement=>{const statement={bind(){return make()}};held.add(statement);return statement};
 const db={prepare(_sql:string){return make()},async batch(statements:object[]){
  return statements.map(statement=>{
   if(!held.has(statement))throw new Error('foreign aliased statement');
   return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get();
  });
 }};
 const original=db.prepare(tagged);
 const statement=withPreparedRead({kind:'module'},tagged,()=>original);
 expect(statement).toBe(original);
 const alias={...db},bound=statement.bind();
 expect(held.has(bound)).toBe(true);
 expect(await alias.batch([bound])).toEqual([{n:1}]);
});

test('adapter batches retain opaque statement ownership and refuse mixed provenance',async()=>{
 const held=new WeakSet<object>(),physical={kind:'exception' as const,id:'opaque',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const make=():object=>{const statement={bind(){return make()}};held.add(statement);return statement;};
 const db={prepare(_sql:string){return make()},async batch(statements:object[]){
  return statements.map(statement=>{
   if(!held.has(statement))throw new Error('foreign opaque statement');
   return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get();
  });
 }};
 const prepared=withPreparedRead({kind:'module'},tagged,()=>db.prepare(tagged));
 if(!('bind'in prepared)||typeof prepared.bind!=='function')throw new Error('missing fixture binder');
 const bound=prepared.bind();
 expect(await db.batch([bound])).toEqual([{n:1}]);
 await expect(db.batch([bound,make()])).rejects.toThrow('forged module operation');
});

test('native batches retain each sealed statement and refuse conflicting SQL provenance',async()=>{
 const native=new Database(':memory:'),physical={kind:'exception' as const,id:'batch-transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const transport=new Proxy(native,{get(target,key){
  const selected=Reflect.get(target,key,target);
  if(key==='query')return (sql:string)=>withPhysicalPreparation(physical,sql,'query',()=>target.query(sql));
  return typeof selected==='function'?selected.bind(target):selected;
 }}),observed=statementRecorder(sqliteRelationalStore(transport),{accounting:'native'});
 try{
  const first='/*vs:'+operation+'*/SELECT 1 AS n',second='/*vs:'+operation+'*/SELECT 2 AS n';
  const batch=[first,second].map(sql=>withPreparedRead({kind:'module'},sql,()=>observed.db.prepare(sql)).bind());
  await Promise.resolve();
  expect((await observed.db.batch(batch)).map(row=>row.results)).toEqual([[{n:1}],[{n:2}]]);
  const sql='SELECT 1 AS n';
  const conflicting=[physical,{...physical,id:'transport-b'}].map(origin=>withPreparedRead(origin,sql,()=>observed.db.prepare(sql)));
  await expect(observed.db.batch(conflicting)).rejects.toThrow('Conflicting prepared execution provenance');
 }finally{native.close()}
});

describe('view read plan comparator controls', () => {
  const baseline=[{id:10,parent:0,detail:'SEARCH p USING INDEX idx_prompt_batches_turns (project_id=? AND session_id=?)'}];
  const publication=[{id:20,parent:0,detail:'SEARCH session_views USING PRIMARY KEY (project_id=? AND session_id=?)'}];
  const view=[{id:30,parent:0,detail:'SEARCH view_prompts USING INDEX idx_view_prompts_session (project_id=? AND instance_id=?)'}];
  const input={baseline,legacy:[{...baseline[0]!,id:99}],publication,view};
  test('passes node-id renumbering only',()=>{expect(armPlanViolations(input)).toEqual([])});
  test('kills added legacy scans and sorts',()=>{
    for(const detail of ['SCAN prompt_batches','USE TEMP B-TREE FOR ORDER BY']) expect(armPlanViolations({...input,legacy:[...input.legacy,{id:100,parent:99,detail}]})).toContain('legacy arm differs from frozen plan');
  });
  test('kills a second publication search and an unindexed view arm',()=>{
    expect(armPlanViolations({...input,publication:[...publication,{...publication[0]!,id:21}]})).toContain('publication gate requires one exact indexed session_views search');
    expect(armPlanViolations({...input,view:[{id:31,parent:0,detail:'SCAN view_prompts'}]})).not.toEqual([]);
  });
});

describe('view read schema boundary controls', () => {
  test('rejects persistent instance views and materializing instance triggers',()=>{
    expect(viewSchemaViolations([{type:'view',name:'quiet',tbl_name:'quiet',sql:'CREATE VIEW quiet AS SELECT * FROM view_prompts'}])).not.toEqual([]);
    for(const table of ['session_read_facts','embedding_versions','search_blob_queue']) {
      expect(viewSchemaViolations([{type:'trigger',name:'view_prompts_ai',tbl_name:'view_prompts',sql:'CREATE TRIGGER view_prompts_ai AFTER INSERT ON view_prompts BEGIN INSERT INTO '+table+'(project_id) VALUES(new.project_id); END'}])).toContain('view_prompts_ai: forbidden view trigger dependency');
    }
    for(const sql of ['/*a*/ --b\n CREATE VIEW quiet AS SELECT * FROM/*x*/main.view_prompts','CREATE /*x*/ INDEX quiet ON main.sessions(session_id)','unknown','/* comment only */','/* unterminated'])expect(viewSchemaViolations([{type:'view',name:'quiet',tbl_name:'quiet',sql}])).toEqual(['quiet: unclassified persistent view']);
  });
});

const CAPTURED_OPERATIONS = [
  "M01:turns_listTurns:0",
  "M02:turns_promptInSession:0",
  "M03:turns_readTurnBodies:0",
  "M04:children_listChildren:0",
  "M04:children_listChildrenByPrompt:0",
  "M05:turns_steeringChildPage:0",
  "M06:turns_toolUsage:0",
  "M07:turns_sessionTurnContexts:0",
  "M08:hook_placement_sessionContextHints:0",
  "M08:hook_placement_listUnplacedHookRecords:0",
  "M09:plans_getPlan:0",
  "M10:plans_planInSession:0",
  "M11:sessions_sessionCounts:0",
  "M11:sessions_sessionCounts:1",
  "M12:sessions_getSession:0",
  "M13:sessions_selectSessions:ordinary",
  "M14:sessions_selectSessions:receipt",
  "M14:sessions_selectSessions:working",
  "M15:sessions_countStatements:0",
  "M16:sessions_instantStatements:0",
  "M18:lineage_sessionsNamed:0",
  "M18:lineage_childIdsOf:0",
  "M19:activity_activityFeed:0",
  "M20:session_activity_listSessionActivity:0",
  "M20:session_activity_toolRows:0",
  "M20:session_activity_edgeRows:0",
  "M21:hook_placement_countUnplacedContextRecords:0",
  "M23:children_materialRows:0",
  "M26:processed_processedField:0",
  "M26:processedBundle:0",
  "M45:injectedPromptRecord:0",
  "M47:receiptPlans:0"
] as const;
test('read membership is the exact protected-operation partition and retains the run-writer boundary',()=>{
 const text=readFileSync(owner,'utf8');
 expect(text).not.toMatch(/from\s+['"]\.\.\/core\/runs\.js/);
 const captured=new Set<string>(CAPTURED_OPERATIONS),remaining=new Set<string>(LEGACY_ONLY_OPERATIONS);
 const protectedIds=VIEW_READ_OPERATIONS.filter(operation=>operation.id.startsWith('M')).map(operation=>operation.id);
 expect(captured.size).toBe(32);
 expect(remaining.size).toBe(64);
 expect<string[]>([...protectedIds].filter(id=>!remaining.has(id)).sort()).toEqual([...captured].sort());
 for(const id of protectedIds){
  const sql='/*vs:'+id+'*/SELECT 1',row={sql,operation:'probe',phase:'logical',statementId:id,origin:{kind:'module' as const}};
  expect(runtimeBoundary([row]),id).toEqual(captured.has(id)?['nonmember missing source capture: '+id]:[]);
  if(remaining.has(id))expect(runtimeBoundary([{...row,sql:'/*vs:'+id+'*/SELECT * FROM view_prompts'}])).toContain('legacy-only operation reads view rows');
 }
});

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {const file=dir+'/'+name;return statSync(file).isDirectory()?sourceFiles(file):/\.tsx?$/.test(file)?[file]:[]});
const exceptionPhase = (phase: string): StatementException['phase'] => {if(phase==='W'||phase==='P'||phase==='H'||phase==='T')return phase;throw new Error('Unknown statement phase '+phase)};
test('the complete Deployment source boundary admits only frozen statement and foundation tuples',()=>{
 const sources=new Map(['packages/myco-server/src','packages/myco/src','packages/myco-shared/src'].flatMap(sourceFiles).map(file=>[file,readFileSync(file,'utf8')]));
 const exceptions=legacy.sourceExceptions.map<StatementException>(item=>({...item,phase:exceptionPhase(item.phase)}));
 expect(sourceBoundary(sources,exceptions,legacy.foundationImports)).toEqual([]);
});

test('all source and test importers preserve the closed SQL-bearing foundation boundary',()=>{
 const files=['packages/myco-server/src','packages/myco/src','packages/myco-shared/src','tests'].flatMap(sourceFiles);
 const sources=new Map(files.map(file=>[file,readFileSync(file,'utf8')]));
 expect(sourceBoundary(sources,[],legacy.foundationImports,{importsOnly:true})).toEqual([]);
},30000);

test('schema fixture origins admit exactly the stamped bootstrap relations',async()=>{
 const helpers=(preparationOrigins).filter(origin=>origin.id.startsWith('H:'));
 expect(helpers.map(origin=>[origin.id,origin.file,origin.owner,origin.expression,origin.phase])).toEqual([
  ['H:catalog-upgrade','tests/meta/view-read-boundary.test.ts','test:fresh and upgraded native and D1 catalogs admit only frozen FTS synchronization','sql','H'],
  ['H:pair-schema','tests/myco-server/helpers/view-stores.ts','initialize','sql','H'],
  ['H:identity-schema','tests/myco-server/view-read-legacy.test.ts','nativeVariantIdentity','sql','H'],
 ]);
 const relations=[...new Set(SCHEMA_STEPS.flatMap(step=>step.statements.flatMap(sql=>protectedRelations(sql))))].sort();
 for(const helper of helpers)expect(helper.relations).toEqual(relations);
});

test('historical renderings retain exact-base statement bytes',()=>{
 const through=legacy.schema.steps.at(-1)!.version;
 expect(SCHEMA_STEPS.filter(step=>step.version<=through).map(step=>({version:step.version,sha256:createHash('sha256').update(JSON.stringify(step.statements)).digest('hex')}))).toEqual(legacy.schema.steps);
});

test('fresh and upgraded native and D1 catalogs admit only frozen FTS synchronization',async()=>{
 for(const through of [98,Infinity])await withViewStores(async(db,target)=>{
  if(through===98)for(const step of SCHEMA_STEPS.filter(step=>step.version>through))await db.batch(step.statements.map(sql=>db.prepare(sql)));
  const rows=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('view','trigger') ORDER BY name").all<{type:string;name:string;tbl_name:string;sql:string|null}>()).results;
  expect(viewSchemaViolations(rows),target+' through '+through).toEqual([]);
  const triggers=rows.filter(row=>row.type==='trigger' && row.tbl_name.startsWith('view_'));
  expect(triggers.length).toBe(legacy.schema.viewTriggers.native.length);
  for(const trigger of triggers){
   for(const table of ['session_read_facts','embedding_versions','search_blob_queue'])expect(viewSchemaViolations([{...trigger,sql:trigger.sql+' INSERT INTO '+table+'(project_id) VALUES(1);'}])).toContain(trigger.name+': forbidden view trigger dependency');
  }
 },through);
},30000);

test('SQL relation detection preserves quoted data and closes comments and qualified identifiers',()=>{
 for(const sql of ['SELECT * FROM/*x*/plans','SELECT * FROM main.'+String.fromCharCode(34)+'prompt_batches'+String.fromCharCode(34),'SELECT * FROM [responses]','/*a*/ --b\n SELECT * FROM '+String.fromCharCode(96)+'tool_calls'+String.fromCharCode(96),'SELECT * FROM '+String.fromCharCode(39)+'plans'+String.fromCharCode(39)])expect(protectedSql(sql)).toBe(true);
 expect(protectedSql('SELECT '+String.fromCharCode(39)+'FROM plans'+String.fromCharCode(39)+' AS value')).toBe(false);
 expect(runtimeBoundary([{sql:'/*vs:M99:unknown:0*/SELECT 1',operation:'probe',phase:'logical',statementId:'one'}])).toContain('unknown operation M99:unknown:0');
 for(const relation of ['PLANS','main.RESPONSES','main."TOOL_CALLS"','[PROMPT_BATCHES]']){
  const sql='SELECT * FROM '+relation;
  expect(protectedSql(sql)).toBe(true);
  expect(sourceBoundary(new Map([[reader,'db.prepare('+JSON.stringify(sql)+')']]))).toContain(reader+'#<module>: protected SQL preparation outside owner');
  expect(runtimeBoundary([{sql,operation:'probe',phase:'logical',statementId:'case'}])).toEqual(['untagged protected SQL: probe/case']);
 }
 for(const sql of [
  'CREATE TABLE IF NOT EXISTS main.prompt_batches(id TEXT)',
  'CREATE VIRTUAL TABLE view_prompts_fts USING fts5(body)',
  'ALTER TABLE [responses] ADD COLUMN label TEXT',
  'DROP TABLE IF EXISTS main."tool_calls"',
  'CREATE UNIQUE INDEX IF NOT EXISTS p_idx ON plans(id)',
  'CREATE TRIGGER IF NOT EXISTS p_trigger AFTER UPDATE OF value ON plans BEGIN SELECT 1; END',
  'CREATE TABLE unrelated(id TEXT REFERENCES prompt_batches(prompt_id))',
 ]){
  expect(protectedSql(sql)).toBe(true);
  expect(sourceBoundary(new Map([[reader,'db.prepare('+JSON.stringify(sql)+')']]))).toContain(reader+'#<module>: protected SQL preparation outside owner');
  expect(runtimeBoundary([{sql,operation:'probe',phase:'logical',statementId:'ddl'}])).toEqual(['untagged protected SQL: probe/ddl']);
 }
 expect(protectedSql("SELECT 'CREATE TABLE plans' AS value")).toBe(false);
 for(const relation of ['VIEW_PROMPTS','main."VIEW_RESPONSES"','main.session_views'])expect(runtimeBoundary([{sql:'/*vs:'+operation+'*/SELECT * FROM '+relation,operation:'probe',phase:'logical',statementId:'view',origin:{kind:'module'}}])).toContain('legacy-only operation reads view rows');
});

test('ordinary native and local D1 factories observe the actual typed operation',async()=>{
 await withViewStores(async(db,target)=>{
  const key=target==='native'?'native':'d1',before=nativeReadObservations();
  await planTotals(db,{all:false,projectIds:['project']});
  const after=nativeReadObservations(),first=before.targets.get(key)?.get(operation),last=after.targets.get(key)?.get(operation);
  expect((last?.prepares??0)-(first?.prepares??0),target+' preparation wrapper').toBe(1);
  expect((last?.binds??0)-(first?.binds??0),target+' bind wrapper').toBe(1);
  expect((last?.executions??0)-(first?.executions??0),target+' execution wrapper').toBe(1);
 });
},30000);

test('actual factory recorders kill untagged dynamic SQL and forged closed tags before execution',async()=>{
 await withViewStores(async(db,target)=>{
  const recorded=statementRecorder(db,{accounting:target==='native'?'native':'d1'});
  for(const [sql,message]of [
   [['SELECT * FROM','plans'].join(' '),'untagged protected SQL'],
   ['SELECT * FROM sessions s, prompt_batches pb','untagged protected SQL'],
   ['SELECT * FROM json_each(?) w, responses r','untagged protected SQL'],
   ['SELECT * FROM (sessions s, tool_calls t)','untagged protected SQL'],
   [['/*','vs:',operation,'*/SELECT * FROM plans'].join(''),'forged module operation'],
  ]){
   expect(()=>recorded.db.prepare(sql!)).toThrow(message);
   expect(recorded.events.at(-1)?.failed).toBe(true);
   expect(recorded.statements).toHaveLength(0);
  }
  const origin=(preparationOrigins).find(row=>row.id==='maintenance-learning-hold')!;
  const fragment='SELECT 1 FROM session_views WHERE (SELECT COUNT(*) FROM prompt_batches) >= 0';
  expect(()=>withReadPreparation(origin,()=>recorded.db.prepare(fragment)),target+' interpolated exception bypass').toThrow('exception adds protected relations: maintenance-learning-hold: prompt_batches');
  await recorded.drain();
 });
},30000);

test('a removed member kills the actual unchanged trace for missing capture',async()=>{
 await withViewStores(async(db,target)=>{
  const recorded=statementRecorder(db,{accounting:target==='native'?'native':'d1'});
  await planTotals(recorded.db,{all:false,projectIds:['project']});await recorded.drain();
  expect(recorded.statements).toHaveLength(1);
  expect(runtimeBoundary(recorded.statements,{legacy:new Set()})).toEqual(['nonmember missing source capture: '+operation]);
 });
},30000);

test('the module cannot export raw SQL aliases or descriptors before an importer exists',()=>{
 const module='packages/myco-server/src/read/view-store.ts';
 for(const text of [
  "export const escapedSql='SELECT * FROM plans';",
  "const sql='SELECT * FROM plans';export {sql as escapedSql};",
  "const sql='SELECT * FROM plans';const descriptor={type:sql};export type Escaped=typeof descriptor.type;",
 ])expect(sourceBoundary(new Map([[module,text]]))).not.toEqual([]);
 expect(sourceBoundary(new Map([[module,"const descriptor={prompt:'SELECT * FROM plans'};export type Kind=keyof typeof descriptor;"]]))).toEqual([]);
});

test('oracle authority stays inside the loader and production cannot import test capabilities',()=>{
 const recorder='tests/helpers/statement-recorder.ts';
 for(const [file,text]of [
  ['packages/myco-server/src/read/bypass.ts',"import {withReadPreparation} from '../../../../tests/helpers/statement-recorder.js';"],
  ['tests/foreign.ts',"import {createOracleLoader as mint} from './helpers/statement-recorder.js';"],
  ['tests/foreign.ts',"import {createOracleLoader as mint} from './helpers/statement-recorder';"],
  ['tests/foreign.ts',"export {createOracleLoader as mint} from './helpers/statement-recorder.js';"],
  ['tests/foreign.ts',"const source=await import('./helpers/statement-recorder.js');"],
  ['packages/myco-server/src/read/bypass.ts',"const source=import.meta.require('../../../../tests/helpers/statement-recorder.js');"],
  ['packages/myco-server/src/read/bypass.ts',"const source=await import(new URL('../../../../tests/helpers/statement-recorder.js',import.meta.url));"],
  ['packages/myco-server/src/read/bypass.ts',"import {createOracleLoader} from '/workspace/tests/helpers/statement-recorder.js';"],
  ['packages/myco-server/src/read/bypass.ts',"const source=await import('file:///workspace/tests/helpers/statement-recorder.js');"],
  ['packages/myco-server/src/read/bypass.ts',"const source=await import('file:///workspace/packages/../tests/helpers/statement-recorder.js');"],
  ['packages/myco-server/src/read/bypass.ts',"const source=await import('../../../../%74ests/helpers/statement-recorder.js?probe');"],
  ['packages/myco-server/src/read/bypass.ts',"async function load(){return import(new URL('../../../../tests/helpers/statement-recorder.js',import.meta.url))}"],
  ['packages/myco-server/src/read/bypass.ts',"const path='../../../../tests/helpers/'+'statement-recorder.js';const load=import.meta.require;const source=load(path);"],
  ['packages/myco-server/src/read/bypass.ts',"const source=require('D:\\\\a\\\\myco\\\\myco\\\\tests\\\\helpers\\\\statement-recorder.js');"],
  ['packages/myco-server/src/read/bypass.ts',"const source=import.meta.require('D:\\\\a\\\\myco\\\\myco\\\\tests\\\\helpers\\\\statement-recorder.js');"],
 ]as const)for(const importsOnly of [false,true])expect(sourceBoundary(new Map([[file,text],[recorder,'export function createOracleLoader(){}']]),[],[],{importsOnly})).not.toEqual([]);
 const forged={sql:'SELECT * FROM plans',operation:'forged-oracle',phase:'read',statementId:'forged',origin:{kind:'oracle' as const,sha256:'a'.repeat(64)}};
 expect(runtimeBoundary([forged])).toContain('untagged protected SQL: forged-oracle/forged');
});

test('production module loads require literal specifiers',()=>{
 for(const load of ['import(path)','require(path)','import.meta.require(path)',"import(['..','tests','helpers','statement-recorder.js'].join('/'))",'const load=import.meta.require;load(path)','const load=require;load(path)',"import {createRequire as create} from 'node:module';const load=create(import.meta.url);load(path)","import * as mod from 'node:module';const load=mod.createRequire(import.meta.url);load(path)"]){
  for(const file of ['packages/myco-server/src/read/bypass.ts','packages/myco/src/cli/bypass.ts']){
   for(const importsOnly of [false,true])expect(sourceBoundary(new Map([[file,'const path=process.env.MODULE;'+load]]),[],[],{importsOnly})).toContain(file+': non-literal module specifier');
  }
 }
});

test('catalog readers have one pinned open relation classification',()=>{
 expect(OPEN_RELATION_PREPARATIONS.map(({file,owner,expression})=>[file,owner,expression])).toEqual([
  ['packages/myco/src/member/legacy-backup.ts','legacyVaultHasContent','`SELECT 1 FROM ${table} LIMIT 1`'],
  ['packages/myco/src/member/legacy-backup.ts','vaultContent','`SELECT * FROM ${table}`'],
  ['packages/myco/src/server/recovery-sql.ts','writeRecoverySql','`SELECT ${selected} FROM ${identifier(table.name)}`'],
  ['packages/myco/src/server/recovery-sql.ts','tableOrder','`PRAGMA foreign_key_list(${identifier(name)})`'],
  ['packages/myco/src/server/recovery-sql.ts','writeRecoverySql','`PRAGMA table_xinfo(${identifier(table.name)})`'],
  ['packages/myco/src/server/recovery-bundle.ts','rows','sql'],
  ['packages/myco/src/server/sql-dump.ts','runOneStatement','sql'],
  ['packages/myco-server/src/core/relational-snapshot.ts','relationalSnapshot','admissionSql'],
  ['packages/myco-server/src/core/relational-snapshot.ts','relationalSnapshot',"`WITH admission AS MATERIALIZED (${admissionSql}),\n    snapshot_rows AS MATERIALIZED (${unionGroups(selections)}),\n    snapshot_size AS (SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(length(CAST(line AS BLOB)) + 1), 0) AS snapshot_bytes FROM snapshot_rows)\n    SELECT admission_count, admission_bytes, snapshot_count, snapshot_bytes, line FROM admission CROSS JOIN snapshot_size\n    LEFT JOIN snapshot_rows ON snapshot_bytes <= ? ORDER BY ordinal, rid`"],
 ]);
 for(const entry of OPEN_RELATION_PREPARATIONS)expect(entry.reason.length).toBeGreaterThan(30);
});

test('exception closures freeze namespace class binding loop and caller arguments',()=>{
 const fragment='packages/myco-server/src/read/fragment.ts';
 const cases=[
  {definition:"export const piece=()=> 'SELECT 1 FROM sessions';",body:"import * as H from './fragment.js';function rows(db){return db.prepare(H.piece())}",expression:'H.piece()'},
  {definition:"export class H {static piece(){return 'SELECT 1 FROM sessions'}}",body:"import {H} from './fragment.js';function rows(db){return db.prepare(H.piece())}",expression:'H.piece()'},
  {definition:"export const H={piece:()=> 'SELECT 1 FROM sessions'}",body:"import {H} from './fragment.js';function rows(db){const {piece}=H;return db.prepare(piece())}",expression:'piece()'},
  {definition:"export const pieces=['SELECT 1 FROM sessions']",body:"import {pieces} from './fragment.js';function rows(db){for(const sql of pieces)db.prepare(sql)}",expression:'sql'},
  {definition:"export const piece=()=> 'SELECT 1 FROM sessions';",body:"import {piece} from './fragment.js';function rows(db,sql){return db.prepare(sql)};rows(db,piece())",expression:'sql'},
 ];
 for(const probe of cases){
  const sources=new Map([[fragment,probe.definition],[reader,probe.body]]),tuple:StatementException={id:'probe',file:reader,owner:'rows',expression:probe.expression,phase:'P'};
  const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
  sourceBoundary(sources,[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(_,dependencies)=>{tuple.dependencies=dependencies;}});
  expect(sourceBoundary(sources,[tuple],[],{closures,callers})).toEqual([]);
  const mutant=new Map(sources).set(fragment,probe.definition.replace('FROM sessions','FROM tool_calls'));
  expect(sourceBoundary(mutant,[tuple],[],{closures,callers}).some(error=>/SQL closure differs|SQL sink argument dependencies differ/.test(error))).toBe(true);
 }
 const unknown={id:'unknown',file:reader,owner:'rows',expression:'unresolved',phase:'P' as const};
 expect(sourceBoundary(new Map([[reader,'function rows(db){return db.prepare(unresolved)}']]),[unknown],[],{closures:[],callers:[]})).toContain(reader+'#rows: unresolved SQL dependency '+reader+':unresolved');
});

test('parameter origins require their own captured caller relations',()=>{
 const origin={kind:'exception' as const,id:'sink',file:reader,owner:'rows',expression:'sql',phase:'P' as const,relations:['prompt_batches','tool_calls'],callerKeys:['left','right'],callerRelations:[{callers:['left'],relations:['prompt_batches']},{callers:['right'],relations:['tool_calls']}]};
 const options={known:new Set<string>(),legacy:new Set<string>(),origins:[origin]};
 const statement={operation:'probe',phase:'P',statementId:'one',exceptionId:'sink',sql:'SELECT * FROM tool_calls',origin:{...origin,callers:['right']}};
 expect(readPreparationViolations([statement],options)).toEqual([]);
 expect(readPreparationViolations([{...statement,origin:{...origin,callers:['left']}}],options)).toEqual(['exception adds protected relations: sink: tool_calls']);
 expect(readPreparationViolations([{...statement,origin:{...origin,callers:[]}}],options)).toEqual(['exception lacks pinned caller: sink']);
 expect(readPreparationViolations([{...statement,origin:{...origin,callers:['new']}}],options)).toEqual(['exception lacks pinned caller: sink']);
});

test('runtime caller scopes follow preparing frames and keep returned fragments statically frozen',()=>{
 const text="function make(options?:{sql:string}){return options===undefined?'SELECT id FROM sessions':options.sql};const built=make();function builtRows(db){return db.prepare(built)};function rows(db,sql){return db.prepare(sql)};function forward(db,sql){return rows(db,sql)};forward(db,make())";
 const tuples:StatementException[]=[{id:'built',file:reader,owner:'builtRows',expression:'built',phase:'P'},{id:'parameter',file:reader,owner:'rows',expression:'sql',phase:'P'}],closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
 sourceBoundary(new Map([[reader,text]]),tuples,[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(tuple,dependencies)=>{tuple.dependencies=dependencies;}});
 expect(closures.find(row=>row.owner==='builtRows')?.parameters.some(parameter=>parameter.owner==='make')).toBe(true);
 expect(closures.find(row=>row.owner==='builtRows')?.activeParameters).toEqual([]);
 expect(closures.find(row=>row.owner==='rows')?.activeParameters?.map(parameter=>parameter.owner)).toEqual(['rows']);
 expect(callers.find(row=>row.owner==='forward'&&row.callee==='rows')?.activeParameters?.map(parameter=>parameter.owner)).toEqual(['forward']);
 expect(callers.find(row=>row.owner==='<module>'&&row.callee==='forward')?.activeParameters).toEqual([]);
 expect(sourceBoundary(new Map([[reader,text]]),tuples,[],{closures,callers})).toEqual([]);
 expect(sourceBoundary(new Map([[reader,text.replace('FROM sessions','FROM tool_calls')]]),tuples,[],{closures,callers}).some(error=>error.includes('SQL closure differs')||error.includes('SQL sink argument dependencies differ'))).toBe(true);
 const contextual="interface Store{prepare(sql:string):unknown};const store={prepare(sql:string){return db.prepare(sql)}} satisfies Store;store.prepare('SELECT id FROM sessions')",nested:ExceptionClosure[]=[];
 sourceBoundary(new Map([[reader,contextual]]),[{id:'contextual',file:reader,owner:'<module>',expression:'sql',phase:'P'}],[],{closures:[],callers:[],captureClosure:row=>nested.push(row)});
 expect(nested[0]?.activeParameters?.map(parameter=>({owner:parameter.owner,index:parameter.index}))).toEqual([{owner:'prepare',index:0}]);
});

test('SQL sink values cannot escape through erased aliases or call wrappers',()=>{
 for(const use of ['const invoke:any=rows;invoke(db,fragment)','rows.call(null,db,fragment)','rows.apply(null,[db,fragment])','const invoke=rows.bind(null);invoke(db,fragment)']){
  const tuple:StatementException={id:'sink',file:reader,owner:'rows',expression:'sql',phase:'P'};
  const text='function rows(db,sql){return db.prepare(sql)};const fragment="SELECT * FROM tool_calls";'+use;
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[]}).some(error=>error.includes('unresolved SQL sink reference rows'))).toBe(true);
 }
});

test('preparation instrumentation preserves member lookup arguments and receiver',async()=>{
 const file='tests/preparation-probe.ts',origin={kind:'exception' as const,id:'probe',file,owner:'run',expression:'await value()',phase:'T' as const};
 const source="let reads=0;let values=0;let gets=0;const db={get prepare(){gets++;return function(sql){return {same:this===db,sql,reads,values,gets}}}};function receiver(){reads++;return db};async function value(){values++;Object.defineProperty(db,'prepare',{value(){throw Error('late lookup')}});return 'SELECT * FROM plans'};export async function run(){return receiver().prepare(await value())}";
 const output=instrumentReadPreparations(ts,source,file,[origin],import.meta.dir+'/../helpers/statement-recorder.ts',[{key:'caller',file,owner:'run',callee:'receiver().prepare',argument:'await value()',index:0}]);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(output);
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 expect(await loaded.run()).toEqual({same:true,sql:'SELECT * FROM plans',reads:1,values:1,gets:1});
});

test('untracked route dispatch preserves optional calls and skips their arguments',async()=>{
 const source="export function run(){let argumentsRead=0;const routes={'/session':function(){return this===routes?'session':'wrong receiver'}};const value=routes['/missing']?.(++argumentsRead)??routes['/session']?.();const absent=null;const skipped=absent?.['run'](++argumentsRead);return {value,argumentsRead,skipped}}";
 const output=instrumentReadPreparations(ts,source,'tests/route-dispatch-probe.ts',[],import.meta.dir+'/../helpers/statement-recorder.ts');
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(output);
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 expect(loaded.run()).toEqual({value:'session',argumentsRead:0,skipped:undefined});
});

test('only tracked method receivers gain execution scopes and frozen handles keep their identity',async()=>{
 let gets=0;
 const ordinary={get run(){gets++;return function(this:unknown){return this}}};
 expect(preparedMethodReceiver(ordinary)).toBe(ordinary);
 expect(gets).toBe(0);
 const source="import {AsyncLocalStorage} from 'node:async_hooks';export function ordinary(receiver){const bound=(function(){return this}).bind(receiver);const contexts=new AsyncLocalStorage();return contexts.run('active',()=>({same:bound()===receiver,context:contexts.getStore(),run:receiver['run']()===receiver}))};export async function execute(statement,key,value){return statement?.[key()]?.(await value())}";
 const output=instrumentReadPreparations(ts,source,'tests/method-receiver-probe.ts',[],import.meta.dir+'/../helpers/statement-recorder.ts');
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(output);
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 expect(loaded.ordinary(ordinary)).toEqual({same:true,context:'active',run:true});
 expect(gets).toBe(1);
 const effects:string[]=[],physical={kind:'exception' as const,id:'transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const handle=Object.freeze({get first(){effects.push('lookup');return function(this:unknown,value:unknown){expect(this).toBe(handle);expect(value).toBe('project');return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get()}}});
 const statement=withPreparedRead({kind:'module'},tagged,()=>handle);
 expect(statement).toBe(handle);
 const key=()=>{effects.push('key');return 'first'},value=async()=>{effects.push('argument');await Promise.resolve();return 'project'};
 expect(await loaded.execute(statement,key,value)).toEqual({n:1});
 expect(effects).toEqual(['key','lookup','argument']);
 expect(await loaded.execute(undefined,key,value)).toBeUndefined();
 expect(effects).toEqual(['key','lookup','argument']);
});

test('prepared method continuations preserve every optional boundary and awaited argument',async()=>{
 const source="export async function run(statement,object,value){const first=statement?.bind(await value()).first();const nested=object?.statement.first();const absent=statement?.missing?.(await value()).first();return {first,nested,absent}};export function strict(statement){return statement?.bind().first()};export function tail(statement){return statement?.bind().label}";
 const output=instrumentReadPreparations(ts,source,'tests/chain-probe.ts',[],import.meta.dir+'/../helpers/statement-recorder.ts');
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(new Bun.Transpiler({loader:'ts'}).transformSync(output)).toString('base64'));
 let argumentsRead=0;
 const value=async()=>{argumentsRead++;await Promise.resolve();return 'project'};
 expect(await loaded.run(undefined,undefined,value)).toEqual({first:undefined,nested:undefined,absent:undefined});
 expect(argumentsRead).toBe(0);
 expect(()=>loaded.strict({bind:()=>undefined})).toThrow(TypeError);
 expect(loaded.tail(undefined)).toBeUndefined();
 const physical={kind:'exception' as const,id:'transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const handle=Object.freeze({label:'original',bind(input:unknown){expect(this).toBe(handle);expect(input).toBe('project');return this},first(){expect(this).toBe(handle);return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get()}});
 const statement=withPreparedRead({kind:'module'},tagged,()=>handle);
 expect(await loaded.run(statement,{statement},value)).toEqual({first:{n:1},nested:{n:1},absent:undefined});
 expect(argumentsRead).toBe(1);
});

test('optional member references retain parentheses receivers and coerce computed keys once',async()=>{
 const source="export function parenthesized(object){return (object.bind)?.().first()};export function optional(object){return (object?.bind)?.().first()};export function strict(object){return (object?.bind)().first()};export function computed(statement,key){return statement?.[key]().first()}";
 const output=instrumentReadPreparations(ts,source,'tests/reference-probe.ts',[],import.meta.dir+'/../helpers/statement-recorder.ts');
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(new Bun.Transpiler({loader:'ts'}).transformSync(output)).toString('base64'));
 const physical={kind:'exception' as const,id:'transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const bound=Object.freeze({first(){expect(this).toBe(bound);return withPhysicalPreparation(physical,tagged,'query',()=>({get(){return {n:1}}})).get()}});
 const statement=withPreparedRead({kind:'module'},tagged,()=>Object.freeze({bind(){expect(this).toBe(statement);return bound}}));
 const object={bind(){expect(this).toBe(object);return statement.bind()}};
 expect(loaded.parenthesized(object)).toEqual({n:1});
 expect(loaded.optional(object)).toEqual({n:1});
 expect(loaded.optional(undefined)).toBeUndefined();
 expect(()=>loaded.strict(undefined)).toThrow(TypeError);
 let coercions=0;
 const key={[Symbol.toPrimitive](){coercions++;return 'bind'}};
 expect(loaded.computed(statement,key)).toEqual({n:1});
 expect(coercions).toBe(1);
});

test('optional preparation chains retain their sealed SQL origin through bound continuations',async()=>{
 const source="export function prepareViewRead(db,sql){return db?.prepare(sql).bind('project').first()}";
 const output=instrumentReadPreparations(ts,source,owner,[],import.meta.dir+'/../helpers/statement-recorder.ts');
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(new Bun.Transpiler({loader:'ts'}).transformSync(output)).toString('base64'));
 const physical={kind:'exception' as const,id:'transport',file:'tests/transport.ts',owner:'query',expression:'sql',phase:'T' as const};
 const db={prepare(sql:string){
  return {bind(input:string){
   expect(input).toBe('project');
   return Object.freeze({first(){return withPhysicalPreparation(physical,sql,'query',()=>({get(){return {n:1}}})).get()}});
  }};
 }};
 expect(loaded.prepareViewRead(undefined,tagged)).toBeUndefined();
 expect(loaded.prepareViewRead(db,tagged)).toEqual({n:1});
});

test('frozen SQL defaults remain dependencies and omitted calls remain callers',()=>{
 const tuple:StatementException={id:'default',file:reader,owner:'rows',expression:'sql',phase:'P'};
 const text="function rows(db,sql='SELECT 1 FROM sessions'){return db.prepare(sql)};rows(db)";
 const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
 sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row)});
 expect(callers.some(row=>row.argument==='<omitted>')).toBe(true);
 expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures,callers})).toEqual([]);
 expect(sourceBoundary(new Map([[reader,text.replace('FROM sessions','FROM tool_calls')]]),[tuple],[],{closures,callers})).toContain(reader+'#rows: SQL closure differs');
 expect(sourceBoundary(new Map([[reader,'function rows(db,...sql){return db.prepare(sql[0])}']]),[{...tuple,expression:'sql[0]'}],[],{closures:[],callers:[]})).toContain(reader+'#rows: unresolved SQL dependency '+reader+':variadic SQL parameter sql');
});

test('regular expression aliases do not prepare SQL and frozen non-SQL origins refuse it',()=>{
 const file='tests/regex-probe.ts';
 for(const source of ['const pattern=/FROM/;pattern.exec(sql)','const pattern=new RegExp("FROM");const alias=pattern;alias.exec(sql)','const patterns={one:/FROM/,two:/INTO/};patterns.one.exec(sql)']){
  const origin={kind:'exception' as const,id:'probe',file,owner:'<module>',expression:'sql',phase:'T' as const};
  expect(instrumentReadPreparations(ts,source,file,[origin],'recorder')).toBe(source);
 }
 const origin={kind:'exception' as const,id:'record',file,owner:'<module>',expression:'record',phase:'T' as const,nonSql:true};
 const statement={operation:'probe',phase:'T',statementId:'one',exceptionId:'record',origin,sql:'SELECT * FROM plans'};
 expect(readPreparationViolations([statement],{known:new Set(),legacy:new Set(),origins:[origin]})).toEqual(['non-SQL origin used for SQL: record']);
});

test('SQL closure resolution refuses staged or spread calls and pins rest and custom methods',()=>{
 for(const [helper,expression]of [
  ["function wrap(seed){return (sql)=>sql}", "wrap('SELECT id FROM sessions')(fragment)"],
  ["function second(a,b='SELECT id FROM sessions'){return b}", "second(...[0,fragment])"],
 ]){
  const tuple:StatementException={id:'probe',file:reader,owner:'rows',expression:expression!,phase:'P'};
  const text=helper+";function rows(db,fragment){return db.prepare("+expression+")};rows(db,'SELECT id FROM sessions')";
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[]}).some(error=>error.includes('unresolved SQL dependency'))).toBe(true);
 }
 for(const [helper,expression]of [
  ["function pick(...parts){return parts[0].sql}", "pick({sql:fragment})"],
  ["", "({map(){return fragment}}).map()"],
 ]){
  const tuple:StatementException={id:'probe',file:reader,owner:'rows',expression:expression!,phase:'P'};
  const text=helper+";function rows(db,fragment){return db.prepare("+expression+")};rows(db,'SELECT id FROM sessions')";
  const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
  sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(_,dependencies)=>{tuple.dependencies=dependencies;}});
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures,callers})).toEqual([]);
  expect(closures.some(row=>row.parameters.some(parameter=>parameter.owner==='rows'&&parameter.index===1))).toBe(true);
  expect(sourceBoundary(new Map([[reader,text.replace("rows(db,'SELECT id FROM sessions')","rows(db,'SELECT id FROM sessions WHERE EXISTS (SELECT 1 FROM sessions)')")]]),[tuple],[],{closures,callers}).some(error=>error.includes('unpinned SQL sink argument'))).toBe(true);
 }
});

test('finite SQL dispatch maps freeze the implementation and every caller argument',()=>{
 const tuple:StatementException={id:'probe',file:reader,owner:'<module>',expression:'sql',phase:'P'};
 const text="const handlers={rows(db,sql){return db.prepare(sql)}};const invoke=handlers[key];invoke(db,'SELECT id FROM sessions')";
 const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
 sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(_,dependencies)=>{tuple.dependencies=dependencies;}});
 expect(callers.some(row=>row.callee==='invoke'&&row.sink.owner==='rows'&&row.index===1)).toBe(true);
 expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures,callers})).toEqual([]);
 expect(sourceBoundary(new Map([[reader,text.replace("invoke(db,'SELECT id FROM sessions')","invoke(db,'SELECT id FROM sessions WHERE EXISTS (SELECT 1 FROM sessions)')")]]),[tuple],[],{closures,callers}).some(error=>error.includes('unpinned SQL sink argument'))).toBe(true);
 expect(sourceBoundary(new Map([[reader,text+";invoke.call(null,db,sql)"]]),[tuple],[],{closures,callers}).some(error=>error.includes('unresolved SQL sink reference'))).toBe(true);
});

test('iterator SQL projections freeze yielded and returned values and refuse resumed SQL inputs',()=>{
 for(const definition of ["function* statements(){yield {sql:SQL};return {sql:SQL}}","function* values(){yield {sql:SQL}};function* statements(){yield* values()}"]){
  const text="const SQL='SELECT id FROM sessions';"+definition+";function rows(db){const iterator=statements();const step=iterator.next();return db.prepare(step.value.sql)}",tuple:StatementException={id:'iterator',file:reader,owner:'rows',expression:'step.value.sql',phase:'P'},closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
  sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(_,dependencies)=>{tuple.dependencies=dependencies;}});
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures,callers})).toEqual([]);
  expect(sourceBoundary(new Map([[reader,text.replace('FROM sessions','FROM tool_calls')]]),[tuple],[],{closures,callers}).some(error=>error.includes('SQL closure differs')||error.includes('SQL sink argument dependencies differ'))).toBe(true);
 }
 const text="function* statements(){const sql=yield {};yield {sql}};function rows(db){const iterator=statements();const step=iterator.next();return db.prepare(step.value.sql)}";
 expect(sourceBoundary(new Map([[reader,text]]),[{id:'iterator',file:reader,owner:'rows',expression:'step.value.sql',phase:'P'}],[],{closures:[],callers:[]}).some(error=>error.includes('resumed generator SQL value'))).toBe(true);
});

test('contextual SQL implementations retain callable escape checks',()=>{
 for(const use of ['store.prepare.call(store,fragment)','store.prepare.apply(store,[fragment])','const invoke=store.prepare.bind(store);invoke(fragment)','const erased:any=store;erased.prepare.call(store,fragment)']){
  const tuple:StatementException={id:'probe',file:reader,owner:'<module>',expression:'sql',phase:'P'};
  const text="interface Store{prepare(sql:string):unknown};const store={prepare(sql:string){return db.prepare(sql)}} satisfies Store;const fragment='SELECT id FROM sessions';"+use;
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[]}).some(error=>/unresolved SQL sink (member|reference)/.test(error))).toBe(true);
 }
});

test('guarded writes and explicit undefined retain their source dependencies',()=>{
 for(const text of [
  "const DOMAIN={'SELECT id FROM sessions':true};function allowed(v:string):v is keyof typeof DOMAIN{return Object.hasOwn(DOMAIN,v)};function rows(db,sql:string){if(!allowed(sql))return;return db.prepare(sql)};rows(db,'SELECT id FROM sessions')",
  "const DEFAULT='SELECT id FROM sessions';function rows(db,sql=DEFAULT){return db.prepare(sql)};rows(db,undefined)",
  "function rows(db,sql){return db.prepare(sql)};rows(db,'SELECT id FROM sessions')",
  "const SQL='SELECT id FROM sessions';function rows(db,sql){sql=SQL;return db.prepare(sql)};rows(db,'SELECT id FROM sessions')",
 ]){
  const tuple:StatementException={id:'probe',file:reader,owner:'rows',expression:'sql',phase:'P'},closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[];
  sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(_,dependencies)=>{tuple.dependencies=dependencies;}});
  expect(sourceBoundary(new Map([[reader,text]]),[tuple],[],{closures,callers})).toEqual([]);
  const mutant=text.includes('DOMAIN')?text.replace('return db.prepare(sql)',"sql='SELECT (SELECT COUNT(*) FROM sessions) FROM sessions' as keyof typeof DOMAIN;return db.prepare(sql)"):text.includes('DEFAULT')?text.replace("DEFAULT='SELECT id FROM sessions'","DEFAULT='SELECT (SELECT COUNT(*) FROM sessions) FROM sessions'"):text.includes('const SQL')?text.replace("SQL='SELECT id FROM sessions'","SQL='SELECT (SELECT COUNT(*) FROM sessions) FROM sessions'"):text.replace('return db.prepare(sql)',"sql='SELECT (SELECT COUNT(*) FROM sessions) FROM sessions';return db.prepare(sql)");
  expect(mutant).not.toBe(text);
  expect(sourceBoundary(new Map([[reader,mutant]]),[tuple],[],{closures,callers})).not.toEqual([]);
 }
});

test('preparation policy preserves the byte-equal sealed seed and only observed fixture extensions',async()=>{
 const seed=await checkedPreparationOrigins(legacy.preparationOrigins);
 expect(preparationOriginEnvelope.seedSha256).toBe(legacy.preparationOrigins.sha256);
 expect(preparationOrigins.slice(0,seed.length)).toEqual(seed);
 const extensions=preparationOriginEnvelope.extensions.flatMap(entry=>entry.ids);
 expect(preparationOrigins.slice(seed.length).map(entry=>entry.id)).toEqual(extensions);
 const keys=preparationSourcePins.callers.map(row=>row.key).sort();
 const evidence=preparationOriginEnvelope.fixtureReconciliation;
 expect(evidence.sourceGraphSha256).toBe(preparationOriginEnvelope.sourceClosureProgram.sha256);
 expect(evidence.observedCount).toBe(extensions.length);
 for(const row of evidence.files)
  expect(createHash('sha256').update(readFileSync(row.file)).digest('hex')).toBe(row.sha256);
 const authority=preparationOrigins.slice(seed.length).map(row=>
  [row.id,row.file,row.owner,row.expression,row.phase,row.relations,{callerRelations:row.callerRelations}]);
 expect(createHash('sha256').update(JSON.stringify(authority)).digest('hex')).toBe(evidence.authoritySha256);
 for(const row of preparationOrigins.slice(seed.length)){
  expect(row.phase).toBe('T');
  expect(Array.isArray(row.relations)).toBe(true);
  expect(row.callerKeys).toEqual(keys);
  expect(row.callerRelations?.length).toBeGreaterThan(0);
 }
});

test('fixture permissions retain exact current caller contexts and refuse an unobserved sealed caller',()=>{
 const ids=new Set(preparationOriginEnvelope.extensions.flatMap(entry=>entry.ids));
 const selected=preparationOrigins.filter(row=>ids.has(row.id)).flatMap(origin=>
  (origin.callerRelations??[]).flatMap(context=>context.relations.map(table=>({origin,context,table}))))[0];
 if(!selected)throw new Error('No protected fixture context');
 const {origin,context,table}=selected;
 const observedKeys=new Set(origin.callerRelations?.flatMap(row=>row.callers));
 const other=preparationSourcePins.callers.find(row=>!observedKeys.has(row.key));
 if(!other)throw new Error('No unobserved sealed caller');
 const statement={operation:'fixture',phase:'T',statementId:'fixture',exceptionId:origin.id,
  sql:'SELECT * FROM '+table,origin:{...origin,callers:context.callers}};
 const options={known:new Set<string>(),legacy:new Set<string>(),origins:preparationOrigins};
 expect(readPreparationViolations([statement],options)).toEqual([]);
 expect(readPreparationViolations([{...statement,origin:{...origin,callers:[...context.callers,other.key]}}],options))
  .toEqual(['exception lacks pinned caller: '+origin.id]);
 expect(readPreparationViolations([{...statement,origin:{...origin,callers:[]}}],options))
  .toEqual(['exception lacks pinned caller: '+origin.id]);
});

test('every admitted fixture tuple exists and every retired fixture tuple is absent',()=>{
 const ids=new Set(preparationOriginEnvelope.extensions.flatMap(entry=>entry.ids));
 const live=preparationOrigins.filter(row=>ids.has(row.id));
 const retired=preparationOriginEnvelope.fixtureReconciliation.retired;
 const tuple=(row:{file:string;owner:string;expression:string})=>JSON.stringify([row.file,row.owner,row.expression]);
 const sites=new Set<string>();
 for(const file of new Set([...live,...retired].map(row=>row.file))){
  const source=readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node):void=>{
   if(ts.isCallExpression(node)&&isSqlPreparation(ts,node,tree)&&node.arguments[0])
    sites.add(tuple({file,owner:preparationOwner(ts,node,tree),expression:node.arguments[0].getText(tree)}));
   ts.forEachChild(node,visit);
  };
  visit(tree);
 }
 for(const row of live)expect(sites.has(tuple(row))).toBe(true);
 for(const row of retired){
  expect(sites.has(tuple(row))).toBe(false);
  expect(ids.has(row.id)).toBe(false);
  expect(createHash('sha256').update(readFileSync(row.file)).digest('hex')).toBe(row.fileSha256);
 }
 expect(preparationOriginEnvelope.fixtureReconciliation.inputCount).toBe(live.length+retired.length);
 expect(preparationOriginEnvelope.fixtureReconciliation.missing).toEqual([]);
});

function planStatusCallers(sources: ReadonlyMap<string, string>): {file:string;owner:string;line:number;escape:boolean}[] {
 const files=new Map([...sources].map(([file,text])=>['/'+file,ts.createSourceFile('/'+file,text,ts.ScriptTarget.Latest,true)]));
 const host:ts.CompilerHost={
  getSourceFile:file=>files.get(file),getDefaultLibFileName:()=>'/lib.d.ts',writeFile:()=>{},getCurrentDirectory:()=>'/',
  getDirectories:()=>[],fileExists:file=>files.has(file),readFile:file=>sources.get(file.slice(1)),getCanonicalFileName:file=>file,
  useCaseSensitiveFileNames:()=>true,getNewLine:()=>'\n',
  resolveModuleNames:(names,containing)=>names.map(name=>{
   const file=(name.startsWith('@myco-server-worker/')?'/packages/myco-server/src/'+name.slice('@myco-server-worker/'.length)
    :new URL(name,'file://'+containing).pathname).replace(/\.js$/,'.ts');
   return files.has(file)?{resolvedFileName:file,extension:ts.Extension.Ts}:undefined;
  }),
 };
 const program=ts.createProgram([...files.keys()],{target:ts.ScriptTarget.Latest,module:ts.ModuleKind.ESNext,noLib:true},host),checker=program.getTypeChecker();
 const names=new Set(['setPlanStatus']);
 for(let count=-1;count!==names.size;){
  count=names.size;
  for(const tree of files.values()){
   const aliases=(node:ts.Node):void=>{
    if((ts.isImportSpecifier(node)||ts.isExportSpecifier(node))&&names.has((node.propertyName??node.name).text))names.add(node.name.text);
    ts.forEachChild(node,aliases);
   };aliases(tree);
  }
 }
 const owns=(symbol:ts.Symbol|undefined):boolean=>{
  if(!symbol)return false;
  if(symbol.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  return symbol.declarations?.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='setPlanStatus'
   &&node.getSourceFile().fileName==='/packages/myco-server/src/read/plans.ts')??false;
 };
 const rows:{file:string;owner:string;line:number;escape:boolean}[]=[];
 for(const [absolute,tree]of files){
  const file=absolute.slice(1);
  const add=(node:ts.Node,escape:boolean)=>rows.push({file,owner:preparationOwner(ts,node,tree),line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,escape});
  const visit=(node:ts.Node):void=>{
   if(ts.isIdentifier(node)){
    let namespace=checker.getSymbolAtLocation(node);
    if(namespace&&(namespace.flags&ts.SymbolFlags.Alias))namespace=checker.getAliasedSymbol(namespace);
    if(namespace&&(namespace.flags&(ts.SymbolFlags.ValueModule|ts.SymbolFlags.NamespaceModule))&&checker.getExportsOfModule(namespace).some(owns)){
     const parent=node.parent;
     const member=ts.isPropertyAccessExpression(parent)&&parent.expression===node
      ||ts.isElementAccessExpression(parent)&&parent.expression===node&&ts.isStringLiteral(parent.argumentExpression);
     const spy=ts.isCallExpression(parent)&&parent.expression.getText(tree)==='spyOn'&&parent.arguments[0]===node
      &&parent.arguments[1]!==undefined&&ts.isStringLiteral(parent.arguments[1])&&!owns(namespace.exports?.get(ts.escapeLeadingUnderscores(parent.arguments[1].text)));
     if(!ts.isNamespaceImport(parent)&&!member&&!spy)add(node,true);
    }
   }
   if(ts.isIdentifier(node)&&names.has(node.text)&&owns(checker.getSymbolAtLocation(node))){
    const parent=node.parent;
    if(ts.isImportSpecifier(parent)||ts.isFunctionDeclaration(parent)&&parent.name===node)return;
    const access=ts.isPropertyAccessExpression(parent)&&parent.name===node?parent:node;
    add(node,!(ts.isCallExpression(access.parent)&&access.parent.expression===access));
   }
   if(ts.isElementAccessExpression(node)&&ts.isStringLiteral(node.argumentExpression)
    &&owns(checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text))) {
    add(node,!(ts.isCallExpression(node.parent)&&node.parent.expression===node));
   }
   if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
    const module=checker.getSymbolAtLocation(node.arguments[0]);
    if(module&&checker.getExportsOfModule(module).some(owns))add(node,true);
   }
   ts.forEachChild(node,visit);
  };visit(tree);
 }
 return rows;
}

const FACT_STATUS_CALLERS = [
 'tests/myco-server/view-records.test.ts#it:fact-only status primitive retains the frozen result and complete empty-world statement work',
 'tests/myco-server/embedding-reconcile.test.ts#test:plan status writes report their own result and invalidate indexed metadata',
 'tests/myco-server/dashboard-conversation-honesty.test.ts#it:gate 1643.1: plan edits and equal-time inserts cannot move displayed identities into a continuation',
] as const;

function planStatusCallerViolations(sources: ReadonlyMap<string,string>): string[] {
 return planStatusCallers(sources).flatMap(row=>row.escape||!['packages/myco-server/src/core/plans.ts#changePlanStatus',...FACT_STATUS_CALLERS].includes(row.file+'#'+row.owner)
  ?[row.file+':'+row.line+' status primitive bypass '+row.owner]:[]);
}

test('status primitive has one editorial caller and explicitly fact-only fixture callers',()=>{
 const sources=new Map(['packages/myco-server/src','packages/myco/src','tests'].flatMap(sourceFiles).map(file=>[file,readFileSync(file,'utf8')]));
 expect(planStatusCallerViolations(sources)).toEqual([]);
 const calls=planStatusCallers(sources);
 expect([...new Set(calls.map(row=>row.file+'#'+row.owner))].sort()).toEqual(['packages/myco-server/src/core/plans.ts#changePlanStatus',...FACT_STATUS_CALLERS].sort());
});

test('status primitive gate kills direct, aliased, escaped and namespace editorial bypasses',()=>{
 const definition='packages/myco-server/src/read/plans.ts',canonical='packages/myco-server/src/core/plans.ts',route='packages/myco-server/src/api/probe.ts';
 const root=[definition,'export function setPlanStatus(...args:unknown[]){return false}'] as const;
 const admitted=[canonical,"import {setPlanStatus} from '../read/plans.js'; export function changePlanStatus(){return setPlanStatus()}"] as const;
 expect(planStatusCallerViolations(new Map([root,admitted]))).toEqual([]);
 for(const text of [
  "import {setPlanStatus} from '../read/plans.js'; export function edit(){return setPlanStatus()}",
  "import {setPlanStatus as write} from '../read/plans.js'; export function edit(){return write()}",
  "import {setPlanStatus} from '../read/plans.js'; export const write=setPlanStatus",
  "import * as plans from '../read/plans.js'; export function edit(){return plans['setPlanStatus']()}",
  "import * as plans from '../read/plans.js'; export function edit(key:string){return plans[key]()}",
  "import * as plans from '../read/plans.js'; const escaped=plans",
  "export {setPlanStatus as write} from '../read/plans.js'",
 ])expect(planStatusCallerViolations(new Map([root,admitted,[route,text]])),text).not.toEqual([]);
});


function sourceSealChanges(before:{closures:readonly ExceptionClosure[];callers:readonly ParameterCaller[]},after:typeof before):{kind:string;change:string;tupleId:string}[]{
 const changes:{kind:string;change:string;tupleId:string}[]=[];
 for(const kind of ['closures','callers'] as const){
  const key=(row:ExceptionClosure|ParameterCaller)=>'key' in row?row.key:JSON.stringify([row.file,row.owner,row.expression]);
  const old=new Map(before[kind].map(row=>[key(row),row])),current=new Map(after[kind].map(row=>[key(row),row]));
  for(const identity of [...new Set([...old.keys(),...current.keys()])].sort()){
   const left=old.get(identity),right=current.get(identity);
   if(JSON.stringify(left)===JSON.stringify(right))continue;
   const change=left===undefined?'added':right===undefined?'removed':'changed';
   changes.push({kind,change,tupleId:createHash('sha256').update(JSON.stringify([kind,change,left??null,right??null])).digest('hex')});
  }
 }
 return changes;
}

test('the live source seal equals the complete derivation and accounts for every tuple change',async()=>{
 expect(createHash('sha256').update(readFileSync('tests/myco-server/fixtures/view-read-legacy.json')).digest('hex')).toBe('e95bb12b3b2298b72141912d06cfea9f24546730011376520d08afb719fb6746');
 const files=preparationSourceInventory(process.cwd());
 const sources=new Map(files.map(file=>[file,readFileSync(file,'utf8')]));
 const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[],dependencyDiffs:unknown[]=[];
 const exceptions=legacy.sourceExceptions.map<StatementException>(item=>({...item,phase:exceptionPhase(item.phase)}));
 sourceBoundary(sources,exceptions,legacy.foundationImports,{
  closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),
  captureDependencies:(exception,dependencies)=>{if(JSON.stringify(exception.dependencies??[])!==JSON.stringify(dependencies))dependencyDiffs.push(exception.id);},
 });
 expect(dependencyDiffs).toHaveLength(0);
 const derived={closures,callers};
 expect(sourceSealChanges(derived,preparationSourcePins)).toEqual([]);
 expect(preparationOriginEnvelope.sourceClosureProgram.sources).toEqual(files.map(file=>({file,sha256:createHash('sha256').update(sources.get(file)!).digest('hex')})));
 const historical=await checkedPreparationSource(legacy.sourceClosureProgram);
 const changed=sourceSealChanges(historical,derived);
 const classes=new Set(['moved plan-status SQL','renamed injection composition','opaque-context decorator','bounded refusal/status metadata','transitive callback fingerprint','module-owned read preparation','focused view fixtures','schema 104 admission projection','SQL identifier dependency fingerprint','closed literal sink','writer-shaped fixture instrumentation']);
 const accounted=preparationOriginEnvelope.sourceClosureChanges;
 expect(accounted.map(({reason,...row})=>row).sort((a,b)=>a.tupleId.localeCompare(b.tupleId))).toEqual([...changed].sort((a,b)=>a.tupleId.localeCompare(b.tupleId)));
 expect(accounted.every(row=>classes.has(row.reason))).toBe(true);
 expect(new Set(accounted.map(row=>row.tupleId)).size).toBe(accounted.length);
 const first=callers[0]!;
 expect(sourceSealChanges(derived,{closures,callers:callers.slice(1)})).not.toEqual([]);
 expect(sourceSealChanges(derived,{closures,callers:[...callers,{...first,key:first.key+'extra'}]})).not.toEqual([]);
 expect(sourceSealChanges(derived,{closures,callers:callers.map((row,index)=>index===0?{...row,argument:row.argument+'stale'}:row)})).not.toEqual([]);
},60000);
