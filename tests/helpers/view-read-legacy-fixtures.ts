import {handleBlob} from '@myco-server-worker/ingest/blobs.js';
import {sha256HexOf} from '@myco-server-worker/hash.js';
import type { RelationalStore,PreparedStatement,RunResult } from '@myco-server-worker/core/adapters.js';
import { statementRecorder,withReadPreparation,createOracleLoader, type RecordedStatement } from './statement-recorder.js';
export interface LegacyExecutionCase { bytes: string | undefined; statements: RecordedStatement[] }
import { spyOn } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { envelope, uuid } from '../myco-server/helpers/fixtures.js';
import * as turns from '@myco-server-worker/read/turns.js';
import * as children from '@myco-server-worker/read/children.js';
import * as sessions from '@myco-server-worker/read/sessions.js';
import * as plans from '@myco-server-worker/read/plans.js';
import { sessionLineage } from '@myco-server-worker/read/lineage.js';
import { activityFeed } from '@myco-server-worker/read/activity.js';
import { listSessionActivity } from '@myco-server-worker/read/session-activity.js';
import * as hooks from '@myco-server-worker/read/hook-placement.js';
import { receiptPlans as receiptPlans } from '@myco-server-worker/read/view-store.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import * as ownedReads from '@myco-server-worker/read/view-store.js';
import * as injection from '@myco-server-worker/core/injection.js';
import * as acknowledgements from '@myco-server-worker/core/extraction-acks.js';
import * as served from '@myco-server-worker/core/served-material.js';
import {ensureAgent,recordDispatch} from '@myco-server-worker/core/runs.js';
import {createServer} from '@myco-server-worker/pipeline.js';
import {serverEnvFromBindings} from '@myco-server-worker/platform/cloudflare/env.js';
import {bootstrapOwnership} from '@myco-server-worker/core/raw-claims.js';
import {linkStatement} from '@myco-server-worker/auth/identity-link.js';
import {ownerCookie,OWNER_ENV} from '../myco-server/helpers/owner.js';
import {memoryBlobStore,recordingLimiter,noOutboundFetch,memberHeaders} from '../myco-server/helpers/fixtures.js';
import * as searchIndex from '@myco-server-worker/core/search-index.js';
import * as settings from '@myco-server-worker/core/settings.js';
import {insertSpore,resolveSpore} from '@myco-server-worker/core/spores.js';
import {reconcileEmbedding} from '@myco-server-worker/core/embedding/reconcile.js';
import {cloudflareVectorStore} from '@myco-server-worker/platform/cloudflare/vectors.js';
import {indexFixture} from '../myco-server/helpers/vector-index.js';
import {parseTranscripts,TRANSCRIPT_PRODUCER} from '@myco-server-worker/ingest/parse.js';
import {composePromptContext,recallLeaves,recordSessionInjection} from '@myco-server-worker/core/recall.js';
import {subagentIdFor} from '@myco/member/envelope.js';
import {sessionWriteAdmission} from '@myco-server-worker/ingest/projections.js';
import {tombstoneSession} from '@myco-server-worker/core/tombstones.js';
import * as releaseWork from '@myco-server-worker/core/release-provenance.js';
import * as switchWork from '@myco-server-worker/core/embedding/switch-store.js';
import {startEmbeddingSwitch,switchChoice} from '@myco-server-worker/core/embedding/switch.js';
import {resolveEmbedding} from '@myco-server-worker/core/embedding/policy.js';
import * as embeddingWork from '@myco-server-worker/core/embedding/reconcile.js';
import * as hubnessWork from '@myco-server-worker/core/embedding/hubness.js';
import {EmbeddingUnavailable} from '@myco-server-worker/core/embedding/provider.js';
import {deploymentSecretStore} from '@myco-server-worker/core/secrets.js';
import {A,REPO,fakeGithub} from '../myco-server/helpers/github-fake.js';
import {BACKUP_FORMAT,deploymentId,restoreArtifact} from '@myco-server-worker/core/backup.js';

export async function legacyExecutionCases(db: RelationalStore, target: 'native' | 'D1'): Promise<Record<string, LegacyExecutionCase>> {
 await seedLegacyFixture(db);
 const observedStore = statementRecorder(db, { accounting: target === 'native' ? 'native' : 'd1' });
 const observed = observedStore.db;
 const cases: Record<string, LegacyExecutionCase> = {};
 const run = async (name: string, read: () => Promise<unknown>) => { observedStore.reset(); const result=await read(); cases[name]={bytes:JSON.stringify(result,(_,v)=>v instanceof Map?[...v]:v),statements:structuredClone(observedStore.statements)}; };
 for(const projectId of ['project','other']) for(const sessionId of ['session','missing']) {
 const scope={projectId},key=projectId+'/'+sessionId;
 await run(key+'/turns',()=>turns.listTurns(observed,scope,sessionId));
 for(const order of ['ASC','DESC'] as const)for(const limit of [1,200]) {
  const opts={order,limit};
  const page=await turns.listTurns(db,scope,sessionId,opts);
  await run(key+'/turns/'+order+'/'+limit,()=>turns.listTurns(observed,scope,sessionId,opts));
  if(page.cursor)await run(key+'/turns/'+order+'/'+limit+'/next',()=>turns.listTurns(observed,scope,sessionId,{...opts,cursor:page.cursor ?? undefined}));
 }
 await run(key+'/admission',()=>turns.promptInSession(observed,scope,sessionId,uuid(20)));
 await run(key+'/detail',()=>turns.turnDetail(observed,scope,sessionId,uuid(20)));
 for(const collection of turns.TURN_COLLECTIONS)await run(key+'/collection/'+collection,()=>turns.turnCollection(observed,scope,sessionId,uuid(20),collection,{limit:1}));
 await run(key+'/tools',()=>turns.toolUsage(observed,scope,sessionId));
 await run(key+'/tools/prompt',()=>turns.toolUsage(observed,scope,sessionId,uuid(20)));
 await run(key+'/contexts',()=>turns.sessionTurnContexts(observed,scope,sessionId));
 for(const op of ['listPrompts','listContextInjections','listToolCalls','listResponses','listPlans','listAttachments'] as const) await run(key+'/'+op,()=>children[op](observed,scope,sessionId,{limit:1}));
 await run(key+'/material',()=>children.sessionMaterialRows(observed,projectId,sessionId,{limit:10,excerptChars:100}));
 await run(key+'/material-tail',()=>children.sessionMaterialTailRows(observed,projectId,sessionId,{limit:10,excerptChars:100}));
 await run(key+'/get-session',()=>sessions.getSession(observed,scope,sessionId,1000));
 await run(key+'/counts',()=>sessions.sessionCounts(observed,scope,sessionId));
 await run(key+'/counts-bulk',()=>sessions.sessionCountsFor(observed,scope,[sessionId]));
 await run(key+'/lineage',()=>sessionLineage(observed,scope,sessionId));
 await run(key+'/session-activity',()=>listSessionActivity(observed,scope,sessionId));
 await run(key+'/unplaced',()=>hooks.listUnplacedHookRecords(observed,scope,sessionId));
 await run(key+'/count-unplaced',()=>hooks.countUnplacedContextRecords(observed,scope,sessionId,1000));
 await run(key+'/plan-membership',()=>plans.planInSession(observed,scope,sessionId,uuid(50)));
 }
 for(const projectId of ['project','other']){
 const scope={projectId};
 await run(projectId+'/plan/full',()=>plans.getPlan(observed,scope,uuid(50)));
 await run(projectId+'/plan/summary',()=>plans.getPlan(observed,scope,uuid(50),{summary:true}));
 await run(projectId+'/feed',()=>activityFeed(observed,scope));
 for(const window of [undefined,'activity'] as const)for(const q of [undefined,'baseline','unmatched']) {
 const opts={limit:1,...(window===undefined?{}:{window,since:0}),...(q===undefined?{}:{q})};
 await run(projectId+'/sessions/'+window+'/'+q,()=>sessions.listSessionSummaries(observed,scope,opts,1000,{activity:true}));
 }
 for(const [kind,id]of [['prompt',uuid(20)],['response',uuid(30)],['plan',uuid(50)],['tool-input',uuid(40)],['tool-output',uuid(40)]] as const)
 await run(projectId+'/body/'+kind,()=>processedBody({db:observed,blobs:{get:async()=>{throw new Error('Unexpected blob read')},put:async()=>{throw new Error('Unexpected blob write')},delete:async()=>{throw new Error('Unexpected blob delete')},head:async()=>{throw new Error('Unexpected blob head')}}},scope,kind,id));
 await run(projectId+'/receipts',()=>receiptPlans(observed,scope,[{receiptId:'missing',planIds:[uuid(50)]}]));
 }
 return cases;
}

import legacy from '../myco-server/fixtures/view-read-legacy.json';

export interface LegacyVariant {
  id: string;
  family: string;
  part: string;
  case: Readonly<Record<string, string | number | boolean>>;
  empty_list_short_circuit: boolean;
  return_no_type_SQL?: boolean;
  statement_branch_set?: readonly string[];
}

export type LegacyApplicability = {applicable:true;sink:string;sourceWorld:string} | {applicable:false;reason:string};
export function legacyApplicability(variant:LegacyVariant):LegacyApplicability{
 const {family,case:v}=variant;
 if(family!=='M30')return {applicable:true,sink:family,sourceWorld:'canonical'};
 const producer=String(v.producer),consumer=String(v.consumer),source=String(v.source);
 if(v.usage!=='runtime-M')return {applicable:false,reason:producer==='embeddingSourceSelect'?'H_DESCRIPTOR_CONSUMER_MISMATCH':'H_PRIVATE_RUNTIME_ONLY'};
 if(producer==='embeddingSourceSelect')return consumer==='M29'?{applicable:true,sink:consumer,sourceWorld:source}:{applicable:false,reason:'R_DESCRIPTOR_M29_ONLY'};
 if(['M33','M35'].includes(consumer)||(producer==='currentMember'&&consumer==='M31'))return {applicable:false,reason:'R_CONSUMER_NO_FRAGMENT'};
 if((consumer==='M34'||producer==='currentMember')&&source!=='spore')return {applicable:false,reason:'R_SPORE_ONLY'};
 return {applicable:true,sink:consumer,sourceWorld:source};
}

function impossibleCase(family: string, value: LegacyVariant['case']): boolean {
  if (family === 'M04') {
    if (value.shape === 'by-prompt' && (!['RESPONSE_QUERY','ATTACHMENT_QUERY','TURN_PLAN_QUERY','ANSWER_QUERY'].includes(String(value.descriptor))
      || value.cursor !== 'first' || value.promptFilter !== 'present' || value.status !== 'absent' || value.q !== 'absent-or-blank')) return true;
    if (value.descriptor !== 'PLAN_QUERY' && (value.status !== 'absent' || value.q !== 'absent-or-blank')) return true;
  }
  if (family === 'M24') {
    if (value.statement === 'planTotals' && (value.cursor !== 'first' || value.status || value.sessionId || value.companion !== 'none')) return true;
    if (value.statement === 'selectPlans' && value.companion === 'tagsOf') return true;
    if (value.reach === 'project' && (value.since || value.q !== 'absent-or-blank')) return true;
    if (value.reach !== 'project' && value.sessionId) return true;
  }
  if (family === 'M25') {
    const type = String(value.type).replace('-companion','');
    if (['session','spore'].includes(type) && value.branch === 'blob-FTS') return true;
    if (type === 'session' && String(value.order).startsWith('time')) return true;
  }
  if (family === 'M26') {
    if (value.storage === 'bundle' && value.kind !== 'tool-input') return true;
    if (value.kind === 'attachment-companion' && value.stage === 'body') return true;
  }
  if (family === 'M30' && value.usage === 'runtime-M' && value.consumer === 'M29' && value.producer !== 'embeddingSourceSelect') return true;
  return false;
}

