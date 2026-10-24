import { createHash } from 'node:crypto';
import legacy from '../myco-server/fixtures/view-read-legacy.json';
import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import {withViewStores} from '../myco-server/helpers/view-stores.js';
import type {StatementException} from '../helpers/view-read-contract.js';
import {statementRecorder} from '../helpers/statement-recorder.js';
import {nativeReadObservations,instrumentReadSource} from '../setup/view-read-preload.js';
import {listTurns} from '@myco-server-worker/read/turns.js';

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { VIEW_READ_OPERATIONS } from '@myco-server-worker/read/view-store.js';
import { sourceBoundary, runtimeBoundary, viewSchemaViolations, armPlanViolations, significantRead, protectedSql,durableObservationViolations } from '../helpers/view-read-contract.js';

const owner = 'packages/myco-server/src/read/view-store.ts';
const reader = 'packages/myco-server/src/read/probe.ts';
const operation = VIEW_READ_OPERATIONS.find(operation => operation.family === 'M01')!.id;
const tagged = '/*vs:' + operation + '*/SELECT prompt_id FROM prompt_batches WHERE project_id=?';
test('preparation instrumentation preserves awaited RegExp execution in schema contracts',()=>{
 const file='tests/myco-server/view-store-schema.test.ts';
 const instrumented=instrumentReadSource(readFileSync(file,'utf8'),file);
 expect(()=>new Bun.Transpiler({loader:'ts'}).transformSync(instrumented)).not.toThrow();
 expect(instrumented).toContain('/\\bWHERE\\s+(.+)$/i.exec(await sql(name))');
 expect(instrumented).toContain('__viewReadPreparation(');
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
    ]) expect(sourceBoundary(new Map([[reader, body]]))).toContain(reader + '#<module>: protected SQL preparation outside owner');
    for(const method of ['query','exec'])expect(sourceBoundary(new Map([[reader,'db.'+method+'('+JSON.stringify('/*a*/ --b\n SELECT * FROM main.plans')+')']]))).toContain(reader+'#<module>: protected SQL preparation outside owner');
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

test('current read module has no run-writer import or source-capture engine',()=>{
  const text=readFileSync('packages/myco-server/src/read/view-store.ts','utf8');
  expect(text).not.toMatch(/from\s+['"]\.\.\/core\/runs\.js/);
  expect(text).not.toMatch(/\b(?:ResponseRead|SelectedSource|RELATIONAL_CONTEXT|effectiveMaterial|recordRows|sessionRows)\b/);
});

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {const file=dir+'/'+name;return statSync(file).isDirectory()?sourceFiles(file):file.endsWith('.ts')?[file]:[]});
const exceptionPhase = (phase: string): StatementException['phase'] => {if(phase==='W'||phase==='P'||phase==='H'||phase==='T')return phase;throw new Error('Unknown statement phase '+phase)};
test('the complete Deployment source boundary admits only frozen statement and foundation tuples',()=>{
 const sources=new Map(sourceFiles('packages/myco-server/src').map(file=>[file,readFileSync(file,'utf8')]));
 const exceptions=legacy.sourceExceptions.map<StatementException>(item=>({...item,phase:exceptionPhase(item.phase)}));
 expect(sourceBoundary(sources,exceptions,legacy.foundationImports)).toEqual([]);
});

test('all source and test importers preserve the closed SQL-bearing foundation boundary',()=>{
 const files=['packages/myco-server/src','packages/myco/src','packages/myco-shared/src','tests'].flatMap(sourceFiles);
 const sources=new Map(files.map(file=>[file,readFileSync(file,'utf8')]));
 expect(sourceBoundary(sources,[],legacy.foundationImports,{importsOnly:true})).toEqual([]);
});

test('historical renderings retain exact-base statement bytes',()=>{
 expect(SCHEMA_STEPS.map(step=>({version:step.version,sha256:createHash('sha256').update(JSON.stringify(step.statements)).digest('hex')}))).toEqual(legacy.schema.steps);
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
 for(const relation of ['VIEW_PROMPTS','main."VIEW_RESPONSES"','main.session_views'])expect(runtimeBoundary([{sql:'/*vs:'+operation+'*/SELECT * FROM '+relation,operation:'probe',phase:'logical',statementId:'view',origin:{kind:'module'}}])).toContain('legacy-only operation reads view rows');
});

test('ordinary native and local D1 factories observe the actual typed operation',async()=>{
 await withViewStores(async(db,target)=>{
  const key=target==='native'?'native':'d1',before=nativeReadObservations();
  await listTurns(db,{projectId:'project'},'missing');
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
   [['/*','vs:',operation,'*/SELECT * FROM plans'].join(''),'forged module operation'],
  ]){
   expect(()=>recorded.db.prepare(sql!)).toThrow(message);
   expect(recorded.events.at(-1)?.failed).toBe(true);
   expect(recorded.statements).toHaveLength(0);
  }
  await recorded.drain();
 });
},30000);

test('a removed member kills the actual unchanged trace for missing capture',async()=>{
 await withViewStores(async(db,target)=>{
  const recorded=statementRecorder(db,{accounting:target==='native'?'native':'d1'});
  await listTurns(recorded.db,{projectId:'project'},'missing');await recorded.drain();
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
 ]as const)for(const importsOnly of [false,true])expect(sourceBoundary(new Map([[file,text],[recorder,'export function createOracleLoader(){}']]),[],[],{importsOnly})).not.toEqual([]);
 const forged={sql:'SELECT * FROM plans',operation:'forged-oracle',phase:'read',statementId:'forged',origin:{kind:'oracle' as const,sha256:'a'.repeat(64)}};
 expect(runtimeBoundary([forged])).toContain('untagged protected SQL: forged-oracle/forged');
});
