import {expect} from 'bun:test';
import {sessionCounts} from '@myco-server-worker/read/sessions.js';
import {statementRecorder,type RecordedStatement} from '../../helpers/statement-recorder.js';
import {withViewStores,captureViewSession} from './view-stores.js';
import {mirrorViewSession,publishMirroredSession,appendViewCostHistory,keepSurvivingFacts} from './view-instances.js';
import { LEGACY_ONLY_OPERATIONS, legacyProjection } from '@myco-server-worker/read/view-store.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { planEventWrite, type EventWrite } from '@myco-server-worker/ingest/events.js';
import { TRANSCRIPT_PRODUCER } from '@myco-server-worker/ingest/parse.js';
import { envelope, uuid } from './fixtures.js';
import { armPlanViolations, readTag, significantRead, type PlanRow } from '../../helpers/view-read-contract.js';
export { armPlanViolations } from '../../helpers/view-read-contract.js';

const legacyOnly = new Set<string>(LEGACY_ONLY_OPERATIONS);

export const COST_MATERIALS = [
  {table:'prompt_batches',key:'prompts',id:'prompt_id',kind:'prompt',slot:0},
  {table:'responses',key:'responses',id:'response_id',kind:'response',slot:1},
  {table:'tool_calls',key:'toolCalls',id:'tool_call_id',kind:'tool.use',slot:2},
  {table:'plans',key:'plans',id:'plan_key',kind:'plan',slot:3},
] as const;
export type CostMaterial = typeof COST_MATERIALS[number];

/** The ingest planner owns each event's admission, writes and result interpretation. */
export async function appendCostHistory(db:RelationalStore,value:{
  tokenId:string;projectId:string;sessionId:string;material:CostMaterial;from:number;through:number;
  idBase?:number;parser?:boolean;blobKey?:string;
}):Promise<string[]>{
  const {material,projectId,sessionId,tokenId,from,through}=value;
  const batchSize=8,recordIds:string[]=[];
  for(let start=from;start<through;start+=batchSize){
    const writes:EventWrite[]=[];
    for(let index=start;index<Math.min(start+batchSize,through);index++){
      const id=(value.idBase??1000000)+material.slot*100000+index*2;
      const recordId=uuid(id+1);
      recordIds.push(recordId);
      const parser=value.parser!==false;
      const body=(inline:Record<string,unknown>)=>value.blobKey===undefined?inline:{blob:value.blobKey};
      const payload=material.kind==='prompt'?{promptId:recordId,...body({text:'hidden history'}),origin:'user',...(parser?{claim:'owner',sourceKey:'history-'+index,sourceThread:sessionId,sourceRecord:'history-'+index}:{})}
        :material.kind==='response'?{responseId:recordId,...body({text:'hidden history'})}
        :material.kind==='tool.use'?{toolCallId:recordId,toolName:'Read',...body({input:{path:'hidden history'}}),success:true}
        :{planKey:recordId,...body({content:'hidden history'}),status:'active'};
      const planned=await planEventWrite(db,{projectId,machineId:'machine',tokenId,bodyBytes:1,now:1,...(parser?{writeOrigin:'server' as const}:{})},
        envelope({eventId:uuid(id),sessionId,kind:material.kind,payload,...(parser?{producer:TRANSCRIPT_PRODUCER}:{})}));
      if(!planned.ok)throw new Error('History admission refused '+JSON.stringify(planned));
      writes.push(planned.write);
    }
    const results=await db.batch(writes.flatMap(write=>write.statements));
    let offset=0;
    for(const write of writes){
      const result=write.interpret(results.slice(offset,offset+write.statements.length));
      offset+=write.statements.length;
      await write.releaseUnlinked?.();
      if(!result.persisted||result.projected!==true)throw new Error('History write refused '+JSON.stringify(result));
    }
  }
  return recordIds;
}