/** The complete finite census domain in stable family, axis and value order. */
export function* legacyVariants(): Generator<LegacyVariant> {
  const families: Readonly<Record<string,{axes: Readonly<Record<string,readonly (string | number | boolean)[]>>}>> = legacy.axes;
  const parts: Readonly<Record<string,string>> = legacy.domain.parts;
  for (const [family, {axes}] of Object.entries(families)) {
    const entries = Object.entries(axes);
    let index = 0;
    function* product(at: number, value: Record<string,string | number | boolean>): Generator<LegacyVariant> {
      if (at < entries.length) {
        const [name, options] = entries[at]!;
        for (const option of options) yield* product(at + 1, {...value,[name]:option});
        return;
      }
      if (impossibleCase(family,value)) return;
      const row: LegacyVariant = {id:family+'.'+String(++index).padStart(7,'0'),family,part:parts[family]!,case:value,
        empty_list_short_circuit:value.arity===0 || value.origins==='empty-no-SQL' || value.receiptChunk==='empty' || value.list==='empty'};
      if (family === 'M25') {
        const type = String(value.type).replace('-companion','');
        row.return_no_type_SQL = (value.status === true && ['prompt','response'].includes(type)) || (value.observationType === true && type !== 'spore');
        row.statement_branch_set = ['plan','prompt','response'].includes(type) ? ['own-FTS','blob-FTS'] : ['own-FTS'];
      }
      if (!legacy.domain.excludedVariants.includes(row.id)) yield row;
    }
    yield* product(0,{});
  }
}

/** Deterministic pairwise axis coverage includes every empty and maximum arity. */
export function legacyCIVariants():LegacyVariant[]{
 const covered=new Set<string>(),selected:LegacyVariant[]=[];
 for(const variant of legacyVariants()){
  if(!legacyApplicability(variant).applicable)continue;
  const reach=String(variant.case.reach??'');
  if(reach.startsWith('named-projects-')&&![0,1,2,63,64].includes(Number(reach.slice('named-projects-'.length))))continue;
  if(variant.family==='M25'&&![1,16].includes(Number(variant.case.terms)))continue;
  if(typeof variant.case.arity==='number'&&![0,1,2,89,90,91].includes(variant.case.arity))continue;
  const axes=Object.entries(variant.case),labels:string[]=variant.family==='M30'?[variant.id]:[];
  if(variant.family==='M34'&&variant.case.statement==='tally'&&variant.case.member==='joining'&&variant.case.ready===true)labels.push('M34:currentSporeVectorIds');
  for(let left=0;left<axes.length;left++)for(let right=left;right<axes.length;right++)labels.push(JSON.stringify([variant.family,axes[left],axes[right]]));
  if(labels.some(label=>!covered.has(label))){selected.push(variant);for(const label of labels)covered.add(label);}
 }
 return selected;
}

import * as search from '@myco-server-worker/read/search.js';
import type {ProjectSet} from '@myco-server-worker/read/scope.js';

export const variantReaders = {
 listSessions:sessions.listSessions,
 listSessionsAcross:sessions.listSessionsAcross,
 pageProjectPlans:plans.pageProjectPlans,
 pagePlansAcross:plans.pagePlansAcross,
 planTotals:plans.planTotals,
 searchProject:search.searchProject,
 searchAcross:search.searchAcross,
};
export type VariantReaders=typeof variantReaders;

function projectsFor(value: string):ProjectSet {
 if(value==='all-projects')return {all:true};
 const count=value==='named-projects'?2:Number(value.slice('named-projects-'.length));
 if(!Number.isSafeInteger(count)||count<0||count>64)throw new Error('Unknown Project reach '+value);
 return {all:false,projectIds:Array.from({length:count},(_,i)=>i===0?'project':'other-'+i)};
}

/** Public reader calls for the session, plan and FTS Cartesian branches. */
export async function executeListingVariant(db:RelationalStore,variant:LegacyVariant,readers:VariantReaders=variantReaders):Promise<unknown> {
 const v=variant.case;
 if(variant.family==='M13'||variant.family==='M14') {
  const opts:Parameters<typeof readers.listSessions>[2]={
   limit:200,
   fidelity:v.fidelity==='full'?'full':'any',
   ...(v.cursor==='next'?{cursor:'103:session'}:{}),
   ...(v.q==='present'?{q:'baseline'}:{}),
   ...(v.state==='open'||v.state==='ended'?{state:v.state}:{}),
   ...(v.now===true||v.arm==='working-now'?{now:1000}:{}),
   ...(v.branch===true?{branch:'main'}:{}),
   ...(v.agent===true?{agent:'copilot'}:{}),
   ...(v.memberLabel===true?{memberLabel:'member'}:{}),
   ...(v.sessionId===true?{sessionId:'session'}:{}),
   ...(v.since===true?{since:50}:{}),
   ...(v.until===true?{until:2000}:{}),
   ...(variant.family==='M14'?{window:'activity',since:0}:{}),
  };
  return v.reach==='project'?readers.listSessions(db,{projectId:'project'},opts):readers.listSessionsAcross(db,projectsFor(String(v.reach)),opts);
 }
 if(variant.family==='M24') {
  const set=v.reach==='project'?{all:false as const,projectIds:['project']}:projectsFor(String(v.reach));
  if(v.statement==='planTotals')return readers.planTotals(db,set,{...(v.since===true?{since:50}:{}),...(v.q==='present'?{q:'baseline'}:{})});
  const opts={
   limit:200,
   ...(v.cursor==='next'?{cursor:'105:'+uuid(50)}:{}),
   ...(v.status===true?{status:'active'}:{}),
   ...(v.sessionId===true?{sessionId:'session'}:{}),
   ...(v.since===true?{since:50}:{}),
   ...(v.q==='present'?{q:'baseline'}:{}),
  };
  return v.reach==='project'?readers.pageProjectPlans(db,{projectId:'project'},opts):readers.pagePlansAcross(db,set,opts);
 }
 if(variant.family==='M25') {
  const type=String(v.type).replace('-companion','');
  const order=v.order==='relevance'?'relevance':'time';
  const cursor=v.order==='time-next'?btoa(JSON.stringify({type,created_at:102,id:uuid(20),project_id:'project'})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''):undefined;
  const opts={
   query:Array.from({length:Number(v.terms)},()=>v.branch==='blob-FTS'?'blobcanary':'baseline').join(' '),
   type,mode:'fts',limit:100,order,
   ...(cursor===undefined?{}:{cursor}),
   ...(v.status===true?{status:'active'}:{}),
   ...(v.sessionId===true?{session_id:'session'}:{}),
   ...(v.observationType===true?{observation_type:'gotcha'}:{}),
   ...(v.since===true?{since:0}:{}),
   ...(v.until===true?{until:2000}:{}),
   ...(v.releaseState===true?{release_state:'released'}:{}),
   ...(v.releaseConfidence===true?{release_confidence:'verified'}:{}),
  };
  return v.reach==='project'?readers.searchProject(db,{projectId:'project'},opts):readers.searchAcross(db,projectsFor(String(v.reach)),opts);
 }
 throw new Error('Not a listing variant '+variant.id);
}

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const checksum=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export interface FrozenOracle {
 namespace(name:string):object;
 intern(sql:string):string;
 replayStore(db:RelationalStore):RelationalStore;
 textCount:number;
}

/** Runs representative reads against the sealed base program and its closed CI text set. */
export async function withFrozenCIOracle<T>(run:(oracle:FrozenOracle)=>Promise<T>):Promise<T>{
 const root=removeWhenTestsEnd(fs.mkdtempSync(join(tmpdir(),'myco-view-ci-oracle-')));
 const program=gunzipSync(Buffer.from(legacy.ci.programData,'base64'));
 if(checksum(program)!==legacy.program.sha256||program.length!==legacy.program.uncompressedBytes)throw new Error('Frozen CI program differs');
 const file=join(root,'legacy.mjs');fs.writeFileSync(file,program);
 const module:unknown=await import(pathToFileURL(file).href);
 if(typeof module!=='object'||module===null)throw new Error('Frozen CI program has no namespace');
 const text=gunzipSync(Buffer.from(legacy.ci.data,'base64'));
 if(checksum(text)!==legacy.ci.sha256)throw new Error('Frozen CI text set differs');
 const decoded:unknown=JSON.parse(text.toString());
 if(typeof decoded!=='object'||decoded===null||!('texts'in decoded)||!Array.isArray(decoded.texts)||!decoded.texts.every((value:unknown)=>typeof value==='string'))throw new Error('Invalid frozen CI texts');
 const texts=new Set<string>([...decoded.texts,...legacy.ci.publicTexts]);
 const intern=(sql:string)=>{if(!texts.has(sql))throw new Error('Statement absent from frozen CI text set');return sql;};
 const issue=createOracleLoader();
 return await run({
  textCount:texts.size,intern,
  namespace(name){const value=Reflect.get(module,name);if(typeof value!=='object'||value===null)throw new Error('Unknown frozen CI namespace '+name);return value;},
  replayStore(db){return {prepare:sql=>withReadPreparation(issue(intern(sql),checksum(sql)),()=>db.prepare(sql)),batch:statements=>db.batch(statements)}},
 });
}

