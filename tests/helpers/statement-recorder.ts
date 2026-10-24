import {AsyncLocalStorage} from 'node:async_hooks';
import type ts from 'typescript-v6';
import type { RelationalStore, PreparedStatement } from '../../packages/myco-server/src/core/adapters.js';

export interface StatementFrame {
  operation: string;
  phase: string;
  spanId?: string;
  parentSpanId?: string;
  exceptionId?: string;
  origin?: PreparationOrigin;
}

export type PreparationOrigin = {kind:'module'} | {kind:'oracle';sha256:string} | {
 kind:'exception';id:string;file:string;owner:string;expression:string;phase:'W'|'P'|'H'|'T';
};
const oracleTokens=new WeakMap<PreparationOrigin,string>();
/** The frozen program loader issues tokens bound to admitted statement text. */
export function createOracleLoader(){
 return (sql:string,sha256:string):PreparationOrigin=>{
  const origin:PreparationOrigin=Object.freeze({kind:'oracle',sha256});
  oracleTokens.set(origin,sql);return origin;
 };
}
const preparations=new AsyncLocalStorage<PreparationOrigin>();
let preparationBoundary:((statement:StatementEvent)=>void)|undefined;
export function installReadPreparationBoundary(check:(statement:StatementEvent)=>void):void{preparationBoundary=check;}
export function withReadPreparation<T>(origin:PreparationOrigin,run:()=>T):T{
 return preparations.getStore()===undefined?preparations.run(origin,run):run();
}

export function preparationOwner(compiler:typeof ts,node:ts.Node,tree:ts.SourceFile):string{
 for(let at:ts.Node|undefined=node;at&&!compiler.isSourceFile(at);at=at.parent){
  if(compiler.isFunctionDeclaration(at)&&at.name)return at.name.text;
  if(compiler.isMethodDeclaration(at)&&at.name)return at.name.getText(tree);
  if(compiler.isArrowFunction(at)||compiler.isFunctionExpression(at)){
   if(compiler.isVariableDeclaration(at.parent))return at.parent.name.getText(tree);
   if(compiler.isCallExpression(at.parent)){
    const called=at.parent.expression.getText(tree),label=at.parent.arguments[0];
    if(/^(?:test|it|beforeAll|beforeEach|afterAll|afterEach)(?:\.|$)/.test(called))return called+':'+(label&&compiler.isStringLiteralLike(label)?label.text:'hook');
   }
  }
 }
 return '<module>';
}

/** Seals exact admitted preparation sites in test builds. */
export function instrumentReadPreparations(compiler:typeof ts,source:string,file:string,origins:readonly Extract<PreparationOrigin,{kind:'exception'}>[],recorder:string):string{
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true);
 const edits:{start:number;end:number;text:string}[]=[];
 const candidates=origins.filter(origin=>origin.file===file);
 const nativeDatabase=(receiver:ts.Expression,call:ts.Node):boolean=>{
  const created=(node:ts.Node|undefined)=>node!==undefined&&compiler.isNewExpression(node)&&node.expression.getText(tree)==='Database';
  if(created(receiver))return true;
  if(!compiler.isIdentifier(receiver))return false;
  for(let at:ts.Node|undefined=call.parent;at;at=at.parent){
   if(compiler.isFunctionLike(at))for(const parameter of at.parameters)if(parameter.name.getText(tree)===receiver.text)return /\bDatabase\b/.test(parameter.type?.getText(tree)??'');
   if(compiler.isBlock(at)||compiler.isSourceFile(at))for(const statement of at.statements)if(compiler.isVariableStatement(statement))for(const variable of statement.declarationList.declarations)if(variable.name.getText(tree)===receiver.text)return created(variable.initializer)||/\bDatabase\b/.test(variable.type?.getText(tree)??'');
  }
  return false;
 };
 const visit=(node:ts.Node):void=>{
  if(compiler.isCallExpression(node)&&compiler.isPropertyAccessExpression(node.expression)&&!compiler.isRegularExpressionLiteral(node.expression.expression)&&['prepare','query','exec'].includes(node.expression.name.text)&&node.arguments[0]){
   const expression=node.arguments[0].getText(tree),owner=preparationOwner(compiler,node,tree);
   const origin:PreparationOrigin|undefined=file==='packages/myco-server/src/read/view-store.ts'&&owner==='prepareViewRead'&&node.expression.name.text==='prepare'?{kind:'module'}:candidates.find(item=>item.owner===owner&&item.expression===expression);
   if(origin){
    const physical=origin.kind==='exception'&&['P','H'].includes(origin.phase)&&(['query','exec'].includes(node.expression.name.text)||nativeDatabase(node.expression.expression,node));
    const body=node.getText(tree);
    const text=physical?'((__sql)=>__viewPhysicalPreparation('+JSON.stringify(origin)+',__sql,'+JSON.stringify(node.expression.name.text)+',()=>'+body.slice(0,node.arguments[0].getStart(tree)-node.getStart(tree))+'__sql'+body.slice(node.arguments[0].getEnd()-node.getStart(tree))+'))('+expression+')':'__viewReadPreparation('+JSON.stringify(origin)+',()=>'+body+')';
    edits.push({start:node.getStart(tree),end:node.getEnd(),text});return;
   }
  }
  compiler.forEachChild(node,visit);
 };visit(tree);
 if(edits.length===0)return source;
 let output=source;
 for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
 return 'import {withReadPreparation as __viewReadPreparation,withPhysicalPreparation as __viewPhysicalPreparation} from '+JSON.stringify(recorder)+';\n'+output;
}