function bracketEnd(sql: string, start: number): number {
  let depth = 0, quote = '';
  for (let at = start; at < sql.length; at++) {
    const char = sql[at]!;
    if (quote !== '') {
      if (char === quote) {
        if (sql[at + 1] === quote) at++;
        else quote = '';
      }
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return at;
  }
  throw new Error('Unclosed capture arm');
}

const M21_AGGREGATE_OPERATION='M21:hook_placement_countUnplacedContextRecords:0';

const M21_OWNER_POINT_SQL=`(SELECT json_object('projectId', sv.project_id, 'sessionId', sv.session_id, 'legacy', sv.legacy,
    'fence', sv.fence, 'live', sv.live_instance,
    'instances', json((SELECT json_group_array(json_object('instanceId', vv.instance_id,
      'role', vv.role, 'precedence', vv.precedence, 'sessionId', vi.session_id,
      'state', vi.state, 'base', vi.base, 'parent', vi.parent_instance,
      'ready', NOT EXISTS (SELECT 1 FROM view_checkpoints cp LEFT JOIN transcripts t ON t.project_id=cp.project_id AND t.transcript_id=cp.transcript_id
        WHERE cp.project_id=vi.project_id AND cp.instance_id=vi.instance_id AND cp.session_id=vi.session_id
          AND (cp.parse_error IS NOT NULL OR cp.lost_context<>0 OR cp.parsed_offset<COALESCE(t.size,cp.parsed_offset)))))
      FROM view_visible vv LEFT JOIN view_instances vi ON vi.project_id = vv.project_id AND vi.instance_id = vv.instance_id
      WHERE vv.project_id = sv.project_id AND vv.session_id = sv.session_id))) FROM session_views sv WHERE sv.project_id=r.project_id AND sv.session_id=r.session_id)`;

function m21OwnerShape(capture:string):boolean{
 if(capture===M21_OWNER_POINT_SQL)return true;
 const tail=' ELSE '+M21_OWNER_POINT_SQL+' END)';
 if(!capture.startsWith('(CASE WHEN ')||!capture.endsWith(tail))return false;
 const choice=capture.slice('(CASE WHEN '.length,-tail.length);
 const literal="'(?:[^']|'')*'(?: \\|\\| char\\(0\\) \\|\\| '(?:[^']|'')*')*";
 const key="\\(r\\.project_id="+literal+" AND r\\.session_id="+literal+"\\)";
 if(new RegExp('^(?:'+key+')(?: OR '+key+')* THEN NULL$').test(choice))return true;
 const parameter=/json_each\((\?\d+)\)/.exec(choice)?.[1];
 if(parameter===undefined)return false;
 const match="json_extract(j.value,'$.projectId')=r.project_id AND json_extract(j.value,'$.sessionId')=r.session_id";
 return choice===`EXISTS(SELECT 1 FROM json_each(${parameter}) j WHERE ${match})
   THEN (SELECT json_extract(j.value,'$.capture') FROM json_each(${parameter}) j WHERE ${match})`;
}

/** M21 moves only placement predicates from WHERE into its COUNT filter. */
function m21AggregateArm(sql:string):string{
 const count=`SELECT COUNT(*) FILTER (WHERE NOT r.__myco_delivery_placed`;
 if(!sql.startsWith(count))throw new Error('Invalid M21 aggregate count');
 const sourceAt=sql.indexOf('FROM projects s CROSS JOIN (SELECT ');
 const metadata=`) AS n,
      json_group_array(json_object('projectId',r.project_id,'sessionId',r.session_id,'capture',json(r.__myco_delivery_capture))) AS __myco_aggregate_sources
      `;
 const before=sql.slice(count.length,sourceAt);
 const answer=before.startsWith(' AND NOT r.__myco_delivery_prompt_placed');
 if(before!==(answer?' AND NOT r.__myco_delivery_prompt_placed':'')+metadata)throw new Error('Invalid M21 aggregate carrier');
 const start=sourceAt+'FROM projects s CROSS JOIN '.length,end=bracketEnd(sql,start);
 const inner=sql.slice(start+1,end),marker=', created_at, ',projectionAt=inner.indexOf(marker);
 if(projectionAt<0)throw new Error('Missing M21 source projection');
 let at=projectionAt+marker.length,depth=0,quote='',from=-1;
 const fields:string[]=[];let fieldStart=at;
 for(;at<inner.length;at++){
  const char=inner[at]!;
  if(quote!==''){if(char===quote){if(inner[at+1]===quote)at++;else quote='';}}
  else if(char==="'"||char==='"'||char==='\`')quote=char;
  else if(char==='(')depth++;
  else if(char===')')depth--;
  else if(depth===0&&char===','){fields.push(inner.slice(fieldStart,at));fieldStart=at+2;}
  else if(depth===0&&inner.startsWith(' FROM ',at)){fields.push(inner.slice(fieldStart,at));from=at;break;}
 }
 if(from<0||fields.length!==(answer?3:2))throw new Error('Invalid M21 placement projection');
 const field=(index:number,name:string):string=>{
  const suffix=' AS '+name,value=fields[index]!;
  if(!value.endsWith(suffix))throw new Error('Invalid M21 placement alias');
  return value.slice(0,-suffix.length);
 };
 const capture=field(0,'__myco_delivery_capture');
 if(!m21OwnerShape(capture))throw new Error('Invalid M21 owner capture');
 const placed=field(1,'__myco_delivery_placed');
 const prompt=answer?field(2,'__myco_delivery_prompt_placed'):null;
 const restored=inner.slice(0,projectionAt)+', created_at'+inner.slice(from)
  +(prompt===null?'':'\n    AND NOT '+prompt)+'\n      AND NOT '+placed;
 return 'SELECT COUNT(*) AS n FROM projects s CROSS JOIN ('+restored+sql.slice(end);
}

/** Captured statements retain their original legacy selection as a complete arm. */
export function emptyReadSql(sql: string): string {
  if (sql === "SELECT value,\n    (SELECT value FROM schema_meta WHERE key = 'attention.view_read_refusal') AS __myco_status_refusal\n    FROM schema_meta WHERE key = 'version'") return "SELECT value FROM schema_meta WHERE key = 'version'";
  const tag = readTag(sql);
  if (tag === null) return sql;
  const text = significantRead(sql);
  if(text.includes('AS __myco_aggregate_sources')&&tag.operation!==M21_AGGREGATE_OPERATION)throw new Error('M21 aggregate rule cannot admit another operation');
  if (legacyOnly.has(tag.operation)) return text;
  if (tag.operation === 'M10:plans_planInSession:0' && text.startsWith('UPDATE plans ')) return text.replace(/ AND \(NOT EXISTS \(SELECT 1 FROM session_views sv[\s\S]*\) RETURNING plan_key$/, ' RETURNING plan_key');
  let arm = text;
  const prefix = 'COALESCE((WITH __myco_capture_scalar AS MATERIALIZED (';
  for (let start=arm.indexOf(prefix);start>=0;start=arm.indexOf(prefix)) {
    const valueStart=start+'COALESCE('.length;
    const valueEnd=bracketEnd(arm,valueStart);
    const end=bracketEnd(arm,start+'COALESCE'.length);
    let legacy=arm.slice(valueEnd+2,end).trim();
    let replaceStart=start,replaceEnd=end;
    if(arm.slice(Math.max(0,start-13),start)==='json_extract('){
      if(!legacy.startsWith("json_object('value', "))throw new Error('Invalid scalar legacy projection');
      legacy=legacy.slice("json_object('value', ".length,-1);
      replaceStart=start-13;replaceEnd=bracketEnd(arm,replaceStart+'json_extract'.length);
    }
    arm=arm.slice(0,replaceStart)+legacy+arm.slice(replaceEnd+1);
  }
  for(let start=arm.lastIndexOf('(CASE WHEN ');start>=0;start=arm.lastIndexOf('(CASE WHEN ',start-1)){
    const end=bracketEnd(arm,start),part=arm.slice(start,end+1),then=part.indexOf(' THEN '),otherwise=part.lastIndexOf(' ELSE ');
    if(then<0||otherwise<0)continue;
    const a=part.slice(then+6,otherwise),b=part.slice(otherwise+6,-5);
    if(a===b)arm=arm.slice(0,start)+a+arm.slice(end+1);
  }
  arm=arm.replace(/, NULL AS __myco_capture_context/g,'');
  if(tag.operation==='M47:receiptPlans:0'){
    arm=arm.replace(/,\n        CASE WHEN sv.session_id IS NOT NULL THEN [\s\S]*? END AS __myco_capture,\n        COALESCE\(p.session_id,sv.session_id\) AS __myco_owner/,'');
    arm=arm.replace(/LEFT JOIN session_views sv ON [\s\S]*?WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL OR sv.session_id IS NOT NULL/,'WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL');
  }
  if (arm.startsWith('WITH __myco_candidate AS NOT MATERIALIZED (')) {
    const start = arm.indexOf('(');
    arm = arm.slice(start + 1, bracketEnd(arm, start));
  } else if (arm.startsWith('SELECT ') && /NULL AS __myco_capture,(?:NULL AS __myco_owner,)? ?0 AS __myco_sentinel FROM \(/.test(arm)) {
    const start = arm.indexOf('FROM (') + 5;
    arm = arm.slice(start + 1, bracketEnd(arm, start));
  }
  if(['M15:sessions_countStatements:0','M16:sessions_instantStatements:0'].includes(tag.operation)&&arm.includes(', NULL AS __myco_capture, NULL AS __myco_owner, 0 AS __myco_sentinel FROM ')){
    arm=arm.slice(0,arm.indexOf('\n    UNION ALL SELECT')).replace(', NULL AS __myco_capture, NULL AS __myco_owner, 0 AS __myco_sentinel FROM ',' FROM ');
  }
  if(arm.includes('AS __myco_aggregate_sources'))arm=m21AggregateArm(arm);
  return arm.replaceAll(', d.session_id AS __myco_session', '').replaceAll(', t.session_id AS __myco_session', '');
}

/** Every aligned empty-world row must be data, including zero-result reads. */
export function emptyReadRows(rows: readonly unknown[] | undefined): readonly unknown[] | undefined {
  return rows?.map(row => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
    const projected = legacyProjection(Object.fromEntries(Object.entries(row)));
    if (projected === null) throw new Error('Empty-world read returned a publication sentinel');
    return projected;
  });
}

export function compareReadArms(input: {
  baseline: readonly PlanRow[]; legacy: readonly PlanRow[]; publication: readonly PlanRow[]; view: readonly PlanRow[];
  boundedNodes?: ReadonlyMap<number, { bound: number; maximum: number }>;
}): string[] {
  return armPlanViolations(input);
}

const scope={projectId:'project'},session='session';
const counts={prompts:1,responses:1,toolCalls:1,plans:1,attachments:0};
const histories=[400,1200,5000] as const;

async function countWork(db:RelationalStore,target:string){
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
  const result=await sessionCounts(observed.db,scope,session);
  await observed.drain();
  const queries=COST_MATERIALS.map(material=>{
    const suffix='SELECT COUNT(*) AS n FROM '+material.table+' WHERE project_id = ? AND session_id = ?';
    const query=observed.statements.find(row=>row.sql.endsWith(suffix));
    if(!query)throw new Error('Missing count arm '+material.table);
    return {material,query};
  });
  return {result,queries,statements:observed.statements};
}

async function explain(db:RelationalStore,query:Pick<RecordedStatement,'sql'|'binds'>):Promise<PlanRow[]>{
  return (await db.prepare('EXPLAIN QUERY PLAN '+query.sql).bind(...query.binds).all<PlanRow>()).results;
}

/** Scalar capture runs at its value, two role drivers and parent precedence. */
export async function deliveryProbeMultiplicity(db:RelationalStore,query:Pick<RecordedStatement,'sql'|'binds'>){
 const plan=(await db.prepare('EXPLAIN QUERY PLAN '+query.sql).bind(...query.binds).all<PlanRow>()).results,details=plan.map(row=>row.detail);
 const captures=query.sql.split("json_object('projectId', sv.project_id").length-1;
 const publications=(query.sql.match(/FROM session_views sv\b/g)??[]).length;
 const scalarDefinitions=query.sql.split('WITH __myco_capture_scalar AS MATERIALIZED (').length-1;
 const scalarRoleDrivers=2,parentPrecedenceCaptures=1;
 const scalarMultiplicity=1+scalarRoleDrivers+parentPrecedenceCaptures;
 const materializations=details.filter(detail=>detail==='MATERIALIZE __myco_capture_scalar').length;
 const captureEvaluations=captures-scalarDefinitions+scalarDefinitions*scalarMultiplicity;
 const searches=(alias:string)=>details.filter(detail=>new RegExp('^SEARCH '+alias+' USING ').test(detail));
 const probes={publication:searches('sv').length,visible:searches('vv').length,header:searches('vi').length,
  checkpoint:searches('cp').length,transcript:searches('t').filter(detail=>detail.includes('transcript_id=')).length};
 const errors:string[]=[];
 if(materializations!==scalarDefinitions*scalarMultiplicity)errors.push('scalar capture multiplicity');
 if(captures-scalarDefinitions!==1)errors.push('aggregate owner capture multiplicity');
 if(probes.publication!==captureEvaluations+publications-captures)errors.push('publication probe multiplicity');
 for(const name of ['visible','header','checkpoint','transcript'] as const)if(probes[name]!==captureEvaluations)errors.push(name+' probe multiplicity');
 for(const detail of details){
  if(/SCAN (?:view_[a-z_]+|vv|vi|cp)\b/.test(detail))errors.push('unbounded capture scan '+detail);
  if(/^SEARCH vv /.test(detail)&&!detail.includes('(project_id=? AND session_id=?)'))errors.push('visibility requires its exact owner '+detail);
  if(/^SEARCH vi /.test(detail)&&!detail.includes('(project_id=? AND instance_id=?)'))errors.push('header requires its instance '+detail);
  if(/^SEARCH cp /.test(detail)&&!(detail.includes('project_id=?')&&detail.includes('session_id=?')&&detail.includes('instance_id=?')))errors.push('checkpoint requires its instance '+detail);
 }
 return {errors,probes,captureExpressions:captures,publicationExpressions:publications,scalarDefinitions,scalarMultiplicity,materializations,captureEvaluations,plan};
}

function d1Reads(rows:readonly RecordedStatement[]):number{
  return rows.reduce((sum,row)=>{
    if(row.rowsRead===undefined)throw new Error('D1 rows_read missing');
    return sum+row.rowsRead;
  },0);
}

function hiddenRowCoefficient(plan:readonly PlanRow[]):number{
  const fact=plan.find(row=>/^SEARCH f USING (?:COVERING )?INDEX /.test(row.detail));
  if(!fact)throw new Error('Missing indexed fact range');
  const children=(id:number):PlanRow[]=>plan.filter(row=>row.parent===id).flatMap(row=>[row,...children(row.id)]);
  const probes=children(fact.parent).filter(row=>/^SEARCH fc USING (?:COVERING )?INDEX /.test(row.detail));
  expect(probes).toHaveLength(1);
  return 1+probes.length;
}

interface FrozenBound {coefficient:number;intercept:number;relative:number}
function withinLegacyBound(bound:FrozenBound,history:number,published:number,legacy:number):void{
  if(published>bound.coefficient*history+bound.intercept)throw new Error('H_legacy coefficient exceeded');
  if(published>2*legacy+bound.relative)throw new Error('H_legacy relative gate exceeded');
}

async function executeControl(db:RelationalStore,query:RecordedStatement,sql:string){
  const observed=statementRecorder(db,{accounting:'d1'});
  const controlSql=sql.replace(/^\/\*vs:[^*]+\*\//,'');
  const result=await observed.db.prepare(controlSql).bind(...query.binds).first<{n:number}>();
  await observed.drain();
  return {results:result===null?[]:[result],rowsRead:d1Reads(observed.statements)};
}

export async function convertedLegacyHistory(material:CostMaterial):Promise<void>{
  const bounds=new Map<string,FrozenBound>();
  let wholeRelative:number|undefined;
  const native=new Map<number,Awaited<ReturnType<typeof countWork>>>();
  for(const history of histories)await withViewStores(async(db,target)=>{
    const issued=await captureViewSession(db,'project',session,{parsedMaterial:true});
    await mirrorViewSession(db,{...scope,sessionId:session,instanceId:'live',state:'live'});
    await appendCostHistory(db,{...scope,sessionId:session,tokenId:issued.tokenId,material,from:0,through:history});
    const legacy=await countWork(db,target);
    expect(legacy.result).toEqual({...counts,[material.key]:history+1});
    await publishMirroredSession(db,scope.projectId,session,'live');
    const published=await countWork(db,target);
    expect(published.result).toEqual(counts);
    if(target==='native')native.set(history,published);
    else expect(published.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})))
      .toEqual(native.get(history)!.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})));
    for(const arm of published.queries){
      const plan=await explain(db,arm.query);
      const coefficient=arm.material===material?hiddenRowCoefficient(plan):0;
      if(target!=='D1')continue;
      const old=legacy.queries.find(row=>row.material===arm.material)!.query;
      const read=d1Reads([arm.query]),prior=d1Reads([old]);
      if(history===400)bounds.set(arm.material.table,{coefficient,intercept:read-coefficient*history,relative:read-2*prior});
      const bound=bounds.get(arm.material.table)!;
      expect(coefficient).toBe(bound.coefficient);
      withinLegacyBound(bound,history,read,prior);
      if(material.table==='prompt_batches'&&arm.material===material)expect(bound).toMatchObject({coefficient:2,intercept:10});
      console.info('VIEW_B4B_ARM',JSON.stringify({table:arm.material.table,growingTable:material.table,history,target,rowsRead:read,legacyRowsRead:prior,bound,plan,
        phase:'converted sessions until PR 8 cleanup'}));
      if(history===1200&&arm.material===material){
        const marker=new RegExp('FROM main\\.'+material.table+' f(?: INDEXED BY [a-z_]+)?\\n    WHERE ');
        const extra=arm.query.sql.replace(marker,match=>match+'(SELECT COUNT(*) FROM events cost WHERE cost.project_id=f.project_id AND cost.event_id=f.event_id)>=0 AND ');
        expect(extra).not.toBe(arm.query.sql);
        const control=await executeControl(db,arm.query,extra);
        expect(control.results).toEqual([{n:1}]);
        expect(control.rowsRead).toBeGreaterThan(read);
        expect(()=>withinLegacyBound(bound,history,control.rowsRead,prior)).toThrow('H_legacy coefficient exceeded');
      }
      if(history===1200&&arm.material!==material){
        const suffix='SELECT COUNT(*) AS n FROM '+arm.material.table;
        const leak="SELECT COUNT(*) FROM main."+material.table+" noise WHERE noise.project_id='project' AND noise.session_id='session'";
        const control=await executeControl(db,arm.query,arm.query.sql.replace(suffix,'SELECT COUNT(*) + ('+leak+') AS n FROM '+arm.material.table));
        expect(control.results).not.toEqual([{n:1}]);
        expect(()=>withinLegacyBound(bound,history,control.rowsRead,prior)).toThrow('H_legacy coefficient exceeded');
      }
    }
    if(target==='D1'){
      const read=d1Reads(published.statements),prior=d1Reads(legacy.statements);
      if(history===400)wholeRelative=read-2*prior;
      expect(read).toBeLessThanOrEqual(2*prior+wholeRelative!);
      console.info('VIEW_B4B_OPERATION',JSON.stringify({table:material.table,history,rowsRead:read,legacyRowsRead:prior,relative:wholeRelative}));
    }
  });
}