/** Loads the exact-base program and admits SQL only through its frozen text table. */
export async function withFrozenOracle<T>(run:(oracle:FrozenOracle)=>Promise<T>):Promise<T> {
 const root=removeWhenTestsEnd(fs.mkdtempSync(join(tmpdir(),'myco-view-oracle-')));
 const capsulePath=process.env.MYCO_VIEW_READ_CAPSULE;
 if(!capsulePath)throw new Error('Full replay requires MYCO_VIEW_READ_CAPSULE naming the frozen PR-time capsule');
 const capsule:unknown=JSON.parse(fs.readFileSync(capsulePath,'utf8'));
 const data=(name:'program'|'statementText'):string=>{
  if(typeof capsule!=='object'||capsule===null||!(name in capsule))throw new Error('Invalid frozen replay capsule');
  const item:unknown=Reflect.get(capsule,name);
  if(typeof item!=='object'||item===null||!('data'in item)||typeof item.data!=='string')throw new Error('Missing frozen replay payload '+name);
  return item.data;
 };
 const program=gunzipSync(Buffer.from(data('program'),'base64'));
 if(checksum(program)!==legacy.program.sha256 || program.length!==legacy.program.uncompressedBytes)throw new Error('Frozen program digest differs');
 const programPath=join(root,'legacy.mjs');fs.writeFileSync(programPath,program);
 const module:unknown=await import(pathToFileURL(programPath).href);
 if(typeof module!=='object'||module===null)throw new Error('Frozen API has no module namespace');
 const sqlite=new Database(join(root,'statements.sqlite'));
 try {
  sqlite.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536');
  sqlite.exec('CREATE TABLE oracle_statements (id INTEGER PRIMARY KEY,digest TEXT NOT NULL UNIQUE,sql TEXT NOT NULL)');
  const insert=sqlite.query('INSERT INTO oracle_statements(id,digest,sql) VALUES(?,?,?)');
  const compressed=Buffer.from(data('statementText'),'base64');
  if(checksum(compressed)!==legacy.statementText.compressedSha256)throw new Error('Frozen compressed text digest differs');
  const unpacked=Readable.from([compressed]).pipe(createGunzip());
  const digest=createHash('sha256'),decoder=new TextDecoder();
  let pending='',count=0,bytes=0;
  sqlite.exec('BEGIN');
  for await(const chunk of unpacked) {
   digest.update(chunk);bytes+=chunk.byteLength;
   pending+=decoder.decode(chunk,{stream:true});
   let newline:number;
   while((newline=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,newline);pending=pending.slice(newline+1);
    const text:unknown=JSON.parse(line);
    if(typeof text!=='string')throw new Error('Frozen SQL text is not a string');
    insert.run(count++,checksum(text),text);
   }
  }
  pending+=decoder.decode();
  if(pending!=='' || count!==legacy.statementText.count || bytes!==legacy.statementText.uncompressedBytes || digest.digest('hex')!==legacy.statementText.sha256)throw new Error('Frozen SQL table differs');
  sqlite.exec('COMMIT');
  const lookup=sqlite.query('SELECT sql FROM oracle_statements WHERE digest=?');
  const intern=(sql:string):string=>{
   const row=lookup.get(checksum(sql));
   if(typeof row!=='object'||row===null||!('sql' in row)||typeof row.sql!=='string'||row.sql!==sql)throw new Error('Statement absent from frozen exact-base SQL text table');
   return row.sql;
  };
  const issue=createOracleLoader();
  const oracle:FrozenOracle={
   textCount:count,
   namespace(name){
    const value=Reflect.get(module,name);
    if(typeof value!=='object'||value===null)throw new Error('Unknown frozen namespace '+name);
    return value;
   },
   intern,
   replayStore(db){return {prepare:sql=>{const frozen=intern(sql);return withReadPreparation(issue(frozen,checksum(frozen)),()=>db.prepare(frozen))},batch:statements=>db.batch(statements)}},
  };
  return await run(oracle);
 } finally{sqlite.close()}
}

export function frozenListingReaders(oracle:FrozenOracle):VariantReaders {
 const method=(namespace:string,name:string):Function=>{
  const value=Reflect.get(oracle.namespace(namespace),name);
  if(typeof value!=='function')throw new Error('Unknown frozen operation '+namespace+'.'+name);
  return value;
 };
 return {
  listSessions:(...args)=>Reflect.apply(method('sessions','listSessions'),undefined,args),
  listSessionsAcross:(...args)=>Reflect.apply(method('sessions','listSessionsAcross'),undefined,args),
  pageProjectPlans:(...args)=>Reflect.apply(method('plans','pageProjectPlans'),undefined,args),
  pagePlansAcross:(...args)=>Reflect.apply(method('plans','pagePlansAcross'),undefined,args),
  planTotals:(...args)=>Reflect.apply(method('plans','planTotals'),undefined,args),
  searchProject:(...args)=>Reflect.apply(method('search','searchProject'),undefined,args),
  searchAcross:(...args)=>Reflect.apply(method('search','searchAcross'),undefined,args),
 };
}

export async function seedLegacyFixture(db:RelationalStore){
 await ensureMember(db,'member',1,'member');
 const random = spyOn(crypto,'getRandomValues').mockImplementation(<T extends ArrayBufferView>(value: T): T => {new Uint8Array(value.buffer,value.byteOffset,value.byteLength).fill(1);return value});
 const issued=await issueMemberToken(db,{memberId:'member',machineId:'machine'},1);
 random.mockRestore();
 const ctx = { projectId: 'project', machineId:'machine', tokenId:issued.tokenId, bodyBytes:1, now:1000 };
 for (const [i,kind,payload] of [
 [1,'session.start',{agent:'copilot',startedAt:100}],
 [2,'prompt',{promptId:uuid(20),text:'baseline prompt',origin:'user'}],
 [3,'response',{responseId:uuid(30),promptId:uuid(20),text:'baseline response'}],
 [4,'tool.use',{toolCallId:uuid(40),promptId:uuid(20),toolName:'Read',input:{path:'test'},success:true}],
 [5,'plan',{planKey:uuid(50),promptId:uuid(20),title:'baseline plan',content:'baseline plan',status:'active'}],
 [6,'prompt',{promptId:uuid(21),text:'baseline second',origin:'user'}],
 [7,'prompt',{promptId:uuid(22),parentPromptId:uuid(20),text:'baseline child',origin:'agent_dispatch'}],
 ] as const) {
  const r=await ingestEvent(db,ctx,envelope({eventId:uuid(i),sessionId:'session',kind,payload,createdAt:100+i}));
  if(!r.persisted) throw new Error(JSON.stringify(r));
 }
 return {...ctx,token:issued.token};
}

export const legacyBodyBlobs=memoryBlobStore();
const bodyWorldOffset:Readonly<Record<string,number>>={inline:0,blob:12000,bundle:13000};
const bodyWorldId=(storage:unknown,kind:string)=>uuid((bodyWorldOffset[String(storage)]??0)+(kind==='prompt'?20:kind==='response'?30:kind==='plan'?50:kind==='attachment'?60:40));
export async function seedLegacyBodyWorlds(db:RelationalStore,ctx:Awaited<ReturnType<typeof seedLegacyFixture>>){
 const env={...serverEnvFromBindings({MYCO_DB:db,BUCKET:legacyBodyBlobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()}),blobs:legacyBodyBlobs};
 const clock=spyOn(Date,'now').mockReturnValue(1000);
 try{
  for(const storage of ['blob','bundle']as const){
   const text=storage+' body canary',bytes=new TextEncoder().encode(text),key=await sha256HexOf(bytes);
   const upload=await handleBlob(env,new Request('https://s/blobs/'+key,{method:'POST',headers:{'content-type':'text/plain'},body:bytes}),{projectId:'project',machineId:'machine',tokenId:ctx.tokenId,now:1000,clock:()=>1000,contentLength:bytes.length,params:{key}});
   const admitted:unknown=await upload.json();if(typeof admitted!=='object'||admitted===null||!('stored'in admitted)||admitted.stored!==true)throw new Error('Body fixture upload refused '+JSON.stringify(admitted));
   const promptId=bodyWorldId(storage,'prompt');
   for(const [ordinal,kind,payload]of [
    [1,'prompt',{promptId,origin:'user',...(storage==='blob'?{blob:key}:{text})}],
    [2,'response',{responseId:bodyWorldId(storage,'response'),promptId,...(storage==='blob'?{blob:key}:{text})}],
    [3,'tool.use',{toolCallId:bodyWorldId(storage,'tool-input'),promptId,toolName:'Read',...(storage==='blob'?{blob:key,outputBlob:key}:{input:{body:'bundle input '+ 'λ'.repeat(3000)},output:text}),success:true}],
    [4,'plan',{planKey:bodyWorldId(storage,'plan'),promptId,title:storage+' body plan',...(storage==='blob'?{blob:key}:{content:text}),status:'active'}],
    [5,'attachment',{attachmentId:bodyWorldId(storage,'attachment'),promptId,blob:key}],
   ]as const){
    const result=await ingestEvent(db,ctx,envelope({eventId:uuid(bodyWorldOffset[storage]!+ordinal),sessionId:'session',kind,payload,createdAt:500+ordinal}),env);
    if(!result.persisted)throw new Error('Body fixture capture refused '+JSON.stringify(result));
   }
  }
 }finally{clock.mockRestore()}
}

export async function legacyReceiptReferences(db:RelationalStore):Promise<ReadonlyMap<string,unknown>>{
 const projects=['session','spore','plan'].flatMap(source=>['m30-'+source,'m30-'+source+'-stale']);
 const rows=await db.prepare('SELECT r.id,r.project_id,r.model_key,r.type,r.record_id FROM json_each(?) j CROSS JOIN embedding_receipts r WHERE r.project_id = j.value').bind(JSON.stringify(projects)).all<{id:string;project_id:string;model_key:string;type:string;record_id:string}>();
 const ids=new Set<string>(),descriptors=new Set<string>(),references=new Map<string,unknown>();
 for(const {id,project_id,model_key,type,record_id}of rows.results){
  const fixtureReceipt={projectId:project_id,modelKey:model_key,type,recordId:record_id},descriptor=JSON.stringify(fixtureReceipt);
  if(ids.has(id)||descriptors.has(descriptor))throw new Error('Ambiguous canonical fixture receipt');
  ids.add(id);descriptors.add(descriptor);references.set(id,{fixtureReceipt});
 }
 return references;
}
export function legacyReferencedEvents<T extends {binds:readonly unknown[]}>(events:readonly T[],references:ReadonlyMap<string,unknown>){
 return events.map(event=>({...event,binds:event.binds.map(value=>typeof value==='string'?(references.get(value)??value):value)}));
}

export async function seedLegacyEmbeddingWorlds(db:RelationalStore,ctx:Awaited<ReturnType<typeof seedLegacyFixture>>){
 for(const [index,source]of ['session','spore','plan'].entries())for(const stale of [false,true]){
  const projectId='m30-'+source+(stale?'-stale':''),sessionId=projectId+'-session',offset=20000+index*100+(stale?50:0),scope={projectId};
  if(!await sessions.createProject(db,projectId,projectId,1000))throw new Error('Duplicate embedding fixture project');
  const capture=async(kind:string,payload:unknown,ordinal:number)=>{
   const result=await ingestEvent(db,{...ctx,projectId},envelope({eventId:uuid(offset+ordinal),sessionId,kind,payload,createdAt:100+ordinal}));
   if(!result.persisted)throw new Error('Embedding fixture capture refused '+JSON.stringify(result));
  };
  await capture('session.start',{agent:'copilot',startedAt:100},1);
  if(source==='session'&&!await sessions.writeTitle(db,projectId,sessionId,'m30 title','m30 session source'))throw new Error('Embedding fixture title refused');
  if(source==='plan')await capture('plan',{planKey:uuid(offset+20),title:'m30 plan',content:'m30 plan source',status:'active'},2);
  if(source==='spore')for(let n=0;n<3;n++){
   const row=await insertSpore(db,scope,{id:uuid(offset+20+n),agentId:'fixture-agent',sessionId,observationType:'decision',content:'m30 spore source '+n,context:null,filePath:null,tags:null,contentHash:null,properties:null,author:'member',createdAt:100});
   if(!row)throw new Error('Embedding fixture spore refused');
  }
  const vectors=cloudflareVectorStore(indexFixture()),provider={modelKey:'model',embed:async()=>[1,0]};
  let settled=false;
  for(let step=0;step<100;step++)if((await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider},projectId,1000)).processed===0){settled=true;break;}
  if(!settled)throw new Error('Embedding fixture did not settle');
  if(stale){
   if(source==='session')await sessions.overwriteTitle(db,projectId,sessionId,'changed title','changed summary',null);
   else if(source==='plan')await capture('plan',{planKey:uuid(offset+20),title:'changed plan',content:'changed source',status:'active'},3);
   else for(let n=0;n<1;n++)if(!await resolveSpore(db,scope,'obsolete',{id:uuid(offset+30+n),agentId:'fixture-agent',sporeId:uuid(offset+20+n),action:'obsolete',newSporeId:null,reason:'fixture resolution',sessionId,author:'member',createdAt:1100},1100))throw new Error('Embedding fixture resolution refused');
  }
 }
}