export interface RecordedStatement extends StatementFrame {
  statementId: string;
  sql: string;
  binds: readonly unknown[];
  method: 'first' | 'all' | 'run' | 'batch';
  rowsRead?: number;
  rowsWritten?: number;
  rowCount?:number;
  rows?:readonly unknown[];
  nativeMethod?:string;
  failed?: true;
}

export interface StatementEvent extends StatementFrame {
  kind: 'prepare' | 'bind' | 'execute';
  statementId: string;
  sql: string;
  binds: readonly unknown[];
  method?: RecordedStatement['method'];
  failed?: true;
}

function accounting(result: unknown, entry: RecordedStatement,captureRows=false): void {
  const envelope=typeof result==='object'&&result!==null&&'results'in result&&Array.isArray(result.results)?result.results:undefined;
  const rows=entry.method==='first'?(envelope===undefined?(result===null?[]:[result]):envelope.slice(0,1)):envelope??[];
  entry.rowCount=rows.length;
  if(captureRows)entry.rows=structuredClone(rows);
  if (typeof result !== 'object' || result === null || !('meta' in result)) return;
  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null) return;
  if ('rows_read' in meta && typeof meta.rows_read === 'number') entry.rowsRead = meta.rows_read;
  if ('rows_written' in meta && typeof meta.rows_written === 'number') entry.rowsWritten = meta.rows_written;
}