export interface CorpusReadBound {coefficient:number;intercept:number}
/** An unclassified fact contributes one range row; absent classification probes contribute no D1 row. */
export const SURVIVING_FACT_READ_COEFFICIENT=1;
export const HIDDEN_LEGACY_READ_COEFFICIENT=2;
export async function hiddenLegacyHistory(rows:number,bounds?:ReadonlyMap<string,CorpusReadBound>,calibrate?:(table:string,read:number)=>void):Promise<void>{
 return viewSideHistory({axis:'hidden legacy G',rows},bounds,calibrate);
}
export async function survivingFactHistory(rows:number,bounds?:ReadonlyMap<string,CorpusReadBound>,calibrate?:(table:string,read:number)=>void):Promise<void>{
 return viewSideHistory({axis:'surviving-fact R',rows},bounds,calibrate);
}
async function viewSideHistory(world:{axis:'hidden legacy G'|'surviving-fact R';rows:number},corpusBounds?:ReadonlyMap<string,CorpusReadBound>,calibrate?:(table:string,read:number)=>void):Promise<void>{
  const {rows}=world;
  const factsOnly=world.axis==='surviving-fact R';
  const native=new Map<number,Awaited<ReturnType<typeof countWork>>>();
  await withViewStores(async(db,target)=>{
    const issued=await captureViewSession(db,'project',session,{parsedMaterial:true});
    await captureViewSession(db,'project','nuisance',{idOffset:8000000});
    await captureViewSession(db,'other',session);
    const sources=[
      {...scope,sessionId:session,instanceId:'parent'},
      {...scope,sessionId:'nuisance',instanceId:'other-session'},
      {projectId:'other',sessionId:session,instanceId:'other-project'},
    ];
    await mirrorViewSession(db,{...sources[0]!,state:'frozen'});
    await mirrorViewSession(db,{...scope,sessionId:session,instanceId:'live',parent:'parent',state:'live'});
    for(const source of sources.slice(1))await mirrorViewSession(db,{...source,state:'retired'});
    for(const material of COST_MATERIALS){
      if(factsOnly||rows===0)await db.prepare('DELETE FROM '+material.table+' WHERE project_id=? AND session_id=?').bind(scope.projectId,session).run();
      await appendCostHistory(db,{...scope,sessionId:session,tokenId:issued.tokenId,material,from:0,through:factsOnly?rows:Math.max(0,rows-1),parser:!factsOnly});
    }
    await publishMirroredSession(db,scope.projectId,session,'live','parent');
    if(factsOnly)await keepSurvivingFacts(db,scope.projectId,session);
    const visible=1+(factsOnly?rows:0);
    const expected={...counts,prompts:visible,responses:visible,toolCalls:visible,plans:visible};
    const bound=new Map<string,number>();
    let previous=0,operationBound:number|undefined;
    for(const history of histories){
      await appendViewCostHistory(db,sources,previous,history);previous=history;
      const work=await countWork(db,target);
      expect(work.result,target+' H='+history).toEqual(expected);
      if(target==='native')native.set(history,work);
      else expect(work.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})))
        .toEqual(native.get(history)!.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})));
      for(const {material,query}of work.queries){
        const plan=await explain(db,query);
        if(target!=='D1'){
          console.info('VIEW_B4A_NATIVE',JSON.stringify({axis:world.axis,rows,history,table:material.table,plan}));
          continue;
        }
        const read=d1Reads([query]);
        if(history===400)bound.set(material.table,read);
        if(history===400)calibrate?.(material.table,read);
        const corpusBound=corpusBounds?.get(material.table);
        if(corpusBounds!==undefined&&rows>=5){
          if(corpusBound===undefined)throw new Error('Missing corpus calibration '+material.table);
          expect(read,material.table+' frozen '+world.axis+' slope').toBeLessThanOrEqual(corpusBound.coefficient*rows+corpusBound.intercept);
        }
        expect(read,material.table+' zero view-H coefficient').toBeLessThanOrEqual(bound.get(material.table)!);
        console.info('VIEW_B4A_ARM',JSON.stringify({axis:world.axis,rows,history,table:material.table,rowsRead:read,bound:bound.get(material.table),corpusBound,plan}));
        if(history===5000&&material.table==='prompt_batches'){
          const control=await executeControl(db,query,query.sql+" AND (SELECT COUNT(*) FROM main.view_prompts noise WHERE noise.project_id='project')>=0");
          expect(control.results).toEqual([{n:visible}]);
          expect(control.rowsRead).toBeGreaterThan(bound.get(material.table)!);
          if(corpusBound!==undefined&&rows>=50){
            const repeated=await executeControl(db,query,query.sql+" AND (SELECT COUNT(*) FROM main.prompt_batches noise WHERE noise.project_id='project' AND noise.session_id='session')>=0");
            expect(repeated.results).toEqual([{n:visible}]);
            expect(repeated.rowsRead,'one extra pass over the corpus').toBeGreaterThan(corpusBound.coefficient*rows+corpusBound.intercept);
          }
        }
      }
      if(target==='D1'){
        const read=d1Reads(work.statements);
        if(history===400)calibrate?.('operation',read);
        const corpusBound=corpusBounds?.get('operation');
        if(corpusBounds!==undefined&&rows>=5){
          if(corpusBound===undefined)throw new Error('Missing whole-operation corpus calibration');
          expect(read,'whole-operation frozen '+world.axis+' slope').toBeLessThanOrEqual(corpusBound.coefficient*rows+corpusBound.intercept);
        }
        if(history===400)operationBound=read;
        expect(read,'whole-operation zero view-H coefficient').toBeLessThanOrEqual(operationBound!);
      }
    }
  });
}

export async function foreignLegacyHistory():Promise<void>{
  const native=new Map<number,Awaited<ReturnType<typeof countWork>>>(),bounds=new Map<string,number>();
  for(const history of histories)await withViewStores(async(db,target)=>{
    await captureViewSession(db,'project',session,{parsedMaterial:true});
    await mirrorViewSession(db,{...scope,sessionId:session,instanceId:'live',state:'live'});
    await publishMirroredSession(db,scope.projectId,session,'live');
    for(const source of [{projectId:'project',sessionId:'nuisance',idOffset:8000000},{projectId:'other',sessionId:session,idOffset:0}]){
      const issued=await captureViewSession(db,source.projectId,source.sessionId,{idOffset:source.idOffset,parsedMaterial:true});
      await mirrorViewSession(db,{...source,instanceId:'foreign-live',state:'live'});
      for(const material of COST_MATERIALS)await appendCostHistory(db,{...source,tokenId:issued.tokenId,material,idBase:2000000,from:0,through:history/8});
      await publishMirroredSession(db,source.projectId,source.sessionId,'foreign-live');
    }
    const work=await countWork(db,target);
    expect(work.result).toEqual(counts);
    if(target==='native')native.set(history,work);
    else expect(work.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})))
      .toEqual(native.get(history)!.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method})));
    for(const {material,query}of work.queries){
      const plan=await explain(db,query);
      if(target!=='D1')continue;
      const read=d1Reads([query]);
      if(history===400)bounds.set(material.table,read);
      expect(read,'unrelated H cannot move '+material.table).toBeLessThanOrEqual(bounds.get(material.table)!);
      console.info('VIEW_B4A_FOREIGN',JSON.stringify({history,table:material.table,rowsRead:read,bound:bounds.get(material.table),plan}));
      if(history===1200){
        for(const leak of [
          "SELECT COUNT(*) FROM main."+material.table+" noise WHERE noise.project_id='project' AND noise.session_id='nuisance'",
          "SELECT COUNT(*) FROM main."+material.table+" noise WHERE noise.project_id='other' AND noise.session_id='session'",
        ]){
          const suffix='SELECT COUNT(*) AS n FROM '+material.table;
          const control=await executeControl(db,query,query.sql.replace(suffix,'SELECT COUNT(*) + ('+leak+') AS n FROM '+material.table));
          expect(control.results).not.toEqual([{n:1}]);
          expect(control.rowsRead).toBeGreaterThan(bounds.get(material.table)!);
        }
      }
    }
  });
}