export async function seedLegacyPromptArity(db:RelationalStore,count=91){
 const ctx=await seedLegacyFixture(db);
 const configured=await settings.settingsWriter(db,{target:'bun'}).setEmbedding({provider:'openai-compatible',model:'fixture-model',endpoint:'http://127.0.0.1:19999'},'member',1);
 if(!configured.applied)throw new Error('Fixture settings refused '+JSON.stringify(configured));
 await ensureAgent(db,{id:'fixture-agent',name:'fixture-agent',provider:null,model:null,enabled:true},1);
 if(!await recordDispatch(db,{projectId:'project'},{id:'run',agentId:'fixture-agent',task:'extract-curate',provider:null,model:null,runContext:null,dispatchedBy:null,startedAt:1}))throw new Error('Fixture dispatch refused');
 const promptIds:string[]=[];
 for(let i=0;i<count;i++){
  const promptId=uuid(100+i);promptIds.push(promptId);
  for(const [kind,eventId,payload]of [
   ['prompt',uuid(1000+i*4),{promptId,parentPromptId:uuid(20),text:'aritycanary '+i,origin:'user'}],
   ['response',uuid(1001+i*4),{responseId:uuid(300+i),promptId,text:'arity reply '+i}],
   ['tool.use',uuid(1002+i*4),{toolCallId:uuid(500+i),promptId,toolName:'Read',input:{path:'arity-'+i},success:true}],
   ['plan',uuid(1003+i*4),{planKey:uuid(700+i),promptId,title:'arity plan '+i,content:'arity plan '+i,status:'active'}],
  ] as const){
   const result=await ingestEvent(db,ctx,envelope({eventId,sessionId:'session',kind,payload,createdAt:200+i}));
   if(!result.persisted)throw new Error('Arity fixture refused '+JSON.stringify(result));
  }
 }
 await seedLegacyBodyWorlds(db,ctx);
 await seedLegacyEmbeddingWorlds(db,ctx);
 return {ctx,promptIds};
}

export async function seedLegacyCIResults(db:RelationalStore){
 const {ctx}=await seedLegacyPromptArity(db,0);
 const env=serverEnvFromBindings({MYCO_DB:db,BUCKET:legacyBodyBlobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()});
 let ordinal=40000;
 const capture=async(sessionId:string,kind:string,payload:unknown,channel:'cli'|'import'='cli')=>{
  const result=await ingestEvent(db,{...ctx,now:600},envelope({eventId:uuid(ordinal++),sessionId,kind,payload,channel,createdAt:200,producer:{adapter:'claude-code',version:'1'}}),env);
  if(!result.persisted)throw new Error('CI world capture refused '+JSON.stringify(result));
 };
 await capture('session','response',{responseId:uuid(48007),promptId:uuid(22),text:'baseline nested steering reply'});
 await capture('session','prompt',{promptId:uuid(48005),parentPromptId:uuid(22),origin:'agent_dispatch',text:'baseline nested steering child'});
 await capture('session','tool.use',{toolCallId:uuid(48006),promptId:uuid(22),toolName:'Read',input:{path:'nested.ts'},success:true});
 for(const [sessionId,parent]of [['continued',{parentSessionId:'session',parentReason:'continuation'}],['launched',{launchParentSessionId:'session'}],['ended',{}],['titled',{}],['imported',{}]]as const){
  await capture(sessionId,'session.start',{agent:'claude-code',startedAt:100,headSha:A,...parent});
  if(sessionId!=='imported')await capture(sessionId,'prompt',{promptId:uuid(ordinal+1000),origin:'user',text:'baseline CI '+sessionId});
 }
 await capture('ended','session.end',{endedAt:300,headSha:A,dirty:false});
 await capture('continued','turn',{phase:'start'});
 await capture('session','session.start',{agent:'copilot',startedAt:100,headSha:A});
 const clock=spyOn(Date,'now').mockReturnValue(300);
 try{await sessions.writeTitle(db,'project','titled','baseline titled','baseline summary');}finally{clock.mockRestore()}
 for(const reason of ['reported','no_result'])await capture('session','tool.use',{toolCallId:uuid(ordinal+2000),promptId:uuid(20),toolName:'Read',input:{path:'packages/a/test.ts'},success:false,resultReason:reason,filesAffected:['packages/a/test.ts']});
 const text=JSON.stringify({type:'user',promptId:uuid(45000),message:{role:'user',content:'baseline imported prompt'},timestamp:new Date(200).toISOString()})+'\n';
 const bytes=new TextEncoder().encode(text),key=await sha256HexOf(bytes);
 const uploaded=await handleBlob(env,new Request('https://s/blobs/'+key,{method:'POST',headers:{'content-type':'text/plain'},body:bytes}),{projectId:'project',machineId:'machine',tokenId:ctx.tokenId,now:600,clock:()=>600,contentLength:bytes.length,params:{key}});
 if(!uploaded.ok)throw new Error('CI transcript blob refused '+await uploaded.text());
 for(const transcriptId of [uuid(46000),uuid(46001)])await capture('imported','transcript.segment',{transcriptId,agent:'claude-code',baseOffset:0,length:bytes.length,blob:key},'import');
 await parseTranscripts(env,1000,{budget:{calls:2000,wallMs:30000}});
 await capture('imported','prompt',{promptId:uuid(47000),origin:'user',text:'baseline imported direct prompt'},'import');
 const parsed=await db.prepare('SELECT prompt_id,source_key,source_thread,source_record FROM prompt_batches WHERE project_id=? AND session_id=? AND claim IS NOT NULL LIMIT 1').bind('project','imported').first<{prompt_id:string;source_key:string;source_thread:string;source_record:string}>();
 if(!parsed)throw new Error('CI parsed prompt is missing');
 const conflict=await ingestEvent(db,{...ctx,now:1000,writeOrigin:'server'},envelope({eventId:uuid(47001),sessionId:'imported',kind:'prompt',channel:'cli',producer:TRANSCRIPT_PRODUCER,payload:{promptId:parsed.prompt_id,origin:'user',text:'baseline imported prompt',claim:'owner',sourceKey:parsed.source_key,sourceThread:parsed.source_thread,sourceRecord:'conflicting-record'},createdAt:200}),env);
 if(!conflict.persisted)throw new Error('CI parsed conflict capture refused '+JSON.stringify(conflict));
 await capture('imported','session.end',{endedAt:400},'import');
 await capture('session','tool.use',{toolCallId:uuid(48000),toolName:'myco_search',mycoTool:'myco_search',input:{query:'baseline'},success:true});
 await capture('session','tool.use',{toolCallId:uuid(48004),toolName:'myco_plans',mycoTool:'myco_plans',mycoOp:'list',input:{op:'list'},success:true});
 await insertSpore(db,{projectId:'project'},{id:uuid(48001),agentId:'fixture-agent',sessionId:'session',observationType:'decision',content:'baseline memory about selector ownership',context:null,filePath:null,tags:null,contentHash:null,properties:null,author:'member',createdAt:100});
 for(let i=0;i<13;i++)await insertSpore(db,{projectId:'project'},{id:uuid(48100+i),agentId:'fixture-agent',sessionId:'session',observationType:'decision',content:i<5?'baseline selector ownership '+i:'CI background '+i,context:null,filePath:null,tags:null,contentHash:null,properties:null,author:'member',createdAt:100});
 const vectors=cloudflareVectorStore(indexFixture()),provider={modelKey:'ci-recall',embed:async(text:string)=>text.startsWith('CI background')?[0,1]:[1,0]};
 let settled=false;
 for(let step=0;step<200;step++)if((await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider},'project',1000)).processed===0){settled=true;break;}
 if(!settled)throw new Error('CI recall vectors did not settle');
 const semantic=async()=>({vectors,provider:{...provider,embed:async()=>[1,0]}});
 const admission=sessionWriteAdmission({projectId:'project',machineId:'machine'},'session');
 const cortex=await recordSessionInjection(db,{projectId:'project'},'session','cortex',100,admission);
 if(cortex.outcome!=='recorded')throw new Error('CI cortex context refused '+JSON.stringify(cortex));
 for(const agent of ['placed','unplaced']){
  const recorded=await recordSessionInjection(db,{projectId:'project'},'session','cortex:'+agent,100,admission);
  if(recorded.outcome!=='recorded')throw new Error('CI session context refused '+JSON.stringify(recorded));
  if(agent==='placed')await capture('session','subagent.start',{subagentId:await subagentIdFor('session',agent),parentPromptId:uuid(20)});
 }
 const ask={sessionId:'session',promptId:uuid(20),askProtocol:'v1' as const,askedAt:500,admission,now:600,text:'baseline memory about selector ownership'};
 const leaves={...recallLeaves({}),injection:{enabled:true,maxPerPrompt:3}};
 const answer=await composePromptContext(db,{projectId:'project'},leaves,true,ask,semantic);
 if(!answer.receiptId)throw new Error('CI context did not produce a receipt '+JSON.stringify(answer));
 await capture('session','context.delivered',{receiptId:answer.receiptId,answerId:answer.answerId,renderedIn:uuid(20)});
 const duplicate=await composePromptContext(db,{projectId:'project'},leaves,true,{...ask,text:'different baseline memory about selector ownership',now:601},semantic);
 if(!duplicate.skipped.includes('spores:duplicate_prompt'))throw new Error('CI duplicate prompt was not refused '+JSON.stringify(duplicate));
 const unplaced=await composePromptContext(db,{projectId:'project'},leaves,true,{...ask,promptId:uuid(47999),text:'yet another baseline memory about selector ownership',now:602},semantic);
 if(!unplaced.receiptId)throw new Error('CI unplaced context did not produce a receipt '+JSON.stringify(unplaced));
 await capture('session','context.delivered',{receiptId:unplaced.receiptId,answerId:unplaced.answerId,renderedIn:uuid(47999)});
 const nudge=await composePromptContext(db,{projectId:'project'},{...leaves,planNudge:true,injection:{...leaves.injection,enabled:false}},true,{...ask,promptId:uuid(47998),text:'let us write the implementation plan for the selector',now:603},semantic);
 if(nudge.receiptId!==undefined||!nudge.answerId||nudge.context.length===0)throw new Error('CI receipt-free answer was not served '+JSON.stringify(nudge));
 await capture('session','context.delivered',{answerId:nudge.answerId,sessionRecord:nudge.sessionRecord,renderedIn:uuid(47998)});
 await capture('gone','session.start',{agent:'copilot',startedAt:100});
 await tombstoneSession(env,{projectId:'project'},'gone','member',800);
 const served=await servedPromptsForCI(db);
 const ack=await acknowledgements.acknowledgePrompt(db,{projectId:'project'},'run',{servedId:served[0]!.servedId},700);
 if(!('marked'in ack)||!ack.marked)throw new Error('CI acknowledgement refused '+JSON.stringify(ack));
 await releaseWork.releaseProvenance(db,deploymentSecretStore(db,serverEnvFromBindings({MYCO_DB:db,BUCKET:legacyBodyBlobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()}).wrappingKey)).save('project',{revision:null,enabled:true,githubRepo:'o/r',productionRefs:['refs/tags/a/v*'],integrationRefs:['origin/main'],packageMap:[],includeUnknown:true,maxLookups:50},'member',800);
 await releaseWork.checkProject(db,deploymentSecretStore(db,env.wrappingKey),fakeGithub(REPO),'project',900);
 await capture('session','plan',{planKey:uuid(48002),title:'propagated baseline plan',content:'baseline plan after classification',status:'active'});
 await capture('new-release','session.start',{agent:'copilot',startedAt:100,headSha:A});
 await capture('new-release','plan',{planKey:uuid(48003),title:'classified baseline plan',content:'baseline classified content',status:'active'});
 await capture('new-release','session.end',{endedAt:400,headSha:A,dirty:false});
 await seedLegacyCIEmbeddingStates(db,ctx);
 await capture('restored','session.start',{agent:'claude-code',startedAt:100},'import');
 const restored=[{prompt_identity_scheme:'claude-v1'},{prompt_identity_scheme:'claude-v2'},{}].map((pin,i)=>({t:'transcripts',r:{project_id:'project',transcript_id:'tx_'+String(i+1).padStart(32,'a'),session_id:'restored',machine_id:'machine',agent:'claude-code',size:100,segment_count:0,first_received_at:1,last_received_at:1,token_id:ctx.tokenId,parsed_offset:100,parser_version:5,parsed_at:1,role:'primary',...pin}}));
 await db.prepare("UPDATE agent_runs SET status='completed',completed_at=1000 WHERE project_id='project' AND id='run'").run();
 await restoreArtifact(db,{authorization:{kind:'recovery'},now:1000,text:[{format:BACKUP_FORMAT,deploymentId:await deploymentId(db),schemaVersion:89,createdAt:1,producer:'CI result fixture',counts:{transcripts:restored.length}},...restored].map(row=>JSON.stringify(row)).join('\n')});
 return {ctx,served};
}