/** Records adapter calls, their originating spans and deferred completion. */
export function statementRecorder(db: RelationalStore, options: {
  accounting: 'native' | 'd1';
  captureRows?:boolean;
  context?: () => StatementFrame | undefined;
  prepared?: (event: StatementEvent) => void;
  event?: (event: StatementEvent) => void;
  bufferLimit?: number;
  before?: (entry: RecordedStatement) => void | Promise<void>;
  after?: (entry: RecordedStatement) => void | Promise<void>;
}) {
  const statements: RecordedStatement[] = [];
  const events: StatementEvent[] = [];
  const pending = new Set<Promise<unknown>>();
  let sequence = 0;
  type Held = { statement: PreparedStatement; sql: string; binds: readonly unknown[]; statementId: string; frame: StatementFrame };
  const retain = <T>(values:T[], value:T):void => {
    values.push(value);
    if(options.bufferLimit!==undefined && values.length>2*options.bufferLimit)values.splice(0,options.bufferLimit);
  };
  const emitEvent = (event:StatementEvent):void => {
    retain(events,event);
    try{options.event?.(event)}catch(error){event.failed=true;throw error}
  };
  const originals = new WeakMap<PreparedStatement, Held>();
  const originalKey = Symbol('recorded-statement');
  const isMarked = (statement: PreparedStatement): statement is PreparedStatement & {[originalKey]: Held} => originalKey in statement;
  const frame = (sql: string): StatementFrame => {
    const supplied = options.context?.()??nativeSpans.getStore();
    const origin=preparations.getStore();
    if (supplied) return {...supplied,...(origin?.kind==='exception'?{phase:origin.phase,exceptionId:origin.id}:{}),...(origin?{origin}:{})};
    const tag = /^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(sql);
    return {operation:tag?.[1] ?? (origin?.kind==='exception'?origin.file+'#'+origin.owner:'unclassified'),phase:tag?'logical':origin?.kind==='exception'?origin.phase:'unclassified',...(origin?.kind==='exception'?{exceptionId:origin.id}:{}),...(origin?{origin}:{})};
  };
  const begin = (held: Omit<Held,'statement'>, method: RecordedStatement['method']): RecordedStatement => {
    const entry: RecordedStatement = {...held.frame,statementId:held.statementId,sql:held.sql,binds:held.binds,method};
    retain(statements,entry);
    emitEvent({...entry,kind:'execute'});
    return entry;
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const record = <T>(entry: RecordedStatement, run: () => Promise<T>): Promise<T> => track((async()=>{
    try {
      if(options.before)await options.before(entry);
      const result = await (entry.origin?withReadPreparation(entry.origin,run):run());
      accounting(result, entry,options.captureRows);
      return result;
    } catch (error) {
      entry.failed = true;
      const event=events.find(event=>event.kind==='execute' && event.statementId===entry.statementId && event.method===entry.method);
      if(event)event.failed=true;
      throw error;
    } finally { if(options.after)await options.after(entry); }
  })());
  const observe = (held: Held): PreparedStatement => {
    const {statement,sql,binds,statementId,frame}=held;
    const wrapped = {
      ...(options.accounting === 'native' ? statement : {}),
      [originalKey]: held,
      bind: (...values: unknown[]) => {
        const event: StatementEvent={...frame,kind:'bind',statementId,sql,binds:values};
        emitEvent(event);
        try { return observe({...held,statement:statement.bind(...values),binds:values}); }
        catch(error){event.failed=true;throw error}
      },
      first: <T,>() => {
        const entry = begin(held, 'first');
        if (options.accounting === 'native') return record(entry, () => statement.first<T>());
        return record(entry, () => statement.all<T>()).then(result=>result.results[0] ?? null);
      },
      all: <T,>() => record(begin(held, 'all'), () => statement.all<T>()),
      run: () => record(begin(held, 'run'), () => statement.run()),
    };
    originals.set(wrapped, held);
    return wrapped;
  };
  const recorded: RelationalStore = {
    prepare: (sql: string) => {
      const current=frame(sql), statementId='statement-'+String(++sequence);
      const event: StatementEvent={...current,kind:'prepare',statementId,sql,binds:[]};
      emitEvent(event);
      try {
        preparationBoundary?.(event);
        options.prepared?.(event);
        return observe({statement:db.prepare(sql),sql,binds:[],statementId,frame:current});
      } catch(error){event.failed=true;throw error}
    },
    batch: (batch: PreparedStatement[]) => {
      const held = batch.map(statement => {
        const original = originals.get(statement) ?? (isMarked(statement) ? statement[originalKey] : undefined);
        if (original === undefined) throw new Error('Recorded batch requires statements from its own store');
        return original;
      });
      const entries = held.map(value => begin(value, 'batch'));
      return track((async()=>{
        try {
          if(options.before)for (const entry of entries)await options.before(entry);
          const results = await db.batch(held.map(value => value.statement));
          results.forEach((result, index) => accounting(result, entries[index]!,options.captureRows));
          return results;
        } catch (error) {
          for (const entry of entries) entry.failed = true;
          for (const event of events) if(event.kind==='execute' && entries.some(entry=>entry.statementId===event.statementId))event.failed=true;
          throw error;
        } finally { if(options.after)for (const entry of entries)await options.after(entry); }
      })());
    },
  };
  return {
    db: recorded, statements, events,
    drain: async () => {
      const failures:unknown[]=[];
      while(pending.size)for(const result of await Promise.allSettled([...pending]))if(result.status==='rejected')failures.push(result.reason);
      if(failures.length)throw new AggregateError(failures,'Recorded deferred statements failed');
    },
    reset: () => {if(pending.size)throw new Error('Cannot reset a recorder with pending statements');statements.length=0;events.length=0;sequence=0;},
  };
}

/** Captures one typed read for plan replay and statement substitution assertions. */
export async function observeStatement(db: RelationalStore, read: (db: RelationalStore) => Promise<unknown>): Promise<RecordedStatement> {
  const observed = statementRecorder(db, { accounting: 'native' });
  await read(observed.db);
  if (observed.statements.length !== 1) throw new Error('Expected one observed typed-operation statement, received ' + observed.statements.length);
  return observed.statements[0]!;
}

export const handledRequestContext=new AsyncLocalStorage<{id:string|null;path:string}>();
export function observeHandledException(error:unknown):void {
 console.error(JSON.stringify({kind:'parity_handled_exception',...handledRequestContext.getStore(),error:error instanceof Error?error.stack:String(error)}));
}

export const MATERIAL_RELATIONS = [
  'prompt_batches', 'responses', 'tool_calls', 'plans', 'embedding_sources', 'processed_resources',
  'prompt_batches_fts', 'responses_fts', 'tool_calls_fts', 'plans_fts', 'search_blob_chunks_fts',
] as const;
const materialRelations = new Set<string>(MATERIAL_RELATIONS);

function sqlTokens(sql:string):string[] {
 const tokens:string[]=[];
 for(let i=0;i<sql.length;) {
  if(/\s/.test(sql[i]!)){i++;continue;}
  if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
  if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);i=end<0?sql.length:end+2;continue;}
  const quote=sql[i]!;
  if([34,39,96,91].includes(quote.charCodeAt(0))){
   const close=quote==='['?']':quote;let value='';i++;
   while(i<sql.length){if(sql[i]===close){if(sql[i+1]===close){value+=close;i+=2;continue;}i++;break;}value+=sql[i++]!;}
   tokens.push('quoted:'+value);continue;
  }
  const word=/^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
  if(word){tokens.push(word[0]);i+=word[0].length;}else{tokens.push(sql[i]!);i++;}
 }
 return tokens;
}