/** Catalogue comparisons align only each program's declared schema stamp. */
export function activeCatalogueRows(rows:readonly unknown[]|undefined,version:number){
 return rows?.map(row=>typeof row==='object'&&row!==null&&'schema_version'in row&&row.schema_version===String(version)
  ? {...row,schema_version:'active-catalogue'}:row);
}

export {explain as explainReadPlan};

interface Plan {id:number;parent:number;detail:string;notused?:number}
interface SqlSpan {text:string;positions:readonly number[]}
const source=(text:string):SqlSpan=>({text,positions:Array.from({length:text.length},(_,i)=>i)});
const literal=(text:string):SqlSpan=>({text,positions:Array(text.length).fill(-1)});
const slice=(s:SqlSpan,begin:number,end=s.text.length):SqlSpan=>({text:s.text.slice(begin,end),positions:s.positions.slice(begin,end)});
const concat=(...parts:SqlSpan[]):SqlSpan=>({text:parts.map(p=>p.text).join(''),positions:parts.flatMap(p=>[...p.positions])});
const trim=(s:SqlSpan):SqlSpan=>slice(s,s.text.length-s.text.trimStart().length,s.text.trimEnd().length);
function replace(s:SqlSpan,pattern:RegExp,text:string):SqlSpan{
 let result=s;
 for(const match of [...s.text.matchAll(pattern)].reverse())result=concat(slice(result,0,match.index),literal(text),slice(result,match.index+match[0].length));
 return result;
}
const lexicalSql=()=>/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|[A-Za-z_][A-Za-z_0-9]*|[()]/g;
function closing(sql:string,start:number):number{
 if(sql[start]!=='(')throw new Error('SQL arm must begin at its opening parenthesis');
 let depth=0;
 for(const match of sql.slice(start).matchAll(lexicalSql())){
  if(match[0]==='(')depth++;
  else if(match[0]===')'&&--depth===0)return start+match.index;
 }
 throw new Error('Unclosed SQL source arm');
}
function aggregateLayout(arm:SqlSpan):SqlSpan{
 const start=arm.text.indexOf('FROM projects s CROSS JOIN ')+ 'FROM projects s CROSS JOIN '.length,end=closing(arm.text,start);
 const inner=slice(arm,start+1,end),marker=', created_at, ',projectionAt=inner.text.indexOf(marker);
 if(projectionAt<0)throw new Error('Missing aggregate source projection');
 let at=projectionAt+marker.length,fieldStart=at,depth=0,quote='';const fields:SqlSpan[]=[];
 for(;at<inner.text.length;at++){
  const char=inner.text[at]!;
  if(quote){if(char===quote){if(inner.text[at+1]===quote)at++;else quote='';}}
  else if(["'",'"','`'].includes(char))quote=char;
  else if(char==='(')depth++;
  else if(char===')')depth--;
  else if(depth===0&&char===','){fields.push(slice(inner,fieldStart,at));fieldStart=at+2;}
  else if(depth===0&&inner.text.startsWith(' FROM ',at)){fields.push(slice(inner,fieldStart,at));break;}
 }
 const field=(index:number,alias:string):SqlSpan=>{
  const value=fields[index],suffix=' AS '+alias;
  if(!value?.text.endsWith(suffix))throw new Error('Invalid aggregate placement field');
  return slice(value,0,value.text.length-suffix.length);
 };
 if(fields.length!==2&&fields.length!==3)throw new Error('Invalid aggregate placement count');
 const restored=concat(slice(inner,0,projectionAt),slice(inner,projectionAt,projectionAt+', created_at'.length),slice(inner,at),
  ...(fields.length===3?[literal('\n    AND NOT '),field(2,'__myco_delivery_prompt_placed')]:[]),literal('\n      AND NOT '),field(1,'__myco_delivery_placed'));
 const prefix='SELECT COUNT(*) AS n FROM projects s CROSS JOIN (';
 return concat({text:prefix,positions:Array.from(prefix,(_,index)=>index<6?arm.positions[index]!: -1)},restored,slice(arm,end));
}
/** Source positions select the unchanged ELSE expressions and original candidate arm. */
export function legacyLayout(sql:string,operation:string):SqlSpan{
 let arm=source(sql);const tag=/^\/\*vs:[^*]+\*\//.exec(sql);if(tag)arm=slice(arm,tag[0].length);
 const prefix='COALESCE((WITH __myco_capture_scalar AS MATERIALIZED (';
 for(let start=arm.text.indexOf(prefix);start>=0;start=arm.text.indexOf(prefix)){
  const valueEnd=closing(arm.text,start+'COALESCE('.length),end=closing(arm.text,start+'COALESCE'.length);
  let legacy=trim(slice(arm,valueEnd+2,end)),replaceStart=start,replaceEnd=end;
  if(arm.text.slice(Math.max(0,start-13),start)==='json_extract('){
   if(!legacy.text.startsWith("json_object('value', "))throw new Error('Invalid scalar legacy value');
   legacy=slice(legacy,"json_object('value', ".length,legacy.text.length-1);replaceStart=start-13;replaceEnd=closing(arm.text,replaceStart+'json_extract'.length);
  }
  arm=concat(slice(arm,0,replaceStart),legacy,slice(arm,replaceEnd+1));
 }
 for(let start=arm.text.lastIndexOf('(CASE WHEN ');start>=0;start=arm.text.lastIndexOf('(CASE WHEN ',start-1)){
  const end=closing(arm.text,start),part=slice(arm,start,end+1),then=part.text.indexOf(' THEN '),otherwise=part.text.lastIndexOf(' ELSE ');
  if(then<0||otherwise<0)continue;
  const yes=slice(part,then+6,otherwise),no=slice(part,otherwise+6,part.text.length-5);
  if(yes.text===no.text)arm=concat(slice(arm,0,start),no,slice(arm,end+1));
 }
 arm=replace(arm,/, NULL AS __myco_capture_context/g,'');
 if(operation==='M47:receiptPlans:0'){
  arm=replace(arm,/,\n        CASE WHEN sv.session_id IS NOT NULL THEN [\s\S]*? END AS __myco_capture,\n        COALESCE\(p.session_id,sv.session_id\) AS __myco_owner/g,'');
  arm=replace(arm,/LEFT JOIN session_views sv ON [\s\S]*?WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL OR sv.session_id IS NOT NULL/g,'WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL');
 }
 if(arm.text.startsWith('WITH __myco_candidate AS NOT MATERIALIZED (')){
  const start=arm.text.indexOf('(');arm=slice(arm,start+1,closing(arm.text,start));
 }else if(arm.text.startsWith('SELECT ')&&/NULL AS __myco_capture,(?:NULL AS __myco_owner,)? ?0 AS __myco_sentinel FROM \(/.test(arm.text)){
  const start=arm.text.indexOf('FROM (')+5;arm=slice(arm,start+1,closing(arm.text,start));
 }
 if(['M15:sessions_countStatements:0','M16:sessions_instantStatements:0'].includes(operation)&&arm.text.includes(', NULL AS __myco_capture, NULL AS __myco_owner, 0 AS __myco_sentinel FROM ')){
  arm=replace(slice(arm,0,arm.text.indexOf('\n    UNION ALL SELECT')),/, NULL AS __myco_capture, NULL AS __myco_owner, 0 AS __myco_sentinel FROM /g,' FROM ');
 }
 if(arm.text.includes('AS __myco_aggregate_sources')){
  if(operation!=='M21:hook_placement_countUnplacedContextRecords:0')throw new Error('Aggregate layout requires M21');
  arm=aggregateLayout(arm);
 }
 return replace(replace(arm,/, d.session_id AS __myco_session/g,''),/, t.session_id AS __myco_session/g,'');
}
interface SelectNode {start:number;end:number;id:number}
function selectLabels(sql:string):SelectNode[]{
 const tokens:{start:number;text:string;depth:number}[]=[];let depth=0;
 for(const match of sql.matchAll(lexicalSql())){
  const text=match[0];if(/^(?:["'`\[]|--|\/\*)/.test(text))continue;
  if(text===')')depth--;
  tokens.push({start:match.index,text:text.toUpperCase(),depth});if(text==='(')depth++;
 }
 const rows=tokens.flatMap((token,index)=>token.text==='SELECT'?[{start:token.start,end:tokens.slice(index+1).find(next=>next.depth<token.depth||next.depth===token.depth&&['UNION','EXCEPT','INTERSECT'].includes(next.text))?.start??sql.length,id:0}]:[]);
 [...rows].sort((a,b)=>a.end-b.end||b.start-a.start).forEach((row,index)=>{row.id=index+1;});return rows;
}
/** Every original SELECT retains one label; generated labels belong to the capture or published arm. */
export function partitionLegacyPlan(input:{sql:string;original:string;operation:string;baseline:readonly Plan[];candidate:readonly Plan[]}){
 const layout=legacyLayout(input.sql,input.operation);
 if(layout.text!==input.original)throw new Error('Legacy layout differs from independent SQL');
 const original=selectLabels(input.original),current=selectLabels(input.sql),byPosition=new Map(current.map(row=>[row.start,row.id]));
 const labels=new Map<number,number>();
 for(const row of original){
  const label=byPosition.get(layout.positions[row.start]!);
  if(label===undefined||labels.has(label))throw new Error('Original SELECT source position is not bijective');
  labels.set(label,row.id);
 }
 const windowCount=(text:string)=>{
  const tokens=[...text.matchAll(lexicalSql())].filter(match=>!/^(?:["'`\[]|--|\/\*)/.test(match[0])).map(match=>match[0].toUpperCase());let count=0;
  for(let index=0;index<tokens.length;index++)if(tokens[index]==='OVER'){
   if(tokens.slice(index-3,index+2).join(' ')!=='ROW_NUMBER ( ) OVER (')throw new Error('Unsupported window SELECT rewrite');count++;
  }
  return count;
 };
 if(windowCount(input.sql)!==windowCount(input.original))throw new Error('Window SELECT rewrite differs');
 for(let index=0;index<windowCount(input.original);index++)labels.set(current.length+index+1,original.length+index+1);
 const children=new Map<number,Plan[]>();for(const row of input.candidate)children.set(row.parent,[...(children.get(row.parent)??[]),row]);
 const omitted=new Set<number>(),remove=(row:Plan):void=>{omitted.add(row.id);for(const child of children.get(row.id)??[])remove(child);};
 const carrier=input.sql.includes('AS __myco_sentinel'),root=input.candidate[0];
 if(carrier&&root?.detail==='COMPOUND QUERY'){
  const parts=children.get(root.id)??[];
  if(parts.length!==2||parts[0]?.detail!=='LEFT-MOST SUBQUERY'||parts[1]?.detail!=='UNION ALL')throw new Error('Invalid capture compound shell');
  omitted.add(root.id);omitted.add(parts[0].id);remove(parts[1]);
  for(const row of input.candidate)if(row.parent===parts[0].id&&['CO-ROUTINE legacy','SCAN legacy','CO-ROUTINE __myco_candidate','SCAN __myco_candidate'].includes(row.detail))omitted.add(row.id);
 }
 for(const row of input.candidate){
  if(omitted.has(row.id))continue;
  const label=/(?:SCALAR|LIST) SUBQUERY (\d+)/.exec(row.detail);
  if(label&&!labels.has(Number(label[1])))remove(row);
  if(input.operation==='M47:receiptPlans:0'&&row.detail.startsWith('SEARCH sv '))omitted.add(row.id);
 }
 const legacy=input.candidate.filter(row=>!omitted.has(row.id)).map(row=>({...row,detail:row.detail.replace(/(subquery-|SUBQUERY )(\d+)/g,(_match,prefix:string,label:string)=>{
  const original=labels.get(Number(label));if(original===undefined)throw new Error('Unknown retained SELECT label '+label);return prefix+original;
 })}));
 return {baseline:input.baseline,legacy,omitted:input.candidate.filter(row=>omitted.has(row.id)),labels};
}
export function generatedSelectRoles(input:Parameters<typeof partitionLegacyPlan>[0],columns:string){
 const layout=legacyLayout(input.sql,input.operation),partition=partitionLegacyPlan(input),labels=selectLabels(input.sql);
 const normalize=(text:string)=>text.replace(/\s+/g,' ').trim();
 const oldSelects=new Set(selectLabels(input.original).map(row=>input.original.slice(row.start,row.end).trim()));
 const published:{start:number;end:number}[]=[],fallback:{start:number;end:number}[]=[],headers:{start:number;end:number}[]=[];
 const starts=new Set([...input.sql.matchAll(lexicalSql())].filter(match=>/^(?:COALESCE|JSON_OBJECT)$/i.test(match[0])).map(match=>match.index));
 const scalar='COALESCE((WITH __myco_capture_scalar AS MATERIALIZED (';
 for(let start=input.sql.indexOf(scalar);start>=0;start=input.sql.indexOf(scalar,start+1)){
  if(!starts.has(start))continue;
  const value=start+'COALESCE('.length,end=closing(input.sql,value),last=closing(input.sql,start+'COALESCE'.length);
  published.push({start:value,end});fallback.push({start:end+2,end:last});
 }
 for(let start=input.sql.indexOf(columns);start>=0;start=input.sql.indexOf(columns,start+columns.length))if(starts.has(start))headers.push({start,end:start+columns.length});
 const inside=(row:SelectNode,ranges:readonly{start:number;end:number}[])=>ranges.some(range=>row.start>=range.start&&row.end<=range.end);
 const originalPositions=layout.positions.filter(position=>position>=0),first=originalPositions.reduce((a,b)=>Math.min(a,b),Infinity),last=originalPositions.reduce((a,b)=>Math.max(a,b),-1);
 const core=input.sql.slice(first,last+1);
 const literal="'(?:[^']|'')*'(?: \\|\\| char\\(0\\) \\|\\| '(?:[^']|'')*')*";
 const sqlLiteral=new RegExp('^(?:'+literal+')$');
 const owner='(?:candidate\\.(?:session_id|__myco_session)|v\\.session_id|'+literal+')';
 const point=new RegExp('^SELECT @CAPTURE FROM session_views sv WHERE sv\\.project_id = '+literal+' AND sv\\.session_id = '+owner+'$');
 const ownerLookup=/^SELECT (?:v\.session_id|CASE WHEN v\.session_id IN \((?:[\s\S]*)\) THEN NULL ELSE v\.session_id END) FROM (view_prompts|view_responses|view_tool_calls|view_plans) v WHERE v\.project_id\s*=\s*([\s\S]+) AND v\.(prompt_id|response_id|tool_call_id|plan_key)\s*=\s*([\s\S]+) LIMIT 1$/;
 const ids:Record<string,string>={view_prompts:'prompt_id',view_responses:'response_id',view_tool_calls:'tool_call_id',view_plans:'plan_key'};
 function atomic(text:string):string|undefined{
  const body=normalize(text.replaceAll(columns,'@CAPTURE'));
  if(body==='SELECT 1 FROM __myco_candidate')return '@ANTI';
  if(point.test(body))return '@POINT';
  if(body==='SELECT v.session_id FROM view_plans v WHERE v.project_id = ?3 AND v.plan_key = item.value LIMIT 1')return '@OWNER';
  const lookup=ownerLookup.exec(body);
  if(lookup&&ids[lookup[1]!]===lookup[3]&&sqlLiteral.test(lookup[2]!)&&sqlLiteral.test(lookup[4]!))return '@OWNER';
  const wantedPoint='SELECT sv\\.session_id FROM session_views sv WHERE sv\\.project_id=\\?1 AND sv\\.session_id=\\?\\d+';
  if(new RegExp('^'+wantedPoint+'(?: UNION ALL '+wantedPoint+'){0,3}$').test(body)&&[...body.matchAll(/sv\.session_id=\?(\d+)/g)].every(match=>Number(match[1])>=2&&Number(match[1])<=91))return '@WANTED';
  if(/^@WANTED(?: UNION ALL @WANTED){0,3}$/.test(body))return '@WANTED';
  if(/^SELECT \* FROM @WANTED(?: LIMIT -1 OFFSET 0)?$/.test(body)||/^SELECT \* FROM @WANTED(?: UNION ALL SELECT \* FROM @WANTED){0,3}$/.test(body))return '@WANTED';
  return undefined;
 }
 function masked(text:string):string{
  let body=text.replaceAll(columns,'@CAPTURE');
  const positions=[...body.matchAll(lexicalSql())].filter(match=>match[0]==='(').map(match=>match.index);
  for(const start of positions.reverse()){
   const end=closing(body,start),value=atomic(body.slice(start+1,end));
   if(value)body=body.slice(0,start)+value+body.slice(end+1);
  }
  return normalize(body);
 }
 function shell(text:string):string|undefined{
  const plain=normalize(text),body=masked(core.length&&text.includes(core)?text.replace(core,'@LEGACY'):text),atom=atomic(body);
  if(atom)return atom.slice(1).toLowerCase();
  if(/^SELECT legacy\.\*, NULL AS __myco_capture, 0 AS __myco_sentinel FROM \(@LEGACY\) legacy$/.test(body))return 'candidate-shell';
  const projection=/^SELECT ([\s\S]+), NULL AS __myco_capture, 0 AS __myco_sentinel FROM \(@LEGACY\) legacy$/.exec(body);
  if(projection&&projection[1]!.split(', ').every(field=>/^legacy\."([^"]+)" AS "\1"$/.test(field)))return 'candidate-shell';
  if(/^SELECT legacy\.\*, @POINT AS __myco_capture, 0 AS __myco_sentinel FROM __myco_candidate legacy$/.test(body))return 'candidate-shell';
  if(/^SELECT candidate\.\*, (?:@POINT|CASE WHEN candidate\.(?:session_id|__myco_session) IN \([\s\S]*\) THEN NULL ELSE @POINT END) AS __myco_capture, candidate\.(?:session_id|__myco_session) AS __myco_owner, 0 AS __myco_sentinel FROM __myco_candidate candidate$/.test(body))return 'candidate-shell';
  if(new RegExp('^SELECT (?:NULL, *)+@CAPTURE, (?:sv\\.session_id, )?1 FROM session_views sv WHERE sv\\.project_id = '+literal+' AND sv\\.session_id = (?:'+literal+'|@OWNER)(?: AND NOT EXISTS @ANTI)?$').test(body))return 'capture-tail';
  if(/^SELECT (?:NULL, *)+@CAPTURE,sv\.session_id,1 FROM @WANTED wanted CROSS JOIN session_views sv WHERE sv\.project_id=\?1 AND sv\.session_id=wanted\.session_id$/.test(body))return 'batch-tail';
  if(/^SELECT 1 FROM session_views sv WHERE sv\.project_id = ([a-z_]+)\.project_id AND sv\.session_id = \1\.session_id$/.test(body))return 'publication';
  return undefined;
 }
 const conditional:{start:number;end:number}[]=[],frames:{when?:number;then?:number;otherwise?:number;valid:boolean}[]=[];
 for(const token of input.sql.matchAll(lexicalSql())){
  const text=token[0].toUpperCase(),frame=frames.at(-1);
  if(text==='CASE')frames.push({valid:true});
  else if(text==='WHEN'&&frame){if(frame.when!==undefined)frame.valid=false;frame.when=token.index+4;}
  else if(text==='THEN'&&frame){if(frame.then!==undefined)frame.valid=false;frame.then=token.index;}
  else if(text==='ELSE'&&frame){if(frame.otherwise!==undefined)frame.valid=false;frame.otherwise=token.index;}
  else if(text==='END'&&frame){
   frames.pop();if(!frame.valid||frame.when===undefined||frame.then===undefined||frame.otherwise===undefined)continue;
   const condition=normalize(input.sql.slice(frame.when,frame.then)),first='\\(([a-z_]+)\\.project_id = '+literal+' AND \\1.session_id = '+literal+'\\)',next='\\(\\1.project_id = '+literal+' AND \\1.session_id = '+literal+'\\)';
   if(new RegExp('^'+first+'(?: OR '+next+')*$').test(condition))conditional.push({start:frame.then+4,end:frame.otherwise});
  }
 }
 const roles=new Map<number,string>(),unknown:{id:number;text:string;masked:string}[]=[];
 for(const row of labels){
  if(partition.labels.has(row.id)){roles.set(row.id,'legacy');continue;}
  const text=input.sql.slice(row.start,row.end),role=inside(row,headers)?'header':inside(row,published)?'view':(inside(row,fallback)||inside(row,conditional))&&oldSelects.has(text.trim())?'conditional-legacy-copy':shell(text);
  if(role)roles.set(row.id,role);else unknown.push({id:row.id,text,masked:masked(text)});
 }
 return {roles,unknown};
}

/** Compound limits apply to each parenthesized group and each effective source CTE. */
export function readStatementLimits(sql:string):{compoundTerms:number[];effectiveSourceTerms:number[]}{
 const stack=[0],compoundTerms:number[]=[];
 for(const match of sql.matchAll(lexicalSql())){
  const token=match[0].toUpperCase();
  if(token==='(')stack.push(0);
  else if(token===')'){const terms=stack.pop();if(terms===undefined)throw new Error('Unbalanced compound group');if(terms)compoundTerms.push(terms);}
  else if(token==='SELECT'&&stack.at(-1)===0)stack[stack.length-1]=1;
  else if(['UNION','EXCEPT','INTERSECT'].includes(token))stack[stack.length-1]++;
 }
 if(stack.length!==1)throw new Error('Unclosed compound group');if(stack[0])compoundTerms.push(stack[0]);
 const effectiveSourceTerms:number[]=[];
 for(const match of sql.matchAll(/\b(?:__myco_)?(?:prompt_batches|responses|tool_calls|plans) AS NOT MATERIALIZED \(/g)){
  const start=match.index+match[0].length-1,end=closing(sql,start),body=sql.slice(start+1,end);
  let depth=0,terms=1;
  for(const token of body.matchAll(lexicalSql())){
   if(token[0]==='(')depth++;else if(token[0]===')')depth--;
   else if(depth===0&&['UNION','EXCEPT','INTERSECT'].includes(token[0].toUpperCase()))terms++;
  }
  effectiveSourceTerms.push(terms);
 }
 return {compoundTerms,effectiveSourceTerms};
}

/** JSON instance drivers precede their indexed material loop in every source arm. */
export function jsonDriverOrderViolations(plan:readonly PlanRow[]):string[]{
 const errors:string[]=[];
 for(const [index,row]of plan.entries())if(/^SEARCH v USING /.test(row.detail)){
  const driver=plan.findIndex(candidate=>candidate.parent===row.parent&&/^SCAN j VIRTUAL TABLE INDEX /.test(candidate.detail));
  if(driver>=0&&driver>=index)errors.push('JSON driver follows its material loop');
  if(driver<0&&!/idx_view_\w+_record .*project_id=\?.*(?:prompt_id|response_id|tool_call_id|plan_key)=\?/.test(row.detail))errors.push('Instance material loop lacks its JSON driver');
 }
 return errors;
}


/** Stored proof access includes every column of its canonical source-and-blob key. */
export function proofPointPlanViolations(plan:readonly PlanRow[]):{errors:string[];seeks:number}{
 const errors:string[]=[];let seeks=0;
 for(const node of plan){
  if(/^SCAN proof\b/.test(node.detail))errors.push('proof table scan: '+node.detail);
  if(!/^SEARCH proof\b/.test(node.detail))continue;
  seeks++;
  for(const column of ['project_id','kind','blob_key'])if(!node.detail.includes(column+'=?'))errors.push('proof key lacks '+column+': '+node.detail);
  if(!/(?:record_id|resource_id)=\?/.test(node.detail))errors.push('proof key lacks record: '+node.detail);
  if(node.detail.includes('record_id=?')&&!node.detail.includes('instance_id=?'))errors.push('view proof key lacks instance: '+node.detail);
 }
 return {errors,seeks};
}

interface CaptureProbes {publication:number;visible:number;header:number;checkpoint:number;transcript:number}

/** Each scalar value and each effective-material use evaluates its retained capture. */
function declaredCaptureProbes(sql:string){
 const columns=M21_OWNER_POINT_SQL.slice('(SELECT '.length,M21_OWNER_POINT_SQL.lastIndexOf(' FROM session_views sv'));
 const captures=sql.split(columns).length-1,scalar='COALESCE((WITH __myco_capture_scalar AS MATERIALIZED (';
 let scalarDefinitions=0,materializations=0;
 for(let begin=sql.indexOf(scalar);begin>=0;begin=sql.indexOf(scalar,begin+scalar.length)){
  scalarDefinitions++;
  const start=begin+'COALESCE('.length,end=closing(sql,start);
  let depth=0,selected=-1;
  for(const token of sql.slice(start,end+1).matchAll(lexicalSql())){
   if(token[0]==='(')depth++;else if(token[0]===')')depth--;
   else if(depth===1&&token[0].toUpperCase()==='SELECT')selected=start+token.index;
  }
  if(selected<0)throw new Error('Scalar capture has no value selection');
  const uses=(sql.slice(selected,end).match(/(?:FROM|JOIN) __myco_(?:prompt_batches|responses|tool_calls|plans)\b/g)??[]).length;
  materializations+=1+3*uses;
 }
 const operation=readTag(sql)?.operation;
 let groups=1;
 if(operation==='M15:sessions_countStatements:0'||operation==='M16:sessions_instantStatements:0'){
  groups=(sql.match(/SELECT sv.session_id FROM session_views sv WHERE sv.project_id=\?1 AND sv.session_id=\?\d+/g)??[]).length;
  while(groups>4)groups=Math.ceil(groups/4);
  groups=Math.max(1,groups);
 }
 const headerEvaluations=(captures-scalarDefinitions)*groups+materializations;
 const publicationExpressions=(sql.match(/(?:FROM|JOIN) session_views sv\b/g)??[]).length;
 const expected:CaptureProbes={publication:publicationExpressions-scalarDefinitions+materializations+(captures-scalarDefinitions)*(groups-1),
  visible:headerEvaluations,header:headerEvaluations,checkpoint:headerEvaluations,transcript:headerEvaluations};
 return {expected,scalarDefinitions,materializations,headerEvaluations,groups};
}

interface ScalarCaptureOwner {start:number;end:number;selectId:number;active:boolean}

/** Scalar ownership follows source positions and the independent target's SELECT labels. */
function scalarCaptureOwners(input:Parameters<typeof partitionLegacyPlan>[0]):ScalarCaptureOwner[]{
 const layout=legacyLayout(input.sql,input.operation);
 if(layout.text!==input.original)throw new Error('Legacy layout differs from independent SQL');
 const original=selectLabels(input.original),current=selectLabels(input.sql),positions=new Map(layout.positions.map((position,index)=>[position,index]));
 const active=new Set(input.baseline.flatMap(row=>{
  const label=/^(?:CORRELATED )?SCALAR SUBQUERY (\d+)$/.exec(row.detail);return label?[Number(label[1])]:[];
 }));
 const owners:ScalarCaptureOwner[]=[],frames:{start:number;when?:number;then?:number;otherwise?:number;valid:boolean}[]=[];
 for(const token of input.sql.matchAll(lexicalSql())){
  const word=token[0].toUpperCase(),frame=frames.at(-1);
  if(word==='CASE')frames.push({start:token.index,valid:true});
  else if(word==='WHEN'&&frame){if(frame.when!==undefined)frame.valid=false;frame.when=token.index+4;}
  else if(word==='THEN'&&frame){if(frame.then!==undefined)frame.valid=false;frame.then=token.index+4;}
  else if(word==='ELSE'&&frame){if(frame.otherwise!==undefined)frame.valid=false;frame.otherwise=token.index;}
  else if(word==='END'&&frame){
   frames.pop();if(!frame.valid||frame.when===undefined||frame.then===undefined||frame.otherwise===undefined)continue;
   const condition=input.sql.slice(frame.when,frame.then-4).trim();
   if(!/^EXISTS\(SELECT 1 FROM session_views sv WHERE sv\.project_id = ([a-z_]+)\.project_id AND sv\.session_id = \1\.session_id\)$/.test(condition))continue;
   if(!input.sql.slice(frame.then,frame.otherwise).includes('COALESCE((WITH __myco_capture_scalar AS MATERIALIZED ('))continue;
   const otherwise=frame.otherwise+4,body=input.sql.slice(otherwise,token.index).trim(),open=otherwise+input.sql.slice(otherwise,token.index).indexOf(body);
   if(body==='NULL'&&input.sql.slice(token.index+3).startsWith(') AS __myco_capture_context'))continue;
   if(!/^\(SELECT\b/.test(body)||closing(input.sql,open)!==open+body.length-1)throw new Error('Capture owner requires one scalar expression');
   const selected=current.find(row=>row.start===open+1),oldPosition=selected===undefined?undefined:positions.get(selected.start);
   const source=original.find(row=>row.start===oldPosition);
   if(source===undefined)throw new Error('Capture owner lacks an original SELECT position');
   const previous=[...input.original.slice(0,source.start).matchAll(new RegExp(lexicalSql().source+'|,','g'))].filter(row=>!/^--|^\/\*/.test(row[0])).map(row=>row[0].toUpperCase());
   let prior=previous.length-1;while(previous[prior]==='(')prior--;
   const kind=input.baseline.find(row=>new RegExp('(?:SUBQUERY |subquery-)'+source.id+'$').test(row.detail))?.detail;
   let depth=0;const peers:string[]=[],scope=previous.reduce((value,word)=>value+(word==='('?1:word===')'?-1:0),0)-1;
   for(const word of previous){if(word===')')depth--;if(depth===scope)peers.push(word);if(word==='(')depth++;}
   const clause=[...peers].reverse().find(word=>['SELECT','FROM','WHERE','HAVING','GROUP','ORDER','LIMIT','VALUES','SET','RETURNING'].includes(word));
   if(previous.at(-1)!=='('||['FROM','JOIN','AS','IN'].includes(previous[prior]??'')||
    (previous[prior]===','&&clause==='FROM')||kind!==undefined&&!/^(?:CORRELATED )?SCALAR SUBQUERY \d+$/.test(kind))throw new Error('Capture owner is not a supported scalar role');
   owners.push({start:frame.start,end:token.index+3,selectId:source.id,active:active.has(source.id)});
  }
 }
 for(const owner of owners)if(owners.some(other=>other!==owner&&owner.start>=other.start&&owner.end<=other.end))throw new Error('Nested scalar capture ownership is ambiguous');
 return owners.sort((a,b)=>a.start-b.start);
}

/** Generated probes retain each independently surviving scalar's lexical ownership. */
export function captureProbePlan(sql:string,plan:readonly PlanRow[],input?:Parameters<typeof partitionLegacyPlan>[0]){
 const owners=input===undefined?[]:scalarCaptureOwners(input),labels=selectLabels(sql),byId=new Map(plan.map(row=>[row.id,row]));
 const labelOwners=new Map(labels.flatMap(row=>{
  const index=owners.findIndex(owner=>row.start>=owner.start&&row.end<=owner.end);return index<0?[]:[[row.id,index] as const];
 }));
 const ownership=new Map<number,number>();
 for(const row of plan){
  let ancestor:PlanRow|undefined=row;const visited=new Set<number>();
  while(ancestor!==undefined){
   if(visited.has(ancestor.id))throw new Error('Capture plan contains a cycle');visited.add(ancestor.id);
   const label=/(?:SCALAR|LIST) SUBQUERY (\d+)/.exec(ancestor.detail),owner=label===null?undefined:labelOwners.get(Number(label[1]));
   if(owner!==undefined){ownership.set(row.id,owner);break;}ancestor=byId.get(ancestor.parent);
  }
 }
 let outside=sql;
 for(const owner of [...owners].reverse())outside=outside.slice(0,owner.start)+' '.repeat(owner.end-owner.start)+outside.slice(owner.end);
 const declarations=[{name:'outer',active:true,...declaredCaptureProbes(outside)},...owners.map(owner=>({name:'SELECT '+owner.selectId,active:owner.active,...declaredCaptureProbes(sql.slice(owner.start,owner.end))}))];
 const errors:string[]=[],actualCounts=(rows:readonly PlanRow[]):CaptureProbes=>{
  const probes=(alias:string)=>rows.filter(row=>new RegExp('^SEARCH '+alias+' USING ').test(row.detail));
  return {publication:probes('sv').length,visible:probes('vv').length,header:probes('vi').length,checkpoint:probes('cp').length,
   transcript:probes('t').filter(row=>row.detail.includes('transcript_id=?')).length};
 };
 const expected:CaptureProbes={publication:0,visible:0,header:0,checkpoint:0,transcript:0};
 let materializations=0,scalarDefinitions=0,headerEvaluations=0;
 const counts=declarations.map((declaration,index)=>{
  const rows=plan.filter(row=>(ownership.get(row.id)??-1)===index-1),actual=actualCounts(rows);
  const wanted:CaptureProbes={...declaration.expected};
  if(!declaration.active)for(const key of Object.keys(wanted) as (keyof CaptureProbes)[])wanted[key]=0;
  const wantedMaterializations=declaration.active?declaration.materializations:0;
  if(rows.filter(row=>row.detail==='MATERIALIZE __myco_capture_scalar').length!==wantedMaterializations)errors.push(declaration.name+' scalar materialization multiplicity differs');
  for(const key of Object.keys(expected) as (keyof CaptureProbes)[]){expected[key]+=wanted[key];if(actual[key]!==wanted[key])errors.push(declaration.name+' '+key+' probe multiplicity differs');}
  materializations+=wantedMaterializations;scalarDefinitions+=declaration.scalarDefinitions;headerEvaluations+=declaration.active?declaration.headerEvaluations:0;
  return {name:declaration.name,active:declaration.active,expected:wanted,actual,planIds:rows.map(row=>row.id),labels:index===0?[]:[...labelOwners].filter(([,owner])=>owner===index-1).map(([label])=>label)};
 });
 const actual=actualCounts(plan),groups=declarations[0]!.groups;
 const probes=(alias:string)=>plan.filter(row=>new RegExp('^SEARCH '+alias+' USING ').test(row.detail));
 const keys:Record<string,readonly string[]>={sv:['project_id','session_id'],vv:['project_id','session_id'],vi:['project_id','instance_id'],cp:['project_id','session_id','instance_id']};
 for(const row of plan){
  const alias=/^(?:SEARCH|SCAN) (sv|vv|vi|cp)\b/.exec(row.detail)?.[1];
  if(alias!==undefined&&(!row.detail.startsWith('SEARCH ')||keys[alias]!.some(key=>!row.detail.includes(key+'=?'))))errors.push('unbounded '+alias+' capture: '+row.detail);
  if(/^SEARCH t .*transcript_id=\?/.test(row.detail)&&!row.detail.includes('project_id=?'))errors.push('transcript capture lacks its Project');
 }
 for(const row of probes('sv'))errors.push(...armPlanViolations({baseline:[],legacy:[],publication:[{...row,relation:'session_views'}],view:[]}));
 return {errors,expected,actual,scalarDefinitions,materializations,headerEvaluations,groups,owners:counts};
}

/** Original plan rows retain their order, access details and SELECT identities. */
export function legacyArmPlanViolations(input:Parameters<typeof partitionLegacyPlan>[0]):string[]{
 const partition=partitionLegacyPlan(input),roles=generatedSelectRoles(input,M21_OWNER_POINT_SQL.slice('(SELECT '.length,M21_OWNER_POINT_SQL.lastIndexOf(' FROM session_views sv')));
 const errors=roles.unknown.map(row=>'unclassified generated SELECT '+row.id+': '+row.masked);
 const probes=captureProbePlan(input.sql,input.candidate,input);errors.push(...probes.errors);
 const publication=input.candidate.filter(row=>/^SEARCH sv USING /.test(row.detail));
 if(publication.length===0){
  const compared=armPlanViolations({baseline:partition.baseline,legacy:partition.legacy,publication:[],view:[]});
  errors.push(...compared.filter(error=>error!=='publication gate requires one exact indexed session_views search'));
 }else errors.push(...armPlanViolations({baseline:partition.baseline,legacy:partition.legacy,publication:[{...publication[0]!,relation:'session_views'}],view:[]}));
 return errors;
}

interface SourceArmBound {instances:number;rowsPerInstance:number;survivingFacts:number}

function numberReadParameters(sql:string):string{
 let parameter=0;
 return sql.replace(new RegExp(lexicalSql().source+'|\\?\\d*','g'),token=>{
  if(!token.startsWith('?'))return token;
  const index=token.length===1?++parameter:Number(token.slice(1));parameter=Math.max(parameter,index);return '?'+index;
 });
}

/** Source-only EXPLAIN retains each generated CTE and its canonical outer owner. */
export function isolatedViewSources(query:Pick<RecordedStatement,'sql'|'binds'>,owner:{projectId:string;sessionId:string}){
 const numbered=numberReadParameters(query.sql);
 const tokens=[...numbered.matchAll(lexicalSql())].filter(token=>!/^(?:["'`\[]|--|\/\*)/.test(token[0]));
 const positions=new Set(tokens.map(token=>token.index));
 const starts=tokens.filter(token=>token[0].toUpperCase()==='WITH'&&/^WITH (?:__myco_pins|__myco_capture_scalar) AS MATERIALIZED \(/.test(numbered.slice(token.index)));
 const rows:{name:string;sql:string;binds:readonly unknown[]}[]=[];
 for(const start of starts){
  let depth=0,selected=-1;
  for(const token of tokens.filter(token=>token.index>start.index)){
   if(token[0]==='(')depth++;else if(token[0]===')')depth--;
   else if(depth===0&&token[0].toUpperCase()==='SELECT'){selected=token.index;break;}
  }
  if(selected<0)throw new Error('Effective source has no outer selection');
  const preamble=numbered.slice(start.index,selected);
  const names=[...preamble.matchAll(/\b((?:__myco_)?(?:prompt_batches|responses|tool_calls|plans)|processed_resources) AS NOT MATERIALIZED \(/g)]
   .filter(match=>positions.has(start.index+match.index)).map(match=>match[1]!);
  const capture=preamble.slice(0,closing(preamble,preamble.indexOf('('))+1);
  const aliases=[...new Set([...capture.matchAll(/sv\.project_id = ([a-z_]+)\.project_id AND sv\.session_id = \1\.session_id/g)].map(match=>match[1]!))];
  const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  const outer=aliases.map(alias=>`(SELECT ${literal(owner.projectId)} AS project_id,${literal(owner.sessionId)} AS session_id) ${alias}`).join(' CROSS JOIN ');
  for(const name of new Set(names)){
   const body=preamble+'SELECT COUNT(*) FROM '+name,sql=outer.length?'SELECT ('+body+') FROM '+outer:body;
   const used=[...sql.matchAll(new RegExp(lexicalSql().source+'|\\?\\d+','g'))].flatMap(token=>/^\?\d+$/.test(token[0])?[Number(token[0].slice(1))]:[]);
   rows.push({name,sql,binds:query.binds.slice(0,Math.max(0,...used))});
  }
 }
 return rows;
}

/** Effective-source unions expose their physical loops independently of the logical consumer. */
export function viewSourceArmPlans(query:Pick<RecordedStatement,'sql'|'binds'>,plan:readonly PlanRow[],bound:SourceArmBound){
 const errors:string[]=[],byId=new Map(plan.map(row=>[row.id,row]));
 const rootName=(row:PlanRow)=>/^(?:CO-ROUTINE|MATERIALIZE) ((?:__myco_)?(?:prompt_batches|responses|tool_calls|plans)|processed_resources)$/.exec(row.detail)?.[1];
 const roots=plan.filter(row=>rootName(row)!==undefined),rootIds=new Set(roots.map(row=>row.id));
 const numbered=numberReadParameters(query.sql),tokens=[...numbered.matchAll(lexicalSql())].filter(token=>!/^--|^\/\*/.test(token[0]));
 const words=new Set(tokens.filter(token=>/^[a-z_]/i.test(token[0])).map(token=>token.index));
 const identifier=(value:string|undefined)=>value?.replace(/^"([\s\S]*)"$/,'$1').replace(/^`([\s\S]*)`$/,'$1').replace(/^\[([\s\S]*)\]$/,'$1');
 const pinStart=[...numbered.matchAll(/__myco_pins AS MATERIALIZED \(/g)].find(match=>words.has(match.index))?.index??-1;
 const pinEnd=pinStart<0?-1:closing(numbered,numbered.indexOf('(',pinStart));
 const drivers:{kind:string;table:string;maximum:number;parameter:number|null}[]=[],recognizedDrivers=new Set<number>();
 for(const match of numbered.matchAll(/\bjson_each\((\?\d+|'(?:''|[^'])*')\)/g)){
  if(!words.has(match.index))continue;
  const tail=numbered.slice(match.index+match[0].length),cross=/^ j CROSS JOIN (?:main\.)?([a-z_]+) (f|v)\b/.exec(tail);
  const after=[...tail.matchAll(lexicalSql())].filter(token=>!/^--|^\/\*/.test(token[0])).slice(0,3).map(token=>token[0].toUpperCase());
  const kind=pinStart>=0&&match.index>pinStart&&match.index<pinEnd?'pins':cross?(cross[2]==='v'?'instances':'facts'):/^ j\b/.test(tail)&&after[1]!=='CROSS'?'manifest':null;
  if(kind===null)continue;
  const parameter=match[1]!.startsWith('?')?Number(match[1]!.slice(1)):null;
  const text=parameter===null?match[1]!.slice(1,-1).replaceAll("''","'"):query.binds[parameter-1];
  if(typeof text!=='string')throw new Error('Source driver requires encoded JSON');
  const values:unknown=JSON.parse(text);if(!Array.isArray(values))throw new Error('Source driver requires a JSON list');
  let maximum=values.length;
  if(kind==='instances'&&values.every(value=>typeof value==='string')){
   maximum=bound.instances;if(values.length>maximum)errors.push('instance driver exceeds declared visible-instance bound');
  }else if(kind!=='pins'){
   const owners=new Map<string,Set<string>>(),entries=new Set<string>();
   for(const value of values){
    if(typeof value!=='object'||value===null||typeof value.projectId!=='string'||typeof value.sessionId!=='string')throw new Error('Source driver lacks its canonical owner');
    const key=JSON.stringify([value.projectId,value.sessionId]),entry=JSON.stringify(kind==='instances'?[value.projectId,value.sessionId,value.instanceId]:[value.projectId,value.sessionId]);
     if(entries.has(entry))errors.push('source driver repeats a canonical entry');entries.add(entry);
     const instances=owners.get(key)??new Set<string>();
    if(kind==='instances'){
     if(typeof value.instanceId!=='string')throw new Error('Instance driver lacks its instance');instances.add(value.instanceId);
    }else{
     const selected=value.instances??value.capture?.instances??[];
     if(!Array.isArray(selected))throw new Error('Source manifest lacks its closure');
     for(const instance of selected){if(typeof instance?.instanceId!=='string')throw new Error('Source manifest lacks its instance');if(instances.has(instance.instanceId))errors.push('source driver repeats a canonical entry');instances.add(instance.instanceId);}
    }
    if(instances.size>bound.instances)errors.push('instance driver exceeds declared visible-instance bound');owners.set(key,instances);
   }
   maximum=owners.size*(kind==='instances'?bound.instances:1);
  }
  drivers.push({kind,table:cross?.[1]??'',maximum,parameter});recognizedDrivers.add(match.index);
 }
 for(const [index,match]of tokens.entries()){
   if(identifier(match[0])?.toLowerCase()!=='json_each'||tokens[index+1]?.[0]!=='(')continue;
   const end=closing(numbered,tokens[index+1]!.index),expression=numbered.slice(match.index,end+1),cross=/^ j CROSS JOIN (?:main\.)?([a-z_]+) (f|v)\b/.exec(numbered.slice(end+1));
   const alias=[...numbered.slice(end+1).matchAll(lexicalSql())].filter(token=>!/^--|^\/\*/.test(token[0])).slice(0,2).map(token=>token[0]);
   const rawAlias=alias[0]?.toUpperCase()==='AS'?alias[1]:alias[0];
   const sourceAlias=identifier(rawAlias);
   if(sourceAlias!=='j'||recognizedDrivers.has(match.index))continue;
   if(!cross){errors.push('source driver has unknown provenance');continue;}
   if(cross[2]!=='v'||expression!=="json_each(json_extract((SELECT value FROM __myco_capture_scalar), '$.instances'))"||!numbered.includes('__myco_capture_scalar AS MATERIALIZED (')){errors.push('source driver has unknown provenance');continue;}
   drivers.push({kind:'instances',table:cross[1]!,maximum:bound.instances,parameter:null});
  }
  const pins=Math.max(0,...drivers.filter(driver=>driver.kind==='pins').map(driver=>driver.maximum));
 const driverOffsets=new Map<string,number>();
 const listBound=(node:PlanRow):number=>{
  const siblings=plan.filter(row=>row.parent===node.parent),view=siblings.find(row=>/^SEARCH v USING /.test(row.detail)),fact=siblings.find(row=>/^SEARCH f USING /.test(row.detail));
  const kind=view?'instances':fact?'facts':'manifest',detail=(view??fact)?.detail??'';
  const matching=drivers.filter(driver=>driver.kind===kind&&(driver.table===''||detail.includes(driver.table)));
  if(matching.length===0){errors.push('source driver has unknown provenance');return 0;}
  const key=kind+'\0'+matching[0]!.table,index=driverOffsets.get(key)??0;driverOffsets.set(key,index+1);
  return matching[index%matching.length]!.maximum;
 };
 const logicalLoops=plan.flatMap(node=>{
  const detail=node.detail;
  if(/^SEARCH pin USING AUTOMATIC PARTIAL COVERING INDEX \(table_name=\?\)$/.test(detail)&&query.sql.includes('__myco_pins AS MATERIALIZED (SELECT json_extract(value,')&&plan.some(row=>row.detail==='MATERIALIZE __myco_pins'))return [{node,bound:pins,source:'selected-record manifest'}];
  if(/^SEARCH pr USING AUTOMATIC PARTIAL COVERING INDEX \(project_id=\? AND kind=\? AND resource_id=\? AND blob_key=\? AND classification=\?\)$/.test(detail)&&query.sql.includes('processed_resources AS NOT MATERIALIZED (')&&proofPointPlanViolations(plan).seeks>0)return [{node,bound:2,source:'selected-record proof keys'}];
  for(const field of COST_MATERIALS)if((detail==='SCAN winner'||detail===`SEARCH winner USING AUTOMATIC PARTIAL COVERING INDEX (project_id=? AND ${field.id}=?)`)
   &&query.sql.includes('__myco_proof_keys AS NOT MATERIALIZED (')&&query.sql.includes(`FROM ${field.table} winner WHERE winner.project_id=`)&&query.sql.includes(`AND winner.${field.id}=`)
   &&plan.some(row=>row.detail==='MATERIALIZE '+field.table||row.detail==='CO-ROUTINE '+field.table))return [{node,bound:1+bound.instances,source:'selected canonical '+field.table+' union'}];
  return [];
 });
 const logicalIds=new Set(logicalLoops.map(row=>row.node.id));
 const owner=(row:PlanRow):number|undefined=>{
  let parent=byId.get(row.parent);
  while(parent){if(rootIds.has(parent.id))return parent.id;parent=byId.get(parent.parent);}
  return undefined;
 };
 const arms=roots.map(root=>{
  const nodes=plan.filter(row=>owner(row)===root.id&&!rootIds.has(row.id));
  const budgets=new Map<number,{bound:number;maximum:number}>();
  const output=rootName(root)==='processed_resources'?2:bound.survivingFacts+bound.instances*bound.rowsPerInstance;
  for(const node of nodes){
   if(logicalIds.has(node.id))continue;
   const detail=node.detail;
   let maximum:number|undefined;
   if(detail==='COMPOUND QUERY')maximum=3;
   else if(detail==='LEFT-MOST SUBQUERY'||detail==='UNION ALL')maximum=1;
   else if(/^SCAN j VIRTUAL TABLE INDEX /.test(detail))maximum=listBound(node);
   else if(detail==='MATERIALIZE __myco_pins'||/^SCAN json_each VIRTUAL TABLE INDEX /.test(detail)||detail==='SCAN pin')maximum=pins;
   else if(detail==='MATERIALIZE __myco_capture_scalar'||detail==='SCAN __myco_capture_scalar')maximum=1;
   else if((detail==='SCAN pr'||detail==='SCAN processed_resources')&&query.sql.includes('processed_resources AS NOT MATERIALIZED ('))maximum=2;
   else if(/^(?:CORRELATED )?(?:SCALAR|LIST) SUBQUERY \d+$/.test(detail)||/^BLOOM FILTER ON pin \(table_name=\?\)$/.test(detail))continue;
   else if(!detail.startsWith('SEARCH '))errors.push('unclassified source-arm node: '+detail);
   if(maximum!==undefined)budgets.set(node.id,{bound:maximum,maximum});
  }
  const publication=nodes.filter(row=>/^SEARCH sv USING /.test(row.detail));
  const compared=armPlanViolations({baseline:[],legacy:[],publication:publication.length?[{...publication[0]!,relation:'session_views'}]:[],view:nodes.filter(row=>!logicalIds.has(row.id)),boundedNodes:budgets});
  errors.push(...compared.filter(error=>publication.length>0||error!=='publication gate requires one exact indexed session_views search'));
  return {name:rootName(root)!,root,outputBound:output,nodes,budgets:[...budgets]};
 });
 for(const row of plan){
  const detail=row.detail,alias=/^(?:SEARCH|SCAN) (f|v|winner|fc|proof)\b/.exec(detail)?.[1];
  if(alias===undefined||logicalIds.has(row.id))continue;
  if(!detail.startsWith('SEARCH ')||!detail.includes('project_id=?')){errors.push('source loop lacks its indexed Project: '+detail);continue;}
  const record=/(?:prompt_id|response_id|tool_call_id|plan_key)=\?/.test(detail);
  if(alias==='f'&&!detail.includes('session_id=?')&&!record)errors.push('fact loop lacks session or canonical record: '+detail);
  if(alias==='v'&&!detail.includes('instance_id=?')&&!(/idx_view_\w+_record /.test(detail)&&record))errors.push('view loop lacks instance or exact owner lookup: '+detail);
  if(alias==='winner'&&(!record||/sqlite_autoindex_view_/.test(detail)&&!detail.includes('instance_id=?')))errors.push('precedence loop lacks its canonical key: '+detail);
  if(alias==='fc'&&(!detail.includes('table_name=?')||!detail.includes('record_id=?')))errors.push('classification loop lacks its complete key: '+detail);
 }
 errors.push(...proofPointPlanViolations(plan).errors,...jsonDriverOrderViolations(plan));
 const limits=readStatementLimits(query.sql);
 for(const terms of limits.effectiveSourceTerms)if(terms>3)errors.push('effective source union exceeds three terms');
 for(const terms of limits.compoundTerms)if(terms>5)errors.push('compound group exceeds five terms');
 return {errors,arms,logicalLoops,physicalLoops:plan.filter(row=>!logicalIds.has(row.id)&&/^(?:SEARCH|SCAN) (?:f|v|winner|fc|proof)\b/.test(row.detail)).length,
  bound:{...bound,pins,drivers,effectiveRows:bound.survivingFacts+bound.instances*bound.rowsPerInstance}};
}