export async function seedLegacyCISwitch(db:RelationalStore){
 await sessions.createProject(db,'ci-switch','ci-switch',1);
 await ensureAgent(db,{id:'fixture-agent',name:'fixture-agent',provider:null,model:null,enabled:true},1);
 const configured=await settings.settingsWriter(db,{target:'bun'}).setEmbedding({provider:'openai-compatible',model:'fixture-model',endpoint:'http://localhost:11434'},'member',1);
 if(!configured.applied)throw new Error('CI switch settings refused '+JSON.stringify(configured));
 await insertSpore(db,{projectId:'ci-switch'},{id:uuid(49900),agentId:'fixture-agent',sessionId:null,observationType:'decision',content:'baseline switch source',context:null,filePath:null,tags:null,contentHash:null,properties:null,author:'member',createdAt:100});
 const vectors=cloudflareVectorStore(indexFixture());
 const providerFor=(stored:Parameters<typeof resolveEmbedding>[0])=>{
  const selection=resolveEmbedding(stored,'bun').selection;
  if(selection===null)throw new Error('CI embedding choice did not resolve');
  return {modelKey:selection.modelKey,embed:async()=>[1,0]};
 };
 const prior=providerFor(await settings.storedEmbedding(db));
 await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider:prior},'ci-switch',1000);
 const baseEnv=serverEnvFromBindings({MYCO_DB:db,BUCKET:legacyBodyBlobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()});
 const env={...baseEnv,platform:{...baseEnv.platform,name:'bun' as const},vectors,embeddingProviderFor:async(stored:Parameters<typeof resolveEmbedding>[0])=>({provider:providerFor(stored),reason:null})};
 const started=await startEmbeddingSwitch(env,{provider:'ollama',model:'bge-m3'},'member',1000);
 if(!started.applied)throw new Error('CI model switch refused '+JSON.stringify(started));
 const sw=await switchWork.readSwitch(db);
 if(sw===null)throw new Error('CI model switch was not stored');
 const provider=providerFor(switchChoice(sw));
 let settled=false;
 for(let step=0;step<10;step++)if((await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider,retain:[prior.modelKey]},'ci-switch',1000)).processed===0){settled=true;break;}
 if(!settled)throw new Error('CI switch vectors did not settle');
}

export async function legacyCISwitchReads(db:RelationalStore,port:LegacyReadPort=currentReadPort){
 const sw=await switchWork.readSwitch(db);
 if(sw===null)throw new Error('CI model switch is missing');
 const choice=switchChoice(sw);
 if(resolveEmbedding(choice,'bun').selection?.modelKey!==sw.modelKey)throw new Error('CI switch model does not match its choice');
 const results:{name:string;value:unknown}[]=[];
 for(const [name,args]of [['switchProgress',[sw.modelKey]],['sourceTotals',[1000]],['switchComplete',[sw.modelKey,1000]]]as const)results.push({name,value:await port('switchStore',name,[db,...args])});
 const end=port('factory','prepareSwitchEnd',[db,sw,1000]);
 results.push({name:'switch-completion',value:await port('settings','writeSwitchedEmbedding',[db,choice,'member',1000,sw,end])});
 return results;
}

async function seedLegacyCIEmbeddingStates(db:RelationalStore,ctx:Awaited<ReturnType<typeof seedLegacyFixture>>){
 const vectors=cloudflareVectorStore(indexFixture()),provider={modelKey:'model',embed:async()=>[1,0]};
 for(const projectId of ['ci-uncovered','ci-lost','ci-failure','ci-journal']){
  await sessions.createProject(db,projectId,projectId,1);
  for(let i=0;i<(projectId==='ci-uncovered'||projectId==='ci-lost'?3:1);i++)await insertSpore(db,{projectId},{id:uuid(49000+i),agentId:'fixture-agent',sessionId:null,observationType:'decision',content:'CI embedding source '+i,context:null,filePath:null,tags:null,contentHash:null,properties:null,author:'member',createdAt:100});
  if(projectId==='ci-failure'){
   await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider:{modelKey:'model',embed:async()=>{throw new EmbeddingUnavailable('fixture input',{kind:'input',detail:'fixture input'});}}},projectId,1000);
  }else if(projectId==='ci-journal'){
   const failed=new Error('fixture vector write');
   try{await reconcileEmbedding({db,blobs:legacyBodyBlobs,provider,vectors:{...vectors,upsert:async(scope,items)=>{await vectors.upsert(scope,items);throw failed;}}},projectId,1000);throw new Error('CI vector failure did not occur');}catch(error){if(error!==failed)throw error;}
  }else{
   for(let i=0;i<3;i++)await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider},projectId,1000);
   if(projectId==='ci-lost'){
    await hubnessWork.reconcileHubness({db,blobs:legacyBodyBlobs,provider,vectors:{...vectors,get:async()=>[]}},projectId,86_401_000);
    await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider},projectId,86_401_001);
   }
  }
 }
 const failed=new Error('fixture vector delete');
 try{await reconcileEmbedding({db,blobs:legacyBodyBlobs,provider:{...provider,modelKey:'retained-other'},retireOnly:true,vectors:{...vectors,delete:async()=>{throw failed;}}},'m30-plan',1000);throw new Error('CI delete failure did not occur');}catch(error){if(error!==failed)throw error;}
}

async function servedPromptsForCI(db:RelationalStore){
 return served.recordServedPrompts(db,{projectId:'project'},'run',[{promptId:uuid(20),sessionId:'session',createdAt:102,endedAt:null},{promptId:uuid(21),sessionId:'session',createdAt:106,endedAt:null}],650);
}

/** Result witnesses use the same exact-base port as the finite CI strata. */
export async function legacyCIResultReads(db:RelationalStore,port:LegacyReadPort=currentReadPort){
 const results:{name:string;value:unknown}[]=[],scope={projectId:'project'};
 const call=async(name:string,namespace:string,operation:string,...args:unknown[])=>{const value=await port(namespace,operation,[db,...args]);results.push({name,value});return value;};
 await call('continuation','lineage','childIdsOf',scope,'continuation',['session'],2000);
 await call('launch','lineage','childIdsOf',scope,'launched',['session'],2000);
 for(const type of ['failure','no_result','continuation','child_session'])await call('activity-'+type,'sessionActivity','listSessionActivity',scope,'session',{type});
 await call('working','sessions','listSessions',scope,{window:'activity',since:0,now:1000,fidelity:'any'});
 await call('contexts','turns','sessionTurnContexts',scope,'session');
 await call('steering-counts','turns','listSteeringChildren',scope,'session',uuid(20));
 await call('unplaced','hookPlacement','listUnplacedHookRecords',scope,'session');
 for(const [project,session]of [[undefined,undefined],[scope,undefined],[undefined,'session'],[scope,'session']]as const)await call('unplaced-count-'+String(project?.projectId)+'-'+String(session),'hookPlacement','countUnplacedContextRecords',project,session,1000);
 await call('injected','injection','injectionForPrompt',scope,'session',uuid(20));
 await call('gone-counts','sessions','sessionCounts',scope,'gone');
 await call('bulk-counts','sessions','sessionCountsFor',scope,['session']);
 await call('untitled','children','untitledReason','project','ended');
 await call('ready-title','children','listReadyTitleSessions',200,1000);
 await call('title-candidates','children','listTitleCandidates',{retryBefore:0,idleBefore:900,freshAfter:50,refreshBefore:50,refreshPrompts:2,imported:false},200);
 await call('imported-title','children','listTitleCandidates',{retryBefore:0,idleBefore:900,freshAfter:50,refreshBefore:50,refreshPrompts:2,imported:true},200);
 await call('title-counts','children','countConvergenceTitleSessions',0,900);
 await call('imported-source','sessions','sessionsWithImportedPrompts',scope,['imported'],'claude-code');
 await call('acknowledged','coverage','hasAcknowledgedPrompts',scope,'session');
 for(const windowDays of [null,7])await call('KPIs-'+windowDays,'kpis','readKpis',{windowDays,now:1000});
 for(const operation of ['prepareLeavingHubness','prepareJoiningHubness','prepareMissingHubness','prepareHubnessPublication']){
  for(const project of ['m30-spore','m30-spore-stale','ci-uncovered','ci-lost']){
   const args=operation==='prepareMissingHubness'?[project,'model',0,'',20]:[project,'model',20];
   const statement=checkedPrepared(port('factory',operation,[db,...args]));
   results.push({name:operation+'-'+project,value:(await statement.all()).results});
  }
 }
 for(const project of ['m30-spore','m30-spore-stale','ci-uncovered','ci-lost']){
  await call('hubness-'+project,'hubness','missingSporeVectors',project,'model',1000);
  const work=port('hubness','prepareHubnessWork',[db,project,'model',1000]);
  if(!isPreparedIterable(work))throw new Error('Missing CI hubness work');
  for(const statement of work)results.push({name:'hubness-work-'+project,value:await statement.first()});
 }
 await call('calibration','hubness','calibrationPending','ci-uncovered','model',1000);
 await call('vector-ids','hubness','currentSporeVectorIds','ci-uncovered','model');
 await call('passed','reconcile','passedOverSources',['model'],1000,{limit:200,notArchived:true});
 await call('passed-unbuilt','reconcile','passedOverSources',['model'],1000,{limit:200,notArchived:true,unbuiltUnder:'model'});
 await call('failure-wake','reconcile','embeddingFailureWakeAt','ci-failure','model',1000);
 await call('retirement-wake','selection','embeddingWakeAt','m30-plan',['model'],1000);
 for(const phase of ['receipts','members'])await call('sweep-'+phase,'sweep','hubnessSweep','m30-spore','model',1000,phase==='receipts'?null:JSON.stringify({phase,a:'',b:'',count:2,min:null,max:null,uncovered:false}),true);
 const journal=await db.prepare("SELECT id,type,record_id,revision FROM embedding_receipts WHERE project_id=? AND model_key=? AND ready=0").bind('ci-journal','model').first<{id:string;type:string;record_id:string;revision:string}>();
 if(!journal)throw new Error('CI journal receipt is missing');
 results.push({name:'ready-receipt',value:await checkedPrepared(port('factory','prepareEmbeddingReadyReceipt',[db,['ci-journal','model',journal.id],'ci-journal',journal.type,journal.record_id,journal.revision])).run().then(row=>row.meta.changes)});
 const sources=(await db.prepare('SELECT project_id,type,record_id,revision FROM embedding_sources WHERE project_id IN (?, ?)').bind('m30-spore','m30-plan').all<{project_id:string;type:string;record_id:string;revision:string}>()).results;
 for(const row of sources)results.push({name:'source-'+row.record_id,value:await checkedPrepared(port('factory','prepareEmbeddingSource',[db,row.project_id,row.type,row.record_id,row.revision])).first()});
 await call('release','releaseWork','checkProject',deploymentSecretStore(db,serverEnvFromBindings({MYCO_DB:db,BUCKET:legacyBodyBlobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()}).wrappingKey),fakeGithub(REPO),'project',1000);
 return results;
}