const SQL_RELATION_CACHE_LIMIT=256;
const relationCache=new Map<string,readonly string[]>();
function sqlRelations(sql:string):readonly string[]{
 const cached=relationCache.get(sql);if(cached)return cached;
 const tokens=sqlTokens(sql);
 const relations:string[]=[];
 for(let i=0;i<tokens.length;i++){
  if(!/^(?:FROM|JOIN|UPDATE|INTO)$/i.test(tokens[i]!))continue;
  let name=tokens[i+1]?.replace(/^quoted:/,'');
  if(tokens[i+2]==='.')name=tokens[i+3]?.replace(/^quoted:/,'');
  if(name!==undefined)relations.push(name.toLowerCase());
 }
 if(relationCache.size>=SQL_RELATION_CACHE_LIMIT)relationCache.delete(relationCache.keys().next().value!);
 relationCache.set(sql,relations);
 return relations;
}
export function protectedSql(sql: string): boolean {
 return sqlRelations(sql).some(name=>materialRelations.has(name)||/^(?:session_views|view_(?:visible|instances|prompts|responses|tool_calls|plans|content_proofs|findings|checkpoints|checkpoint_chunks|key_owners)(?:_fts)?)$/.test(name));
}


export interface BoundaryStatement {
 sql:string;operation:string;phase:string;statementId:string;exceptionId?:string;origin?:PreparationOrigin;captured?:boolean;
}
export interface RuntimeException {id:string;operation:string;phase:string;statementId:string;sql:string}
type PhysicalOrigin=Extract<PreparationOrigin,{kind:'exception'}>;
const originIndexes=new WeakMap<readonly PhysicalOrigin[],ReadonlyMap<string,readonly PhysicalOrigin[]>>();
export async function checkedPreparationOrigins(value:{encoding:string;sha256:string;data:string}):Promise<Extract<PreparationOrigin,{kind:'exception'}>[]>{
 if(value.encoding!=='gzip-base64-json')throw new Error('Unknown preparation origin encoding');
 const compressed=Uint8Array.from(atob(value.data),letter=>letter.charCodeAt(0));
 const bytes=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 if(digest!==value.sha256)throw new Error('Preparation origins differ');
 const rows:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!Array.isArray(rows))throw new Error('Preparation origins must be an array');
 return rows.map(checkedPreparationOrigin);
}
export function checkedPreparationOrigin(value:unknown):Extract<PreparationOrigin,{kind:'exception'}>{
 if(Array.isArray(value)&&value.length===5){const [id,file,owner,expression,phase]=value;return checkedPreparationOrigin({id,file,owner,expression,phase});}
 if(typeof value!=='object'||value===null||!('id'in value)||typeof value.id!=='string'||!('file'in value)||typeof value.file!=='string'||!('owner'in value)||typeof value.owner!=='string'||!('expression'in value)||typeof value.expression!=='string'||!('phase'in value)||!['W','P','H','T'].some(phase=>phase===value.phase))throw new Error('Invalid frozen preparation origin');
 const phase=value.phase;if(phase!=='W'&&phase!=='P'&&phase!=='H'&&phase!=='T')throw new Error('Unknown preparation phase');
 return {kind:'exception',id:value.id,file:value.file,owner:value.owner,expression:value.expression,phase};
}
export function readPreparationViolations(statements:readonly BoundaryStatement[],options:{
 known:ReadonlySet<string>;legacy:ReadonlySet<string>;origins:readonly Extract<PreparationOrigin,{kind:'exception'}>[];exceptions?:readonly RuntimeException[];
}):string[]{
 const errors:string[]=[];
 let indexed=originIndexes.get(options.origins);
 if(!indexed){
  const rows=new Map<string,PhysicalOrigin[]>();
  for(const origin of options.origins){const held=rows.get(origin.id)??[];held.push(origin);rows.set(origin.id,held);}
  indexed=rows;originIndexes.set(options.origins,indexed);
 }
 for(const statement of statements){
  const match=/^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(statement.sql),tag=match?.[1];
  if(tag!==undefined){
   if(!options.known.has(tag)){errors.push('unknown operation '+tag);continue;}
   if(statement.origin?.kind!=='module'){errors.push('forged module operation '+tag);continue;}
   const text=statement.sql.slice(match![0].length);
   if(text.includes('/*vs:'))errors.push('multiple operation tags');
   if(tag.startsWith('N:'))continue;
   if(options.legacy.has(tag)){
    if(sqlRelations(text).some(name=>name==='session_views'||name.startsWith('view_')))errors.push('legacy-only operation reads view rows');
   }else if(!statement.captured)errors.push('nonmember missing source capture: '+tag);
   continue;
  }
  if(!protectedSql(statement.sql))continue;
  if(options.exceptions?.some(item=>item.id===statement.exceptionId&&item.operation===statement.operation&&item.phase===statement.phase&&item.statementId===statement.statementId&&item.sql===statement.sql))continue;
  const origin=statement.origin;
  if(origin?.kind==='oracle'&&oracleTokens.get(origin)===statement.sql)continue;
  if(origin?.kind==='exception'&&statement.phase===origin.phase&&statement.exceptionId===origin.id&&indexed.get(origin.id)?.some(expected=>expected.file===origin.file&&expected.owner===origin.owner&&expected.expression===origin.expression&&expected.phase===origin.phase))continue;
  errors.push('untagged protected SQL: '+statement.operation+'/'+statement.statementId);
 }
 return errors;
}