export async function seedLegacyPublicFixture(db:RelationalStore){
 const fixture=await seedLegacyFixture(db);
 await ensureMember(db,'view-oracle-owner',1000,'admin');
 await linkStatement(db,'view-oracle-owner','922244').run();
 await bootstrapOwnership(db,'view-oracle-owner','view-oracle-owner','0',1000);
 return {token:fixture.token,cookie:await ownerCookie(db,1000,'922244')};
}
export function legacyPublicRequests(identity:{token:string;cookie:string}):Request[]{
 const session='/api/projects/project/sessions/session',prompt=uuid(20),requests:Request[]=[];
 const paths=['/api/kpis','/api/sessions','/api/search?q=baseline&mode=fts',session,session+'/turns?limit=1&cursor='+encodeURIComponent('102:'+prompt),session+'/turns',session+'/turns?limit=1',session+'/turns?cursor=invalid',session+'/turns?origins=',session+'/turns/'+prompt,
  session+'/turns/missing',session+'/activity',session+'/activity?type=tool',session+'/tools',
  '/api/projects/project/sessions','/api/projects/project/sessions?limit=1','/api/projects/project/activity',
  '/api/projects/other/sessions/session','/api/projects/project/search?q=baseline&mode=fts',
  ...['prompts','unplaced','tool-calls','responses','plans','attachments','context-injections'].flatMap(child=>[session+'/'+child,session+'/'+child+'?limit=1']),
  ...['responses','attachments','plans','answers'].map(child=>session+'/turns/'+prompt+'/'+child)];
 for(const path of paths)requests.push(new Request('https://s'+path,{headers:{cookie:identity.cookie,'cf-connecting-ip':'1.2.3.4'}}));
 for(const [name,args]of [
  ['myco_sessions',{op:'get',id:'session'}],['myco_sessions',{op:'list'}],['myco_sessions',{op:'get',id:'missing'}],
  ['myco_plans',{op:'get',id:uuid(50)}],['myco_plans',{op:'list'}],['myco_plans',{op:'get',id:'missing'}],
  ['myco_search',{query:'baseline',mode:'fts'}],
 ]as const)requests.push(new Request('https://s/mcp',{method:'POST',headers:memberHeaders(identity.token,{'x-myco-project':'project','content-type':'application/json',accept:'application/json, text/event-stream'}),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{project:'project',...args}}})}));
 return requests;
}
export function legacyPublicServer(db:RelationalStore,oracle?:FrozenOracle){
 const env=serverEnvFromBindings({MYCO_DB:db,BUCKET:memoryBlobStore(),SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter(),...OWNER_ENV});
 const deps={now:()=>1000,sourceOf:()=> '1.2.3.4',fetchImpl:noOutboundFetch};
 const factory=oracle===undefined?createServer:Reflect.get(oracle.namespace('pipeline'),'createServer');
 if(typeof factory!=='function')throw new Error('Missing frozen public server');
 const server:unknown=Reflect.apply(factory,undefined,[deps]);
 if(typeof server!=='object'||server===null||!('handleRequest'in server)||typeof server.handleRequest!=='function')throw new Error('Invalid frozen public server');
 const request=server.handleRequest;
 return (input:Request):Promise<Response>=>Reflect.apply(request,server,[input,env]);
}