const nativeSpans=new AsyncLocalStorage<StatementFrame>();
const clockInstants=new AsyncLocalStorage<number>();
export const observedClockNow=()=>clockInstants.getStore()??Date.now();
export function withObservedClock<T>(at:number|undefined,run:()=>T):T{return at===undefined?run():clockInstants.run(at,run);}
export function instrumentObservedClock(compiler:typeof ts,source:string,file:string,recorder:string):string{
 if(file!=='packages/myco-server/src/platform/cloudflare/deployment-clock.ts')return source;
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true),edits:ts.CallExpression[]=[];
 const visit=(node:ts.Node):void=>{if(compiler.isCallExpression(node)&&node.expression.getText(tree)==='Date.now'&&node.arguments.length===0)edits.push(node);compiler.forEachChild(node,visit);};visit(tree);
 if(edits.length===0)throw new Error('Controlled clock requires the actual clock time seam');
 let output=source;for(const node of edits.sort((a,b)=>b.getStart(tree)-a.getStart(tree)))output=output.slice(0,node.getStart(tree))+'__observedClockNow()'+output.slice(node.getEnd());
 return 'import {observedClockNow as __observedClockNow} from '+JSON.stringify(recorder)+';\n'+output;
}
let spanSequence=0;
const spanObservers=new Set<(frame:StatementFrame)=>void>();
export function observeStatementSpans(observe:(frame:StatementFrame)=>void):()=>void{
 spanObservers.add(observe);return ()=>{spanObservers.delete(observe);};
}
export function withStatementSpan<T>(operation:string,phase:string,run:()=>T):T{
 const parent=nativeSpans.getStore();
 const frame:StatementFrame={operation,phase,spanId:'native-span-'+String(++spanSequence),...(parent?.spanId?{parentSpanId:parent.spanId}:{})};
 for(const observe of spanObservers)observe(frame);
 return nativeSpans.run(frame,run);
}
export function withReadRequest<T>(request:Request,run:()=>T):T{
 return withStatementSpan(request.method+' '+new URL(request.url).pathname,'entry',run);
}
export function instrumentNativeReadRequests(compiler:typeof ts,source:string,file:string,recorder:string):string{
 if(file!=='packages/myco-server/src/entry/bun.ts')return source;
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true),edits:{start:number;end:number;text:string}[]=[];
 const visit=(node:ts.Node):void=>{
  if(compiler.isCallExpression(node)&&compiler.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='handleRequest'&&['server','internal'].includes(node.expression.expression.getText(tree))&&['core','createBunHandler'].includes(preparationOwner(compiler,node,tree))&&node.arguments[0]?.getText(tree)==='request'){
   edits.push({start:node.getStart(tree),end:node.getEnd(),text:'__nativeReadRequest(request,()=>'+node.getText(tree)+')'});return;
  }
  compiler.forEachChild(node,visit);
 };visit(tree);
 if(edits.length!==2)throw new Error('Native request observation requires both shipped dispatches');
 let output=source;for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
 return 'import {withReadRequest as __nativeReadRequest} from '+JSON.stringify(recorder)+';\n'+output;
}

export interface ReadTrace {events:StatementEvent[];statements:RecordedStatement[];spans:StatementFrame[];constructors:StatementFrame[]}
function isFrame(value:unknown):value is StatementFrame{
 return typeof value==='object'&&value!==null&&'operation'in value&&typeof value.operation==='string'&&'phase'in value&&typeof value.phase==='string';
}
function isStatement(value:unknown):value is RecordedStatement{
 return isFrame(value)&&'statementId'in value&&typeof value.statementId==='string'&&'sql'in value&&typeof value.sql==='string'&&'binds'in value&&Array.isArray(value.binds)&&'method'in value&&['first','all','run','batch'].some(method=>method===value.method);
}
function isEvent(value:unknown):value is StatementEvent{
 return isFrame(value)&&'statementId'in value&&typeof value.statementId==='string'&&'sql'in value&&typeof value.sql==='string'&&'binds'in value&&Array.isArray(value.binds)&&'kind'in value&&['prepare','bind','execute'].some(kind=>kind===value.kind);
}
export function decodeReadTrace(records:readonly unknown[]):ReadTrace{
 const trace:ReadTrace={events:[],statements:[],spans:[],constructors:[]};
 for(const row of records){
  if(typeof row!=='object'||row===null||!('kind'in row))throw new Error('Invalid Worker read observation');
  if(row.kind==='view_read_event'&&'event'in row&&isEvent(row.event))trace.events.push(row.event);
  else if(row.kind==='view_read_statement'&&isStatement(row))trace.statements.push(row);
  else if(row.kind==='view_read_span'&&isFrame(row))trace.spans.push(row);
  else if(row.kind==='view_read_constructor'&&isFrame(row))trace.constructors.push(row);
  else throw new Error('Unclassified Worker read observation');
 }
 return trace;
}