export type LegacyReadPort = (namespace:string,name:string,args:unknown[])=>unknown;
const currentPrefixes:Readonly<Record<string,string>>={turns:'turns_',children:'children_',sessions:'sessions_',lineage:'lineage_',activity:'activity_',sessionActivity:'session_activity_',hookPlacement:'hook_placement_',plans:'plans_',receiptPlans:'',prompts:'prompts_',coverage:'extraction_coverage_',kpis:'kpis_',embedding:'embedding_',searchIndex:'core_search_index_',selection:'core_embedding_selection_',sweep:'core_embedding_work_sweep_',reconcile:'core_embedding_reconcile_',hubness:'core_embedding_hubness_',switchStore:'core_embedding_switch_store_'};
function callable(value:unknown,label:string):(...args:unknown[])=>unknown {
 if(typeof value!=='function')throw new Error('Unknown canonical read '+label);
 return (...args)=>Reflect.apply(value,undefined,args);
}
export const currentReadPort:LegacyReadPort=(namespace,name,args)=>{
 if(namespace==='releaseWork')return callable(Reflect.get(releaseWork,name),name)(...args);
 if(namespace==='switchWork')return callable(Reflect.get(switchWork,name),name)(...args);
 if(namespace==='embeddingWork')return callable(Reflect.get(embeddingWork,name),name)(...args);
 if(namespace==='hubnessWork')return callable(Reflect.get(hubnessWork,name),name)(...args);
 if(namespace==='injection')return callable(Reflect.get(injection,name),namespace+'.'+name)(...args);
 if(namespace==='acknowledgements')return callable(Reflect.get(acknowledgements,name),name)(...args);
 if(namespace==='served')return callable(Reflect.get(served,name),name)(...args);
 if(namespace==='searchIndex'&&name==='reconcileSearchIndex')return callable(Reflect.get(searchIndex,name),name)(...args);
 if(namespace==='settings')return callable(Reflect.get(settings,name),name)(...args);
 if(namespace==='hubness'&&name==='prepareHubnessWork')return callable(ownedReads.prepareHubnessWork,name)(...args);
 if(namespace==='hubness'&&name==='currentSporeVectorIds')return callable(ownedReads.currentSporeVectorIds,name)(...args);
 if(namespace==='processed')return name==='processedBody'?callable(processedBody,namespace+'.'+name)(...args):callable(Reflect.get(ownedReads,'processed_'+name),namespace+'.'+name)(...args);
 if(namespace==='children'&&name==='rowsByPrompt')return callable(ownedReads.childrenRowsByPrompt,name)(...args);
 if(namespace==='children'&&name==='turnChildPage')return callable(ownedReads.turnChildPage,name)(...args);
 if(namespace==='hubness'&&name==='countCurrentSporeVectors')return callable(ownedReads.countCurrentSporeVectors,name)(...args);
 const symbol=(currentPrefixes[namespace]??'')+name;
 return callable(Reflect.get(ownedReads,symbol),namespace+'.'+name)(...args);
};
export function frozenReadPort(oracle:FrozenOracle):LegacyReadPort {
 return (namespace,name,args)=>{
  if(namespace==='factory')return frozenFactory(oracle,name,args);
  if(namespace==='settings'&&name==='writeSwitchedEmbedding'){
   const [db,choice,actor,now,sw,end]=args;
   const condition=callable(Reflect.get(oracle.namespace('switchStore'),'completionCondition'),'completionCondition')(sw,now);
   return callable(Reflect.get(oracle.namespace('settings'),name),name)(db,choice,actor,now,condition,end);
  }
  if(namespace==='hubness'&&name==='prepareHubnessWork'){
   const [db,...rest]=args;
   const rows=callable(Reflect.get(oracle.namespace('hubness'),'hubnessQueries'),name)(...rest);
   if(!Array.isArray(rows))throw new Error('Frozen hubness queries missing');
   return function*(){for(const row of rows){if(typeof row!=='object'||row===null||!('sql'in row)||typeof row.sql!=='string'||!('binds'in row)||!Array.isArray(row.binds))throw new Error('Invalid frozen hubness query');yield checkedStore(db).prepare(row.sql).bind(...row.binds)}}();
  }
  if(namespace==='hubness'&&name==='currentSporeVectorIds'){
   const [db,projectId,model]=args,sql=Reflect.get(oracle.namespace('hubness'),'CURRENT_SPORE_VECTORS');
   if(typeof sql!=='string')throw new Error('Invalid frozen current spore vectors');
   return checkedStore(db).prepare(sql+' ORDER BY r.id').bind(projectId,model).all<{id:string}>().then(row=>row.results.map(row=>row.id));
  }
  if(namespace==='hubness'&&name==='countCurrentSporeVectors'){
   const [db,projectId,model,covered]=args,sql=Reflect.get(oracle.namespace('hubness'),covered?'CURRENT_SPORE_VECTORS':'SPORE_VECTORS');
   if(typeof sql!=='string')throw new Error('Invalid frozen vector source');
   return checkedStore(db).prepare('SELECT COUNT(*) AS n FROM ('+sql+')').bind(projectId,model).first<{n:number}>().then(row=>row!.n);
  }
  const aliases:Readonly<Record<string,string>>={releaseWork:'release',switchWork:'switchStore',embeddingWork:'reconcile',hubnessWork:'hubness'};
  const space=oracle.namespace(aliases[namespace]??namespace);
  if(namespace==='receiptPlans')return callable(Reflect.get(space,'receiptPlans'),'receiptPlans')(...args);
  if(namespace==='children'&&(name==='rowsByPrompt'||name==='turnChildPage')){
   const [db,scope,sessionId,kind,rowsOrOptions,limit]=args;
   const descriptors:Readonly<Record<string,string>>={response:'RESPONSE_QUERY',attachment:'ATTACHMENT_QUERY',plan:'TURN_PLAN_QUERY',answer:'ANSWER_QUERY'};
   const descriptor=Reflect.get(oracle.namespace(kind==='answer'?'turns':'children'),descriptors[String(kind)]!);
   return name==='rowsByPrompt'?callable(Reflect.get(space,'listChildrenByPrompt'),name)(db,descriptor,scope,sessionId,rowsOrOptions,limit):callable(Reflect.get(space,'listChildren'),name)(db,descriptor,scope,sessionId,rowsOrOptions);
  }
  return callable(Reflect.get(space,name),namespace+'.'+name)(...args);
 };
}
const rowIds=(count:number,first:string)=>Array.from({length:count},(_,i)=>i===0?first:uuid(100+i-1));
const absentBlobs={get:async()=>{throw new Error('Unexpected canonical blob read')},put:async()=>{throw new Error('Unexpected canonical blob write')},delete:async()=>{throw new Error('Unexpected canonical blob delete')},head:async()=>{throw new Error('Unexpected canonical blob head')}};
export async function executeReadVariant(db:RelationalStore,variant:LegacyVariant,port:LegacyReadPort=currentReadPort):Promise<unknown>{
 const v=variant.case,scope={projectId:v.membership==='wrong-project'||v.key==='wrong-project'||v.session==='wrong-project'?'other':'project'},sessionId=v.session==='missing'?'missing':'session';
 const call=(namespace:string,name:string,...args:unknown[])=>port(namespace,name,args);
 const read=(namespace:string,name:string,...args:unknown[])=>call(namespace,name,db,...args);
 const cursor=v.cursor==='next'?'101:'+uuid(20):undefined;
 switch(variant.family){
  case 'M01':return read('turns','listTurns',scope,sessionId,{order:v.order,cursor,origins:v.origins==='default-user'?undefined:v.origins==='empty-no-SQL'?[]:String(v.origins).split('+'),...(v.target==='prompt-root'?{promptId:uuid(20)}:{})});
  case 'M02':return read('turns',v.operation==='promptInSession'?'promptInSession':'turnDetail',scope,sessionId,v.membership==='missing'?'missing':uuid(20));
  case 'M03':{
   const count=v.list==='empty'?0:v.list==='1'?1:v.list==='90'?90:91,ids=rowIds(count,bodyWorldId(v.storage,'prompt'));
   if(v.stage==='prompt-body'||v.stage==='tool')return read('turns','readTurnBodies',scope,sessionId,ids);
   if(v.stage==='receipt-plans')return read('receiptPlans','receiptPlans',scope,ids.map((id,i)=>({receiptId:'receipt-'+i,planIds:[id]})));
   return read('children','rowsByPrompt',scope,sessionId,v.stage==='turn-plan'?'plan':v.stage,ids,200);
  }
  case 'M04':{
   const kind=String(v.descriptor),opts={cursor,...(v.promptFilter==='present'?{promptId:uuid(20)}:{}),...(v.status==='present'?{status:'active'}:{}),...(v.q==='present'?{q:'baseline'}:{})};
   if(v.shape==='by-prompt')return read('children','rowsByPrompt',scope,sessionId,{RESPONSE_QUERY:'response',ATTACHMENT_QUERY:'attachment',TURN_PLAN_QUERY:'plan',ANSWER_QUERY:'answer'}[kind], [uuid(20)],200);
   if(kind==='TURN_PLAN_QUERY'||kind==='ANSWER_QUERY')return read('children','turnChildPage',scope,sessionId,kind==='TURN_PLAN_QUERY'?'plan':'answer',opts);
   const method:Readonly<Record<string,string>>={PROMPT_QUERY:'listPrompts',TOOL_CALL_QUERY:'listToolCalls',RESPONSE_QUERY:'listResponses',PLAN_QUERY:'listPlans',CONTEXT_INJECTION_QUERY:'listContextInjections',ATTACHMENT_QUERY:'listAttachments'};
   return read('children',method[kind]!,scope,sessionId,opts);
  }
  case 'M05':return read('turns','listSteeringChildren',scope,sessionId,uuid(20),{cursor});
  case 'M06':return v.correlated===true?read('turns','readTurnBodies',scope,sessionId,[uuid(20)]):read('turns','toolUsage',scope,sessionId,...(v.byPrompt===true?[uuid(20)]:[]));
  case 'M07':return read('turns','sessionTurnContexts',scope,v.promptList==='empty'?'missing':sessionId);
  case 'M08':return read('hookPlacement','listUnplacedHookRecords',scope,sessionId,{cursor});
  case 'M09':return read('plans','getPlan',scope,v.key==='missing'?'missing':uuid(50),{summary:v.projection==='summary'});
  case 'M10':return read('plans','planInSession',scope,sessionId,v.winner==='missing'?'missing':uuid(50));
  case 'M11':return read('sessions','sessionCounts',scope,sessionId);
  case 'M12':return read('sessions','getSession',scope,sessionId,1000);
  case 'M15':return read('sessions','sessionCountsFor',scope,rowIds(Number(v.arity),'session'));
  case 'M16':{
   const held=read('sessions','instantStatements',scope,rowIds(Number(v.arity),'session'));
   if(!isPreparedRead(held))throw new Error('Invalid instant preparation');
   return held.parse(held.statements.length===0?[]:await db.batch(held.statements));
  }
  case 'M17':return read('sessions','projectStats',scope,1000);
  case 'M18':{
   const ids=rowIds(Number(v.arity),'session');
   return v.operation==='sessionsNamed'?read('lineage','sessionsNamed',scope,ids):read('lineage','childIdsOf',scope,v.operation==='childIdsOf-launched'?'launched':'continuation',ids,2000);
  }
  case 'M19':return read('activity','activityFeed',scope,{limit:v.page==='max'?200:1,...(v.page==='empty'?{before:0}:{})});
  case 'M20':return read('sessionActivity','listSessionActivity',scope,sessionId,{type:v.statement==='tool-discovery'?undefined:v.statement==='tool-page'?v.type:v.edge,cursor,...(v.toolFilter===true?{tool:'Read'}:{})});
  case 'M21':return read('hookPlacement','countUnplacedContextRecords',String(v.scope).includes('project')?scope:undefined,String(v.scope).includes('session')?sessionId:undefined,1000);
  case 'M22':{
   if(v.statement==='listReadyTitleSessions')return read('children','listReadyTitleSessions',200,1000);
   if(v.statement==='untitledReason')return read('children','untitledReason',scope.projectId,sessionId);
   if(v.statement==='countOwed')return read('children','countConvergenceTitleSessions',0,900);
   return read('children','listTitleCandidates',{retryBefore:0,idleBefore:900,freshAfter:50,refreshBefore:50,refreshPrompts:2,imported:v.origin==='imported'},200);
  }
  case 'M23':return read('children',v.operation==='materialRows-DESC'?'sessionMaterialTailRows':'sessionMaterialRows',scope.projectId,sessionId,{limit:v.limit==='1'?1:v.limit==='max'?200:50,excerptChars:100});
  case 'M26':{
   const kind=v.kind==='attachment-companion'?'attachment':String(v.kind),id=bodyWorldId(v.storage,kind),env={db,blobs:legacyBodyBlobs};
   return v.stage==='field'?call('processed','processedField',env,scope,kind,id):call('processed','processedBody',env,scope,kind,id);
  }

  case 'M27':return v.statement==='searchBacklog'?read('searchIndex','searchBacklog'):read('searchIndex','pendingSearchBlobs',v.reach==='deployment'?undefined:v.reach==='project'?'project':projectsFor(String(v.reach)));
  case 'M28':return v.stage==='next-source'?checkedPrepared(read('factory','prepareNextSearchBlob')).first():read('searchIndex','reconcileSearchIndex',legacyBodyBlobs,1000);
  case 'M29':{
   const hits=rowIds(Number(v.arity),'vector-0').map((id,i)=>({id,score:1-i/1000}));
   return read('embedding','semanticHits',scope,{provider:{modelKey:'model'},vectors:{query:async()=>hits}},[1,0],{topK:100,minScore:0,preview:v.preview===true,filters:{type:v.source}});
  }
  case 'M30':{
   const applicability=legacyApplicability(variant);
   if(!applicability.applicable)throw new Error('N/A census case '+variant.id+': '+applicability.reason);
   const producer=String(v.producer),consumer=String(v.consumer),source=String(v.source);
   const stale=(producer==='currentSource'&&consumer!=='M34')||producer==='currentMember';
   const projectId='m30-'+source+(stale?'-stale':''),worldScope={projectId};
   const invoke=(sink:string,namespace:string,name:string,...args:unknown[])=>{
    if(sink!==applicability.sink)throw new Error('Wrong final sink for '+variant.id+': '+sink);
    return read(namespace,name,...args);
   };
   if(producer==='embeddingSourceSelect'){
    const receipts=await db.prepare('SELECT id FROM embedding_receipts WHERE project_id = ? AND model_key = ? AND type = ? ORDER BY record_id').bind(projectId,'model',source).all<{id:string}>();
    return invoke('M29','embedding','semanticHits',worldScope,{provider:{modelKey:'model'},vectors:{query:async()=>receipts.results.map(({id})=>({id,score:1}))}},[1,0],{topK:100,minScore:0,preview:true,filters:{type:source}});
   }
   if(consumer==='M31')return producer==='eligibleSource'
    ?checkedPrepared(invoke('M31','factory','prepareEmbeddingSelection',projectId,source,'unbuilt-model',1000,true)).first()
    :invoke('M31','selection','retiringReceipt',projectId,['model'],1000);
   if(consumer==='M32'){
    const phase=producer==='eligibleSource'?'sources':producer==='currentSource'?'receipts':'members';
    const saved=JSON.stringify({phase,a:'',b:'',count:0,min:null,max:null,uncovered:false});
    return producer==='currentMember'?invoke('M32','sweep','hubnessSweep',projectId,'model',1000,saved,true):invoke('M32','sweep','embeddingSweep',projectId,['unbuilt-model'],['model'],1000,saved);
   }
   if(producer==='currentMember'){
    const statements=invoke('M34','hubness','prepareHubnessWork',projectId,'model',1000);
    if(!isPreparedIterable(statements))throw new Error('Invalid hubness preparations');
    const result=[];for(const statement of statements)result.push(await statement.first());return result;
   }
   return invoke('M34','hubness','countCurrentSporeVectors',projectId,'model',false);
  }
  case 'M31':{
   const models=v.modelPosition==='no-models'?[]:v.modelPosition==='middle'?['a','z']:v.modelPosition==='lower-open'?['z']:['a'];
   const query=String(v.query);
   if(query.startsWith('retirement-')||query.startsWith('deletion-'))return read('selection','retiringReceipt',scope.projectId,models,1000);
   if(query==='unwritten')return checkedPrepared(read('factory','prepareEmbeddingUnwritten',scope.projectId,'model',1000)).first();
   if(query.startsWith('source-selection-'))return checkedPrepared(read('factory','prepareEmbeddingSelection',scope.projectId,v.source,'model',1000,query.endsWith('stale'))).first();
   return read('selection','embeddingWakeAt',scope.projectId,models,1000);
  }
  case 'M32':{
   const receipt=v.sweep==='embedding-receipts'||v.sweep==='spore-receipts',phase=v.sweep==='hubness-members'?'members':receipt?'receipts':'sources';
   const saved=JSON.stringify({phase,a:v.cursor==='resume'?'model':'',b:v.cursor==='resume'?'id':'',count:0,min:null,max:null,uncovered:false});
   return String(v.sweep).startsWith('embedding-')?read('sweep','embeddingSweep',scope.projectId,v.current===true?['model']:[],['model'],1000,saved):read('sweep','hubnessSweep',scope.projectId,'model',1000,saved,v.current===true);
  }
  case 'M33':{
   if(String(v.statement).startsWith('passed-over-'))return read('reconcile','passedOverSources',['model'],1000,{limit:200,notArchived:v.notArchived===true,...(v.unbuiltUnder===true?{unbuiltUnder:'model'}:{})});
   if(v.statement==='failure-wake')return read('reconcile','embeddingFailureWakeAt',scope.projectId,'model',1000);
   if(v.statement==='source-selection')return checkedPrepared(read('factory','prepareEmbeddingSelection',scope.projectId,v.source,'model',1000,v.stale===true)).first();
   if(v.statement==='source-hydration')return checkedPrepared(read('factory','prepareEmbeddingSource',scope.projectId,v.source,'missing','revision')).first();
   return checkedPrepared(read('factory','prepareEmbeddingReadyReceipt',[scope.projectId,'model','missing'],scope.projectId,v.source,'missing','revision')).run().then(result=>({changes:result.meta.changes}));
  }
  case 'M34':{
   if(v.statement==='missingSporeVectors')return read('hubness','missingSporeVectors',scope.projectId,'model',1000);
   if(v.statement==='hasPair')return read('hubness','calibrationPending',scope.projectId,'model',1000);
   if(v.statement==='hubnessQueries'){
    const statements=read('hubness','prepareHubnessWork',scope.projectId,'model',1000);
    if(!isPreparedIterable(statements))throw new Error('Invalid hubness preparations');
    const result=[];for(const statement of statements)result.push(await statement.first());return result;
   }
   if(v.statement==='tally')return v.ready===true&&v.member==='joining'?read('hubness','currentSporeVectorIds',scope.projectId,'model'):read('hubness','countCurrentSporeVectors',scope.projectId,'model',v.ready===true);
   const name=v.statement==='publish'?'prepareHubnessPublication':v.statement==='leftOut'?'prepareMissingHubness':v.member==='leaving'?'prepareLeavingHubness':'prepareJoiningHubness';
   const args=name==='prepareMissingHubness'?[scope.projectId,'model',0,v.cursor==='resume'?'id':'',20]:[scope.projectId,'model',20];
   const held=checkedPrepared(read('factory',name,...args));
   return name==='prepareHubnessPublication'?held.first():held.all().then(result=>result.results);
  }
  case 'M35':{
   if(v.statement==='sourceTotals')return read('switchStore','sourceTotals',1000);
   if(v.statement==='switchProgress')return read('switchStore','switchProgress','model');
   if(v.statement==='switchComplete')return read('switchStore','switchComplete','model',1000);
   if(v.statement==='completionCondition'){
    const sw={id:'switch',modelKey:'model'};
    const end=read('factory','prepareSwitchEnd',sw,1000);
    return read('settings','writeSwitchedEmbedding',{'embedding.provider':'workers-ai'},'member',1000,sw,end);
   }
   const held=read('factory','prepareSwitchEnd',{id:'switch',modelKey:'model'},1000);
   if(!Array.isArray(held)||!held.every(isPreparedStatement))throw new Error('Invalid switch preparation');
   return db.batch(held).then(results=>results.map(result=>({results:result.results,changes:result.meta.changes})));
  }
  case 'M40':{
   if(v.operation==='hasAcknowledgedPrompts')return read('coverage','hasAcknowledgedPrompts',scope,sessionId);
   const source=v.identity==='source'?'served':undefined,record=source??uuid(20),runId=v.ack==='wrong-run'?'other-run':'run';
   const held=checkedPrepared(read('factory',v.operation==='ack-source-resolution'?'prepareExtractionAckItem':'prepareRecordAcknowledgement',scope.projectId,runId,record,source,uuid(9999),1000));
   return v.operation==='ack-source-resolution'?held.first():held.run().then(result=>({changes:result.meta.changes}));
  }
  case 'M41':return read('served','recordServedPrompts',scope,'run',[{promptId:uuid(20),sessionId,createdAt:102,endedAt:null}],1000);
  case 'M44':{
   if(v.statement==='changedPaths')return checkedPrepared(read('factory','prepareReleasePaths',scope.projectId,sessionId)).all().then(result=>result.results);
   if(v.statement==='PATHS_MARK_SQL'||v.statement==='classifyProject')return checkedPrepared(read('factory','prepareReleaseCandidates',scope.projectId,v.pathWindow==='none'?0:1,scope.projectId+':sessions:',v.pathWindow==='changed'?'fingerprint':null,201)).all().then(result=>result.results);
   const fence=[scope.projectId,'missing-run','revision'];
   const held=v.statement==='propagateDerived'?read('factory','prepareReleasePropagation',scope.projectId,scope.projectId+':sessions:',1000,fence,200):read('factory','prepareReleaseClassification',scope.projectId,sessionId,scope.projectId+':sessions:'+sessionId,['unreleased','unknown','session',null,null,null,null,'{}',1000],1000,fence);
   if(!Array.isArray(held)||!held.every(isPreparedStatement))throw new Error('Invalid release preparation');
   return db.batch(held).then(results=>results.map(result=>({results:result.results,changes:result.meta.changes})));
  }
  case 'M46':{
   const rows=v.sessions==='empty'?[]:v.sessions==='one'?[{projectId:scope.projectId,sessionId}]:[{projectId:scope.projectId,sessionId},{projectId:'other',sessionId:'other'}];
   return checkedPrepared(read('factory','prepareRestoredSessionUnread',JSON.stringify(rows))).run().then(result=>({changes:result.meta.changes}));
  }
  case 'M36':return v.origin==='user'?read('prompts','extractionSourceSession',scope,uuid(20)):read('sessions','sessionsWithImportedPrompts',scope,[sessionId],String(v.origin));
  case 'M42':case 'M43':return read('kpis','readKpis',{windowDays:v.window==='all'?null:Number(v.window),now:1000});
  case 'M45':return v.operation==='hook-plan-summary'?read('plans','getPlan',scope,uuid(50),{summary:true}):read('injection','injectionForPrompt',scope,sessionId,v.naming==='missing'?'missing':uuid(20));
  case 'M47':{
   const count=v.receiptChunk==='empty'?0:v.receiptChunk==='one'?1:v.receiptChunk==='90'?90:91;
   return read('receiptPlans','receiptPlans',scope,rowIds(count,uuid(50)).map((id,i)=>({receiptId:'receipt-'+i,planIds:[v.winner==='missing'?'missing':id]})));
  }
 }
 throw new Error('Unmapped canonical variant '+variant.id);
}