const physicalObservers=new Set<(record:{kind:'event';value:StatementEvent}|{kind:'statement';value:RecordedStatement})=>void>();
let physicalSequence=0;
export function observePhysicalStatements(observe:(record:{kind:'event';value:StatementEvent}|{kind:'statement';value:RecordedStatement})=>void):()=>void{
 physicalObservers.add(observe);return ()=>{physicalObservers.delete(observe);};
}
export function withPhysicalPreparation<T>(origin:PreparationOrigin,sql:string,method:string,make:()=>T):T{
 const supplied=nativeSpans.getStore(),frame:StatementFrame={operation:supplied?.operation??(origin.kind==='exception'?origin.file+'#'+origin.owner:'physical'),phase:origin.kind==='exception'?origin.phase:supplied?.phase??'physical',...(supplied?.spanId?{spanId:supplied.spanId}:{}),...(supplied?.parentSpanId?{parentSpanId:supplied.parentSpanId}:{}),origin,...(origin.kind==='exception'?{exceptionId:origin.id}:{})};
 const statementId='physical-'+String(++physicalSequence);
 const emit=(event:StatementEvent)=>{for(const observe of physicalObservers)observe({kind:'event',value:event});};
 const prepared:StatementEvent={...frame,kind:'prepare',statementId,sql,binds:[]};
 emit(prepared);
 const execute=<R>(kind:RecordedStatement['method'],binds:readonly unknown[],run:()=>R):R=>{
  const bind:StatementEvent={...frame,kind:'bind',statementId,sql,binds};emit(bind);
  const entry:RecordedStatement={...frame,statementId,sql,binds,method:kind},event:StatementEvent={...entry,kind:'execute'};emit(event);
  try{const result=run();if(kind==='all'&&Array.isArray(result))entry.rowCount=result.length;else if(kind==='first')entry.rowCount=result===null?0:1;return result;}
  catch(error){entry.failed=true;event.failed=true;throw error;}
  finally{for(const observe of physicalObservers)observe({kind:'statement',value:entry});}
 };
 try{
  preparationBoundary?.(prepared);
  if(method==='exec')return execute('run',[],()=>withReadPreparation(origin,make));
  const value=withReadPreparation(origin,make);
  if(typeof value!=='object'||value===null||!('get'in value)||typeof value.get!=='function')return value;
  return new Proxy(value,{get(target,key,receiver){
   const selected=Reflect.get(target,key,target);
   if(key==='iterate'&&typeof selected==='function')return function*(...binds:unknown[]){
    emit({...frame,kind:'bind',statementId,sql,binds});
    const entry:RecordedStatement={...frame,statementId,sql,binds,method:'all',nativeMethod:'iterate',rowCount:0},event:StatementEvent={...entry,kind:'execute'};emit(event);
    try{
     const iterator:unknown=Reflect.apply(selected,target,binds);
     if(!isIterable(iterator))throw new Error('Native SQLite returned no row iterator');
     for(const row of iterator){entry.rowCount!++;yield row;}
    }catch(error){entry.failed=true;event.failed=true;throw error;}
    finally{for(const observe of physicalObservers)observe({kind:'statement',value:entry});}
   };
   if(typeof selected==='function'&&['get','all','run'].some(method=>method===key))return (...binds:unknown[])=>execute(key==='get'?'first':key==='all'?'all':'run',binds,()=>Reflect.apply(selected,target,binds));
   return typeof selected==='function'?selected.bind(target):selected;
  }});
 }catch(error){prepared.failed=true;throw error;}
}
function isIterable(value:unknown):value is Iterable<unknown>{return typeof value==='object'&&value!==null&&typeof Reflect.get(value,Symbol.iterator)==='function';}