function isPreparedStatement(value:unknown):value is PreparedStatement {
 return typeof value==='object'&&value!==null&&'bind'in value&&typeof value.bind==='function'&&'first'in value&&typeof value.first==='function'&&'all'in value&&typeof value.all==='function'&&'run'in value&&typeof value.run==='function';
}
function isPreparedIterable(value:unknown):value is Iterable<PreparedStatement>{return typeof value==='object'&&value!==null&&typeof Reflect.get(value,Symbol.iterator)==='function';}
function isPreparedRead(value:unknown):value is {statements:PreparedStatement[];parse:(rows:RunResult[])=>unknown}{
 return typeof value==='object'&&value!==null&&'statements'in value&&Array.isArray(value.statements)&&value.statements.every(isPreparedStatement)&&'parse'in value&&typeof value.parse==='function';
}
function checkedPrepared(value:unknown):PreparedStatement{
 if(!isPreparedStatement(value))throw new Error('Canonical factory did not prepare a statement');
 return value;
}

function frozenQuery(oracle:FrozenOracle,namespace:string,name:string,args:unknown[],db:RelationalStore):PreparedStatement{
 const result=callable(Reflect.get(oracle.namespace(namespace),name),name)(...args);
 if(typeof result!=='object'||result===null||!('sql'in result)||typeof result.sql!=='string'||!('binds'in result)||!Array.isArray(result.binds))throw new Error('Invalid frozen query '+name);
 return db.prepare(result.sql).bind(...result.binds);
}
function frozenFactory(oracle:FrozenOracle,name:string,args:unknown[]):unknown{
 const [db,projectId,...rest]=args;
 const prepare=(namespace:string,arm:number,values:Record<string,unknown>)=>callable(Reflect.get(oracle.namespace(namespace),'__oracle_'+name+'_'+arm),name)({db,projectId,...values});
 switch(name){
  case 'prepareNextSearchBlob':return prepare('searchIndex',0,{});
  case 'prepareEmbeddingUnwritten':return frozenQuery(oracle,'selection','unwrittenQuery',[projectId,...rest],checkedStore(db));
  case 'prepareEmbeddingSelection':return frozenQuery(oracle,'selection','sourceSelectionQuery',[projectId,...rest],checkedStore(db));
  case 'prepareEmbeddingSource':return prepare('reconcile',0,{type:rest[0],selected:{record_id:rest[1],revision:rest[2]}});
  case 'prepareEmbeddingReadyReceipt':{
   const [receipt,project,type,recordId,revision]=args.slice(1);
   return prepare('reconcile',0,{receipt,projectId:project,type,source:{record_id:recordId,revision}});
  }
  case 'prepareLeavingHubness':case 'prepareJoiningHubness':return prepare('hubness',0,{model:rest[0]});
  case 'prepareMissingHubness':return prepare('hubness',0,{model:rest[0],lostBefore:rest[1],probe:rest[2]});
  case 'prepareHubnessPublication':return prepare('hubness',0,{model:rest[0]});
  case 'prepareSwitchEnd':return callable(Reflect.get(oracle.namespace('switchStore'),'completionStatements'),name)(...args);
  case 'prepareRestoredSessionUnread':{
   if(typeof projectId!=='string')throw new Error('Invalid restored sessions');
   const entries:unknown=JSON.parse(projectId);
   if(!Array.isArray(entries))throw new Error('Invalid restored session list');
   return prepare('backup',0,{restoredSessions:new Map(entries.map((row,i)=>[i,row]))});
  }
  case 'prepareExtractionAckItem':case 'prepareRecordAcknowledgement':{
   const [runId,recordId,servedId,,now]=rest;
   return prepare('acknowledgements',0,{scope:{projectId},runId,target:{promptId:recordId},servedId,now});
  }
  case 'prepareReleasePaths':return prepare('release',0,{sessionId:rest[0]});
  case 'prepareReleaseCandidates':return prepare('release',0,{mapped:rest[0],fingerprint:rest[2]});
  case 'prepareReleaseClassification':{
   const [sessionId,identity,columns,now,fence]=rest;
   if(!Array.isArray(fence))throw new Error('Invalid release fence');
   const common={c:{sessionId},identity,columns,now,claim:{projectId:fence[0],runId:fence[1],revision:fence[2]}};
   return [prepare('release',1,common),...frozenDerived(oracle).map(([namespace,table,key])=>prepare('release',0,{...common,namespace,table,key}))];
  }
  case 'prepareReleasePropagation':{
   const [sessionPrefix,now,fence]=rest;
   if(!Array.isArray(fence))throw new Error('Invalid release propagation fence');
   return frozenDerived(oracle).map(([namespace,table,key])=>prepare('release',0,{sessionPrefix,now,claim:{projectId:fence[0],runId:fence[1],revision:fence[2]},namespace,table,key}));
  }
 }
 throw new Error('Unknown frozen preparation '+name);
}
function frozenDerived(oracle:FrozenOracle):string[][]{
 const value=Reflect.get(oracle.namespace('release'),'DERIVED');
 if(!Array.isArray(value)||!value.every(row=>Array.isArray(row)&&row.every(item=>typeof item==='string')))throw new Error('Invalid frozen release namespaces');
 return value;
}
function checkedStore(value:unknown):RelationalStore{
 if(typeof value!=='object'||value===null||!('prepare'in value)||typeof value.prepare!=='function'||!('batch'in value)||typeof value.batch!=='function')throw new Error('Invalid canonical store');
 const {prepare,batch}=value;
 return {prepare:sql=>prepare(sql),batch:statements=>batch(statements)};
}
