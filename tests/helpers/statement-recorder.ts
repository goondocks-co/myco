import {AsyncLocalStorage} from 'node:async_hooks';
import {inheritStoreContext} from '../../packages/myco-server/src/core/adapters.js';
import type ts from 'typescript-v6';
import type { RelationalStore, PreparedStatement } from '../../packages/myco-server/src/core/adapters.js';

export interface StatementFrame {
  operation: string;
  phase: string;
  spanId?: string;
  parentSpanId?: string;
  exceptionId?: string;
  origin?: PreparationOrigin;
  captured?: boolean;
}

export type PreparationOrigin = {kind:'module';capture?:unknown;callers?:readonly string[];replay?:string} | {kind:'oracle';sha256:string} | {
 kind:'exception';id:string;file:string;owner:string;expression:string;phase:'W'|'P'|'H'|'T';relations?:readonly string[];
 callers?:readonly string[];callerKeys?:readonly string[];callerRelations?:readonly {callers:readonly string[];relations:readonly string[]}[];
 nonSql?:boolean;
};
export interface PreparationCaller {key:string;file:string;owner:string;callee:string;argument:string;index:number}
export interface SqlSinkParameter {file:string;owner:string;index:number;path:readonly string[]}
export interface SqlDeclarationPin {file:string;name:string;sha256:string}
export interface SqlParameterCaller extends PreparationCaller {sink:SqlSinkParameter;dependencies:readonly SqlDeclarationPin[];parameters:readonly SqlSinkParameter[];activeParameters?:readonly SqlSinkParameter[]}
export interface SqlExceptionClosure {file:string;owner:string;expression:string;dependencies:readonly SqlDeclarationPin[];parameters:readonly SqlSinkParameter[];activeParameters?:readonly SqlSinkParameter[];unresolved:readonly string[]}
export const OPEN_RELATION_PREPARATIONS=[
 {file:'packages/myco/src/member/legacy-backup.ts',owner:'legacyVaultHasContent',expression:'`SELECT 1 FROM ${table} LIMIT 1`',reason:'Reads every present table named by BACKUP_TABLES in member/legacy-backup.ts.'},
 {file:'packages/myco/src/member/legacy-backup.ts',owner:'vaultContent',expression:'`SELECT * FROM ${table}`',reason:'Hashes every present table named by BACKUP_TABLES in member/legacy-backup.ts.'},
 {file:'packages/myco/src/server/recovery-sql.ts',owner:'writeRecoverySql',expression:'`SELECT ${selected} FROM ${identifier(table.name)}`',reason:'Exports all ordinary tables returned by SCHEMA_QUERY and tableOrder in server/recovery-sql.ts.'},
 {file:'packages/myco/src/server/recovery-sql.ts',owner:'tableOrder',expression:'`PRAGMA foreign_key_list(${identifier(name)})`',reason:'Orders every ordinary table from the SCHEMA_QUERY result by its catalog foreign-key list.'},
 {file:'packages/myco/src/server/recovery-sql.ts',owner:'writeRecoverySql',expression:'`PRAGMA table_xinfo(${identifier(table.name)})`',reason:'Lists columns of every ordinary table from SCHEMA_QUERY and tableOrder before exporting its rows.'},
 {file:'packages/myco/src/server/recovery-bundle.ts',owner:'rows',expression:'sql',reason:'Checks every ordinary table returned by pragma_table_list and its pragma_table_info columns in refuseUnsafeNumbers.'},
 {file:'packages/myco/src/server/sql-dump.ts',owner:'runOneStatement',expression:'sql',reason:'Imports schema objects and rows from the provider dump scanned by importTableDump and validated by refuseForeignDumpStatement.'},
 {file:"packages/myco-server/src/core/relational-snapshot.ts",owner:'relationalSnapshot',expression:"admissionSql",reason:"Measures every caller-named table using its PRAGMA table_info columns in relationalSnapshot."},
 {file:"packages/myco-server/src/core/relational-snapshot.ts",owner:'relationalSnapshot',expression:"`WITH admission AS MATERIALIZED (${admissionSql}),\n    snapshot_rows AS MATERIALIZED (${unionGroups(selections)}),\n    snapshot_size AS (SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(length(CAST(line AS BLOB)) + 1), 0) AS snapshot_bytes FROM snapshot_rows)\n    SELECT admission_count, admission_bytes, snapshot_count, snapshot_bytes, line FROM admission CROSS JOIN snapshot_size\n    LEFT JOIN snapshot_rows ON snapshot_bytes <= ? ORDER BY ordinal, rid`",reason:"Snapshots every caller-named table and its PRAGMA table_info columns in relationalSnapshot."},
] as const;
const oracleTokens=new WeakMap<PreparationOrigin,string>();
/** The frozen program loader issues tokens bound to admitted statement text. */
export function createOracleLoader(){
 return (sql:string,sha256:string):PreparationOrigin=>{
  const origin:PreparationOrigin=Object.freeze({kind:'oracle',sha256});
  oracleTokens.set(origin,sql);return origin;
 };
}
const preparations=new AsyncLocalStorage<PreparationOrigin>();
const callers=new AsyncLocalStorage<readonly string[]>();
interface PreparedExecution { sql:string; origin:PreparationOrigin }
const executions=new AsyncLocalStorage<readonly PreparedExecution[]>();
const preparedReads=new WeakMap<object,readonly PreparedExecution[]>();
const modulePreparations=new Map<string,Extract<PreparationOrigin,{kind:'module'}>>();
const EXPLAIN_REPLAY_PREFIX='EXPLAIN QUERY PLAN ';
function executionOrigin(sql:string):PreparationOrigin|undefined{
 const matching=(executions.getStore()??[]).filter(entry=>entry.sql===sql);
 const first=matching[0]?.origin;
 const identity=(origin:PreparationOrigin):string=>JSON.stringify(origin);
 if(first&&matching.some(({origin})=>origin!==first&&(origin.kind==='oracle'||first.kind==='oracle'
  ?origin.kind!=='oracle'||first.kind!=='oracle'||oracleTokens.get(origin)!==sql||oracleTokens.get(first)!==sql
  :identity(origin)!==identity(first))))throw new Error('Conflicting prepared execution provenance');
 if(first)return first;
 if(sql.startsWith(EXPLAIN_REPLAY_PREFIX)){
  const original=sql.slice(EXPLAIN_REPLAY_PREFIX.length),prepared=modulePreparations.get(original);
  if(prepared!==undefined)return {...prepared,replay:original};
 }
 return undefined;
}
function retainPreparedRead<T>(value:T,execution:PreparedExecution):T{
 if(typeof value!=='object'||value===null)return value;
 const frames=preparedReads.get(value)??[];
 const same=(frame:PreparedExecution)=>frame.sql===execution.sql&&(frame.origin.kind==='oracle'||execution.origin.kind==='oracle'
  ?frame.origin===execution.origin:JSON.stringify(frame.origin)===JSON.stringify(execution.origin));
 if(!frames.some(same))preparedReads.set(value,[...frames,execution]);
 return value;
}
/** Prepared methods retain exact SQL provenance and original adapter handles. */
export function withPreparedMethod<T>(receiver:unknown,method:unknown,run:()=>T):T{
 if(!['bind','first','all','run'].some(name=>name===method)||typeof receiver!=='object'||receiver===null)return run();
 const frames=preparedReads.get(receiver);if(!frames)return run();
 return executions.run(frames,()=>{
  const value=run();if(method==='bind')for(const frame of frames)retainPreparedRead(value,frame);
  return value;
 });
}
/** Only tracked receivers scope prepared methods; calls receive their original handle. */
export function preparedMethodReceiver(receiver:unknown):unknown{
 if(typeof receiver!=='object'||receiver===null||!preparedReads.has(receiver))return receiver;
 return new Proxy({},{get(_target,key){
  const selected=Reflect.get(receiver,key,receiver);
  if(typeof selected!=='function')return selected;
  return (...args:unknown[])=>withPreparedMethod(receiver,key,()=>Reflect.apply(selected,receiver,args));
 }});
}
interface PreparedCallChain {
 value:unknown;
 member(optional:boolean):((key:PropertyKey)=>PreparedCallChain)|undefined;
 call(optional:boolean,scope?:(args:readonly unknown[],invoke:(args:readonly unknown[])=>unknown)=>unknown):((...args:unknown[])=>PreparedCallChain)|undefined;
}
/** Chain links distinguish a skipped optional access from an undefined result. */
export function preparedCallChain(value:unknown,receiver?:unknown,key?:PropertyKey):PreparedCallChain{
 return {value,member(optional){
  if(optional&&(value===null||value===undefined))return undefined;
  return selected=>{
   const property=value===null||value===undefined?selected:Reflect.ownKeys({[selected]:undefined})[0]!;
   return preparedCallChain((value as Record<PropertyKey,unknown>)[property],value,property);
  };
 },call(optional,scope){
  if(optional&&(value===null||value===undefined))return undefined;
  const invoke=(args:readonly unknown[])=>withPreparedMethod(receiver,key,()=>Reflect.apply(value as (...args:unknown[])=>unknown,receiver,args));
  return (...args)=>preparedCallChain(scope?scope(args,invoke):invoke(args));
 }};
}
/** Parentheses retain member references and end optional short-circuit propagation. */
export function preparedChainBoundary(link:PreparedCallChain|undefined):PreparedCallChain{return link??preparedCallChain(undefined)}
/** Batch provenance comes from every original statement in the supplied array. */
export function withPreparedBatch<T>(args:readonly unknown[],run:(args:readonly unknown[])=>T):T{
 const selected=args[0];if(!Array.isArray(selected))return run(args);
 const frames:PreparedExecution[]=[];let untracked=false;
 for(const statement of selected){
  const held=typeof statement==='object'&&statement!==null?preparedReads.get(statement):undefined;
  if(held)frames.push(...held);else untracked=true;
 }
 return executions.run(untracked?[]:frames,()=>run(args));
}
/** Deferred adapters retain the preparation's origin only for its exact SQL bytes. */
export function withPreparedRead<T>(origin:PreparationOrigin,sql:string,run:()=>T):T{
 const inherited=executionOrigin(sql)??origin;
 const prepared=inherited.kind==='exception'||inherited.kind==='module'?{...inherited,callers:inherited.callers??callers.getStore()??[]}:inherited;
 const execution={origin:prepared,sql};
 return executions.run([execution],()=>{
  const value=run();
  if(prepared.kind==='module'&&prepared.replay===undefined)modulePreparations.set(sql,prepared);
  return retainPreparedRead(value,execution);
 });
}
/** Independent operations start outside another statement's preparation and caller scopes. */
export function withIndependentReadPreparation<T>(run:()=>T):T{
 return executions.exit(()=>preparations.exit(()=>callers.exit(run)));
}
export function withPreparationCaller<T>(keys:readonly string[],run:()=>T):T{return callers.run([...(callers.getStore()??[]),...keys],run);}
const observedStores=new WeakMap<object,'native'|'d1'>();
const observedFiles=new Map<string,Set<'native'|'d1'>>();
const observedFileScope=new AsyncLocalStorage<string>();
export function withObservedReadFile<Args extends unknown[],R>(file:string,run:(...args:Args)=>R):(...args:Args)=>R{
 const wrapped=function(this:unknown,...args:Args):R{return observedFileScope.run(file,()=>run.apply(this,args));};
 Object.defineProperty(wrapped,'length',{value:run.length});return wrapped;
}
export function noteObservedReadFile(target:'native'|'d1',source=observedFileScope.getStore()):void{
 if(source===undefined)return;
 const targets=observedFiles.get(source)??new Set<'native'|'d1'>();targets.add(target);observedFiles.set(source,targets);
}
export function markObservedReadStore<T extends object>(store:T,target:'native'|'d1'):T{observedStores.set(store,target);return store;}
export function forwardObservedReadStore<T extends object>(store:T,observed:object):T{
 const target=observedStores.get(observed);
 if(target===undefined)throw new Error('view_store_observer_missing');
 return markObservedReadStore(store,target);
}
export function assertObservedReadStore<T extends object>(store:T,file:string):T{
 const target=observedStores.get(store);
 if(target===undefined)throw new Error('view_store_unobserved: '+file);
 noteObservedReadFile(target,file);noteObservedReadFile(target);
 return store;
}
export async function assertObservedReadStorePromise<T extends object>(store:Promise<T>,file:string):Promise<T>{return assertObservedReadStore(await store,file);}
function observedFactoryResult(value:unknown,file:string):object{
 if(typeof value!=='object'||value===null)throw new Error('view_store_unobserved: '+file);
 return assertObservedReadStore(value,file);
}
/** Factory calls admit their actual result while optional calls retain skipped receivers. */
export function observedReadFactory(factory:unknown,file:string,asynchronous:boolean):unknown{
 if(typeof factory!=='function')return factory;
 return function(this:unknown,...args:unknown[]):unknown{
  const value=Reflect.apply(factory,this,args);
  return asynchronous?Promise.resolve(value).then(value=>observedFactoryResult(value,file)):observedFactoryResult(value,file);
 };
}
/** Method factories preserve their original receiver and optional member access. */
export function observedReadFactoryReceiver(receiver:unknown,file:string,method:string,asynchronous:boolean):unknown{
 if(receiver===undefined||receiver===null)return receiver;
 const source=Object(receiver);
 return new Proxy({},{get(_target,key){
  const selected=Reflect.get(source,key,receiver);if(key!==method)return selected;
  const wrapped=observedReadFactory(selected,file,asynchronous);
  return typeof wrapped==='function'?wrapped.bind(receiver):wrapped;
 }});
}

export function observedReadStoreFiles(){return new Map([...observedFiles].map(([file,targets])=>[file,new Set(targets)]));}
let preparationBoundary:((statement:StatementEvent)=>void)|undefined;
export function installReadPreparationBoundary(check:(statement:StatementEvent)=>void):void{preparationBoundary=check;}
export function withReadPreparation<T>(origin:PreparationOrigin,run:()=>T):T{
 return preparations.getStore()===undefined?preparations.run(origin.kind==='exception'?{...origin,callers:origin.callers??callers.getStore()??[]}:origin,run):run();
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

/** Native and mixed platform separators identify the same repository source. */
export function preparationSourcePaths(repository:string){
 const root=repository.replace(/\\/g,'/').replace(/\/$/,'');
 const escaped=root.split('/').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\\\/]');
 const filter=new RegExp('^'+escaped+'[\\\\/](?:packages[\\\\/](?:myco-server|myco|myco-shared)[\\\\/]src|tests)[\\\\/].*\\.tsx?$',/^[A-Za-z]:/.test(root)?'i':'');
 return {filter,relative(file:string){
  const normalized=file.replace(/\\/g,'/'),prefix=root+'/';
  const contains=/^[A-Za-z]:/.test(root)?normalized.toLowerCase().startsWith(prefix.toLowerCase()):normalized.startsWith(prefix);
  return contains?normalized.slice(prefix.length):normalized;
 }};
}

/** Every native, local D1 and operator factory result must carry the installed observer. */
export function instrumentObservedStores(compiler:typeof ts,source:string,file:string,recorder:string):string{
 if(file==='tests/setup/view-read-preload.ts'||file==='tests/helpers/statement-recorder.ts')return source;
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true),names=new Set(['sqliteRelationalStore','d1OperatorStore']);
 for(const node of tree.statements)if(compiler.isImportDeclaration(node)&&node.importClause?.namedBindings&&compiler.isNamedImports(node.importClause.namedBindings)){
  for(const item of node.importClause.namedBindings.elements)if(names.has(item.propertyName?.text??item.name.text))names.add(item.name.text);
 }
 const edits:{start:number;end:number;head:string;tail:string}[]=[];
 const visit=(node:ts.Node):void=>{
  if(compiler.isCallExpression(node)){
   const name=compiler.isIdentifier(node.expression)?node.expression.text:compiler.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
   if(names.has(name)||name==='getD1Database'){
    const member=compiler.isPropertyAccessExpression(node.expression),receiver=member?node.expression.expression:node.expression;
    edits.push({start:receiver.getStart(tree),end:receiver.getEnd(),head:member?'__viewObservedReceiver(':'__viewObservedFactory(',tail:','+JSON.stringify(file)+(member?','+JSON.stringify(name):'')+','+(name==='getD1Database')+')'});
   }
  }
  compiler.forEachChild(node,visit);
 };visit(tree);
 if(edits.length===0)return source;
 const positions=[...new Set(edits.flatMap(edit=>[edit.start,edit.end]))].sort((a,b)=>a-b);
 let output='',at=0;
 for(const position of positions){
  output+=source.slice(at,position)+edits.filter(edit=>edit.end===position).sort((a,b)=>b.start-a.start).map(edit=>edit.tail).join('')+edits.filter(edit=>edit.start===position).sort((a,b)=>b.end-a.end).map(edit=>edit.head).join('');at=position;
 }
 return 'import {observedReadFactory as __viewObservedFactory,observedReadFactoryReceiver as __viewObservedReceiver} from '+JSON.stringify(recorder)+';\n'+output+source.slice(at);
}

/** Test callbacks retain their file identity across asynchronous fixture factories and reads. */
export function instrumentObservedReadFiles(compiler:typeof ts,source:string,file:string,recorder:string):string{
 if(!file.startsWith('tests/')||!file.endsWith('.test.ts')&&!file.endsWith('.test.tsx'))return source;
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true),edits:{at:number;text:string}[]=[];
 const visit=(node:ts.Node):void=>{
  if(compiler.isCallExpression(node)){
   const name=node.expression.getText(tree),hook=/^(?:beforeAll|beforeEach|afterAll|afterEach)$/.test(name);
   if(hook||/^(?:test|it)(?:[.(]|$)/.test(name)){
    const callback=node.arguments[hook?0:1];
    if(callback&&(compiler.isArrowFunction(callback)||compiler.isFunctionExpression(callback)||compiler.isIdentifier(callback))){
     edits.push({at:callback.getStart(tree),text:'__viewObservedFile('+JSON.stringify(file)+','},{at:callback.getEnd(),text:')'});
    }
   }
  }
  compiler.forEachChild(node,visit);
 };visit(tree);
 if(edits.length===0)return source;
 let output=source;
 for(const edit of edits.sort((a,b)=>b.at-a.at))output=output.slice(0,edit.at)+edit.text+output.slice(edit.at);
 return 'import {withObservedReadFile as __viewObservedFile} from '+JSON.stringify(recorder)+';\n'+output;
}

/** Separates regular-expression execution from SQL preparation. */
export function isSqlPreparation(compiler:typeof ts,node:ts.CallExpression,tree:ts.SourceFile):boolean{
 if(!compiler.isPropertyAccessExpression(node.expression)||!['prepare','query','exec'].includes(node.expression.name.text)||!node.arguments[0])return false;
 if(node.expression.name.text!=='exec')return true;
 const seen=new Set<ts.Node>();
 const regex=(value:ts.Node):boolean=>{
  if(seen.has(value))return false;seen.add(value);
  if(compiler.isRegularExpressionLiteral(value)||compiler.isNewExpression(value)&&value.expression.getText(tree)==='RegExp')return true;
  if(compiler.isObjectLiteralExpression(value))return value.properties.length>0&&value.properties.every(property=>compiler.isPropertyAssignment(property)&&regex(property.initializer));
  if(compiler.isElementAccessExpression(value)||compiler.isPropertyAccessExpression(value))return regex(value.expression);
  if(compiler.isParenthesizedExpression(value)||compiler.isAsExpression(value)||compiler.isNonNullExpression(value))return regex(value.expression);
  if(!compiler.isIdentifier(value))return false;
  for(let at:ts.Node|undefined=node;at;at=at.parent){
   if(compiler.isFunctionLike(at))for(const parameter of at.parameters)if(parameter.name.getText(tree)===value.text&&parameter.type?.getText(tree)==='RegExp')return true;
   if(compiler.isSourceFile(at)||compiler.isBlock(at))for(const statement of at.statements)if(compiler.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(tree)===value.text&&declaration.initializer)return regex(declaration.initializer);
  }
  return false;
 };
 return !regex(node.expression.expression);
}
/** Seals exact admitted preparation sites and SQL callers in test builds. */
export function instrumentReadPreparations(compiler:typeof ts,source:string,file:string,origins:readonly Extract<PreparationOrigin,{kind:'exception'}>[],recorder:string,callerPins:readonly PreparationCaller[]=[]):string{
 const tree=compiler.createSourceFile(file,source,compiler.ScriptTarget.Latest,true);
 const candidates=origins.filter(origin=>origin.file===file&&!origin.nonSql),sites=callerPins.filter(caller=>caller.file===file);
 const edits:{node:ts.CallExpression|ts.PropertyAccessExpression|ts.ElementAccessExpression;origin?:PreparationOrigin;keys:string[];batch:boolean;method:boolean;chain?:boolean}[]=[];
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
  if(compiler.isCallExpression(node)){
   const owner=preparationOwner(compiler,node,tree),callee=node.expression.getText(tree);
   const keys=sites.filter(site=>site.owner===owner&&site.callee===callee&&(node.arguments[site.index]?.getText(tree)??'<omitted>')===site.argument).map(site=>site.key);
   let origin:PreparationOrigin|undefined;
   if(compiler.isPropertyAccessExpression(node.expression)&&isSqlPreparation(compiler,node,tree)&&node.arguments[0]){
    const expression=node.arguments[0].getText(tree);
    const expected=candidates.find(item=>item.owner===owner&&item.expression===expression);
    origin=file==='packages/myco-server/src/read/view-store.ts'&&owner==='prepareViewRead'&&node.expression.name.text==='prepare'?{kind:'module'}:expected&&{kind:'exception',id:expected.id,file:expected.file,owner:expected.owner,expression:expected.expression,phase:expected.phase};
   }
   const batch=compiler.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='batch';
   const method=compiler.isElementAccessExpression(node.expression)||['bind','first','all','run'].includes(compiler.isPropertyAccessExpression(node.expression)?node.expression.name.text:'');
   if(origin||keys.length||batch||method)edits.push({node,origin,keys,batch,method});
  }
  compiler.forEachChild(node,visit);
 };visit(tree);
 for(const edit of [...edits])if(edit.method&&compiler.isOptionalChain(edit.node)){
  let node:typeof edit.node=edit.node;
  while((compiler.isCallExpression(node.parent)||compiler.isPropertyAccessExpression(node.parent)||compiler.isElementAccessExpression(node.parent))&&compiler.isOptionalChain(node.parent)&&node.parent.expression===node)node=node.parent;
  const expression=edit.node.expression;
  if(node===edit.node&&(compiler.isPropertyAccessExpression(expression)||compiler.isElementAccessExpression(expression))&&!compiler.isOptionalChain(expression.expression))continue;
  if(!edits.some(held=>held.chain&&held.node===node))edits.push({node,keys:[],batch:false,method:false,chain:true});
 }
 if(edits.length===0)return source;
 const scopeBody=(edit:typeof edits[number],body:string,batchInvoke:string):string=>{
  if(edit.batch)body='__viewPreparedBatch(__args,(__batchArgs)=>'+batchInvoke+')';
  if(edit.origin){
   const origin=edit.origin,expression=edit.node.expression,method=compiler.isPropertyAccessExpression(expression)?expression.name.text:'';
   const physical=origin.kind==='exception'&&(method==='query'||method==='exec'||compiler.isPropertyAccessExpression(expression)&&nativeDatabase(expression.expression,edit.node));
   body=physical?'__viewPhysicalPreparation('+JSON.stringify(origin)+',__args[0],'+JSON.stringify(method)+',()=>'+body+')':'__viewPreparedRead('+(origin.kind==='module'&&file==='packages/myco-server/src/read/view-store.ts'&&source.includes('capture?: SourcePreparation')?'{...'+JSON.stringify(origin)+',capture}':JSON.stringify(origin))+',__args[0],()=>'+body+')';
  }
  if(edit.keys.length)body='__viewReadCaller('+JSON.stringify(edit.keys)+',()=>'+body+')';
  return body;
 };
 const render=(start:number,end:number,skip?:typeof edits[number]):string=>{
  const held=edits.filter(edit=>edit!==skip&&edit.node.getStart(tree)>=start&&edit.node.getEnd()<=end).sort((a,b)=>a.node.getStart(tree)-b.node.getStart(tree)||b.node.getEnd()-a.node.getEnd()||Number(!!b.chain)-Number(!!a.chain));
  let output='',at=start;
  for(const edit of held){
   const begin=edit.node.getStart(tree),finish=edit.node.getEnd();if(begin<at)continue;
   output+=source.slice(at,begin);
   if(edit.chain){
    const chain=(node:ts.Expression):string=>{
     if(compiler.isParenthesizedExpression(node)||compiler.isAsExpression(node)||compiler.isTypeAssertionExpression(node)||compiler.isSatisfiesExpression(node))return '__viewChainBoundary('+chain(node.expression)+')';
     if(compiler.isPropertyAccessExpression(node)||compiler.isElementAccessExpression(node)){
      const key=compiler.isPropertyAccessExpression(node)?JSON.stringify(node.name.text):render(node.argumentExpression.getStart(tree),node.argumentExpression.getEnd(),edit);
      return chain(node.expression)+'?.member('+!!node.questionDotToken+')?.('+key+')';
     }
     if(compiler.isNonNullExpression(node))return chain(node.expression);
     if(!compiler.isCallExpression(node))return '__viewPreparedChain('+render(node.getStart(tree),node.getEnd(),edit)+')';
     const scope=edits.find(held=>held.node===node&&!held.chain),body=scope?scopeBody(scope,'__invoke(__args)','__invoke(__batchArgs)'):'__invoke(__args)';
     return chain(node.expression)+'?.call('+!!node.questionDotToken+(body==='__invoke(__args)'?'':',(__args,__invoke)=>'+body)+')?.('+node.arguments.map(argument=>render(argument.getStart(tree),argument.getEnd(),edit)).join(',')+')';
    };
    output+=chain(edit.node)+'?.value';at=finish;continue;
   }
   const node=edit.node;
   if(!compiler.isCallExpression(node))throw new Error('Expected preparation call');
   const expression=node.expression;
   const member=compiler.isPropertyAccessExpression(expression)||compiler.isElementAccessExpression(expression);
   const receiver=member?render(expression.expression.getStart(tree),expression.expression.getEnd(),edit):render(expression.getStart(tree),expression.getEnd(),edit);
   if(edit.method&&!edit.origin&&!edit.keys.length&&!edit.batch&&member){
    output+='__viewPreparedReceiver('+receiver+')'+render(expression.expression.getEnd(),finish,edit);
    at=finish;continue;
   }
   const args=node.arguments.map(argument=>render(argument.getStart(tree),argument.getEnd(),edit));
   const property=compiler.isPropertyAccessExpression(expression)?'.'+expression.name.text:compiler.isElementAccessExpression(expression)?'[__key]':'';
   const key=compiler.isElementAccessExpression(expression)?render(expression.argumentExpression.getStart(tree),expression.argumentExpression.getEnd(),edit):undefined;
   let body=member?'Reflect.apply(__fn,__receiver,__args)':'__fn(...__args)';
   body=scopeBody(edit,body,'Reflect.apply(__fn,__receiver,__batchArgs)');
   const invoke='(...__args)=>'+body;
   const methodReceiver=edit.method?'__viewPreparedReceiver('+receiver+')':receiver;
   body=member?'((__receiver'+(key===undefined?'':',__key')+')=>((__fn)=>'+invoke+')(__receiver'+property+'))('+[methodReceiver,...(key===undefined?[]:[key])].join(',')+')('+args.join(',')+')':'((__fn)=>'+invoke+')('+receiver+')('+args.join(',')+')';
   output+=body;at=finish;
  }
  return output+source.slice(at,end);
 };
 return 'import {withPreparedRead as __viewPreparedRead,withPreparedBatch as __viewPreparedBatch,preparedMethodReceiver as __viewPreparedReceiver,preparedCallChain as __viewPreparedChain,preparedChainBoundary as __viewChainBoundary,withPhysicalPreparation as __viewPhysicalPreparation,withPreparationCaller as __viewReadCaller} from '+JSON.stringify(recorder)+';\n'+render(0,source.length);
}

export interface RecordedStatement extends StatementFrame {
  statementId: string;
  sql: string;
  binds: readonly unknown[];
  method: 'first' | 'all' | 'run' | 'batch';
  rowsRead?: number;
  rowsWritten?: number;
  changes?:number;
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

export function viewDmlBoundary(){
  const violations:StatementEvent[]=[];
  const check=(event:StatementEvent):void=>{
    const tokens=sqlTokens(event.sql);
    if(tokens[0]?.toUpperCase()==='EXPLAIN')return;
    const origin=event.origin;
    if(origin?.kind==='exception'&&['H','P'].includes(origin.phase)
      &&tokens[0]?.toUpperCase()==='CREATE'&&tokens.slice(1,4).some(token=>token.toUpperCase()==='TRIGGER'))return;
    const protectedTable=(table:string)=>{const name=table.replace(/^quoted:/,'').toLowerCase();return name.startsWith('view_')||['session_views','learning_sessions','material_versions'].includes(name);};
    const relation=(at:number)=>tokens[at+1]==='.'?tokens[at+2]??'':tokens[at]??'';
    const writes=tokens.flatMap((token,i)=>{
      if(token.toUpperCase()==='UPDATE')return [relation(tokens[i+1]?.toUpperCase()==='OR'?i+3:i+1)];
      if(token.toUpperCase()==='INTO'||token.toUpperCase()==='FROM'&&tokens[i-1]?.toUpperCase()==='DELETE')return [relation(i+1)];
      return [];
    }).filter(protectedTable);
    if(writes.length===0)return;
    const physical=origin?.kind==='exception'&&(origin.phase==='H'||origin.phase==='T'||origin.phase==='W'
      ||origin.phase==='P'&&origin.file==='packages/myco-server/src/core/tombstones.ts'&&/^DELETE\s+FROM\b/i.test(event.sql.trim())
      ||origin.phase==='P'&&origin.file==='packages/myco/src/server/sql-dump.ts'&&origin.owner==='runOneStatement'
        &&/^INSERT INTO "(view_(?:prompts|responses|plans)_fts)"\("\1"\) VALUES\('rebuild'\);?$/i.test(event.sql.trim()));
    if(event.operation==='view-writer-driver'||physical)return;
    violations.push(event);
    throw new Error('production_view_dml: '+writes.join(','));
  };
  return {check,violations};
}
export const productionViewDml=viewDmlBoundary();
export function withViewWriterDriver<T>(run:()=>T):T{
  return withStatementSpan('view-writer-driver','view-writer-driver',run);
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
  if ('changes' in meta && typeof meta.changes === 'number') entry.changes = meta.changes;
}

function captureObserved (sql: string, origin: PreparationOrigin | undefined): boolean {
    if (origin?.kind !== 'module' || typeof origin.capture !== 'object' || origin.capture === null) return false;
    sql=origin.replay??sql;
    const evidence = origin.capture;
    if ('mode' in evidence && evidence.mode === 'pinned-set') return 'sources' in evidence && Array.isArray(evidence.sources)
      && evidence.sources.every(source => typeof source === 'object' && source !== null && typeof source.projectId === 'string' && typeof source.sessionId === 'string' && (source.mode === 'legacy' || source.mode === 'published'));
    if ('mode' in evidence && evidence.mode === 'batch-candidate') return 'batch' in evidence && typeof evidence.batch === 'object' && evidence.batch !== null
      && 'carrierSql' in evidence.batch && typeof evidence.batch.carrierSql === 'string'
      && evidence.batch.carrierSql.includes('FROM session_views sv') && evidence.batch.carrierSql.includes('__myco_capture')
      && /^\/\*vs:M(?:15:sessions_countStatements|16:sessions_instantStatements):0\*\//.test(sql);
    if ('mode' in evidence && evidence.mode === 'fact-write') return 'projectId' in evidence && typeof evidence.projectId === 'string'
      && 'recordId' in evidence && typeof evidence.recordId === 'string'
      && /^\/\*vs:M10:plans_planInSession:0\*\/UPDATE plans\b/.test(sql) && sql.includes('FROM session_views sv') && sql.includes('FROM fact_classes fc');
    if ('mode' in evidence && evidence.mode === 'fact') return 'table' in evidence && evidence.table === 'attachments'
      && 'projectId' in evidence && typeof evidence.projectId === 'string' && 'recordId' in evidence && typeof evidence.recordId === 'string'
      && /\bFROM attachments d\b/.test(sql) && protectedRelations(sql).every(name => name === 'processed_resources');
    if ('mode' in evidence && evidence.mode === 'capture') return 'projectId' in evidence && typeof evidence.projectId === 'string'
      && (!protectedSql(sql) || /\b(?:FROM|JOIN) session_views sv\b/.test(sql) && sql.includes('__myco_capture'));
    if (!('mode' in evidence) || evidence.mode !== 'pinned' || !('sources' in evidence)
      || typeof evidence.sources !== 'object' || evidence.sources === null) return false;
    const sources = evidence.sources;
    return 'mode' in sources && (sources.mode === 'legacy' || sources.mode === 'published')
      && 'projectId' in sources && typeof sources.projectId === 'string' && 'sessionId' in sources && typeof sources.sessionId === 'string';
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
    const origin=executionOrigin(sql)??(executions.getStore()===undefined?preparations.getStore():undefined);
    if (supplied) return {...supplied,...(origin?.kind==='exception'?{phase:origin.phase,exceptionId:origin.id}:{}),...(origin?{origin}:{}),captured:captureObserved(sql,origin)};
    const tag = /^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(sql);
    return {operation:tag?.[1] ?? (origin?.kind==='exception'?origin.file+'#'+origin.owner:'unclassified'),phase:tag?'logical':origin?.kind==='exception'?origin.phase:'unclassified',...(origin?.kind==='exception'?{exceptionId:origin.id}:{}),...(origin?{origin}:{}),captured:captureObserved(sql,origin)};
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
      const result = await (entry.origin?executions.run([{origin:entry.origin,sql:entry.sql}],run):run());
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
        productionViewDml.check(event);
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
          const results = await executions.run(entries.flatMap(entry=>entry.origin?[{origin:entry.origin,sql:entry.sql}]:[]),()=>db.batch(held.map(value => value.statement)));
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
    db: inheritStoreContext(db, recorded), statements, events,
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

export function sqlTokens(sql:string):string[] {
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
 const nameAt=(start:number):string|undefined=>{
  let at=start;while(/^(?:IF|NOT|EXISTS)$/i.test(tokens[at]??''))at++;
  if(!/^(?:quoted:|[A-Za-z_])/.test(tokens[at]??''))return;
  let name=tokens[at]!.replace(/^quoted:/,'');
  while(tokens[at+1]==='.'&&tokens[at+2]!==undefined){name=tokens[at+2]!.replace(/^quoted:/,'');at+=2;}
  return name.toLowerCase();
 };
 for(let i=0;i<tokens.length;i++)if(/^(?:CREATE|ALTER|DROP)$/i.test(tokens[i]!)){
  let kind=i+1;while(/^(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL)$/i.test(tokens[kind]??''))kind++;
  if(/^(?:TABLE|VIEW)$/i.test(tokens[kind]??'')){const name=nameAt(kind+1);if(name)relations.push(name);}
  else if(/^CREATE$/i.test(tokens[i]!)&&/^(?:INDEX|TRIGGER)$/i.test(tokens[kind]??'')){
   for(let at=kind+1;at<tokens.length&&tokens[at]!==';';at++)if(/^ON$/i.test(tokens[at]!)){const name=nameAt(at+1);if(name)relations.push(name);break;}
  }
 }
 const frames=[{from:false,relation:false}];
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i]!,frame=frames.at(-1)!;
  if(token==='('){
   const grouped=frame.relation;frame.relation=false;
   frames.push({from:grouped,relation:grouped});continue;
  }
  if(token===')'){if(frames.length>1)frames.pop();continue;}
  if(/^(?:FROM|JOIN)$/i.test(token)){frame.from=true;frame.relation=true;continue;}
  if(/^(?:UPDATE|INTO|REFERENCES)$/i.test(token)){frame.from=false;frame.relation=true;continue;}
  if(/^(?:SELECT|WHERE|GROUP|ORDER|LIMIT|OFFSET|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|SET|VALUES|RETURNING)$/i.test(token)||token===';'){
   frame.from=false;frame.relation=false;continue;
  }
  if(token===','&&frame.from){frame.relation=true;continue;}
  if(!frame.relation||/^(?:OR|ABORT|FAIL|IGNORE|REPLACE|ROLLBACK|LATERAL|ONLY)$/i.test(token))continue;
  if(!/^(?:quoted:|[A-Za-z_])/.test(token))continue;
  let name=token.replace(/^quoted:/,'');
  while(tokens[i+1]==='.'&&tokens[i+2]!==undefined){name=tokens[i+2]!.replace(/^quoted:/,'');i+=2;}
  relations.push(name.toLowerCase());frame.relation=false;
 }
 if(relationCache.size>=SQL_RELATION_CACHE_LIMIT)relationCache.delete(relationCache.keys().next().value!);
 relationCache.set(sql,relations);
 return relations;
}
const protectedRelation=(name:string):boolean=>materialRelations.has(name)||/^(?:session_views|learning_sessions|material_versions|view_\w+)$/.test(name);
export function protectedRelations(sql:string):readonly string[]{return [...new Set(sqlRelations(sql).filter(protectedRelation))].sort();}
export function protectedSql(sql: string): boolean {
 return sqlRelations(sql).some(protectedRelation);
}


export interface BoundaryStatement {
 sql:string;operation:string;phase:string;statementId:string;exceptionId?:string;origin?:PreparationOrigin;captured?:boolean;
}
export interface RuntimeException {id:string;operation:string;phase:string;statementId:string;sql:string}
type PhysicalOrigin=Extract<PreparationOrigin,{kind:'exception'}>;
const originIndexes=new WeakMap<readonly PhysicalOrigin[],ReadonlyMap<string,readonly PhysicalOrigin[]>>();
async function checkedFrozenReadManifest(value:{encoding:string;sha256:string;data:string}):Promise<unknown>{
 if(value.encoding!=='gzip-base64-json')throw new Error('Unknown read manifest encoding');
 const compressed=Uint8Array.from(atob(value.data),letter=>letter.charCodeAt(0));
 const bytes=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 if(digest!==value.sha256)throw new Error('Frozen read manifest differs');
 return JSON.parse(new TextDecoder().decode(bytes));
}
export async function checkedPreparationSource(value:{encoding:string;sha256:string;data:string}):Promise<{closures:SqlExceptionClosure[];callers:SqlParameterCaller[]}>{
 const data=await checkedFrozenReadManifest(value);
 const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
 const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
 const parameter=(value:unknown):value is SqlSinkParameter=>record(value)&&typeof value.file==='string'&&typeof value.owner==='string'&&typeof value.index==='number'&&Number.isSafeInteger(value.index)&&value.index>=0&&strings(value.path);
 const dependencies=(value:unknown):value is SqlDeclarationPin[]=>Array.isArray(value)&&value.every(item=>record(item)&&typeof item.file==='string'&&typeof item.name==='string'&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256));
 const active=(value:Record<string,unknown>)=>value.activeParameters===undefined||Array.isArray(value.activeParameters)&&value.activeParameters.every(parameter);
 const closure=(value:unknown):value is SqlExceptionClosure=>record(value)&&typeof value.file==='string'&&typeof value.owner==='string'&&typeof value.expression==='string'&&dependencies(value.dependencies)&&Array.isArray(value.parameters)&&value.parameters.every(parameter)&&active(value)&&strings(value.unresolved);
 const caller=(value:unknown):value is SqlParameterCaller=>record(value)&&typeof value.key==='string'&&typeof value.file==='string'&&typeof value.owner==='string'&&typeof value.callee==='string'&&typeof value.argument==='string'&&typeof value.index==='number'&&Number.isSafeInteger(value.index)&&value.index>=0&&parameter(value.sink)&&dependencies(value.dependencies)&&Array.isArray(value.parameters)&&value.parameters.every(parameter)&&active(value);
 if(!record(data)||!dependencies(data.dependencies)||!Array.isArray(data.closures)||!Array.isArray(data.callers))throw new Error('Invalid frozen SQL source closure');
 const pool=data.dependencies;
 const expand=(value:unknown):unknown=>{
  if(!record(value)||!Array.isArray(value.dependencies))throw new Error('Invalid frozen SQL source dependency');
  return {...value,dependencies:value.dependencies.map(index=>{if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>=pool.length)throw new Error('Invalid frozen SQL source dependency index');return pool[index]!;})};
 };
 const closures=data.closures.map(expand),callers=data.callers.map(expand);
 if(!closures.every(closure)||!callers.every(caller))throw new Error('Invalid frozen SQL source closure');
 return {closures,callers};
}
export async function checkedPreparationOrigins(value:{encoding:string;sha256:string;data:string}):Promise<Extract<PreparationOrigin,{kind:'exception'}>[]>{
 const rows=await checkedFrozenReadManifest(value);if(!Array.isArray(rows))throw new Error('Preparation origins must be an array');
 return rows.map(checkedPreparationOrigin);
}
export function checkedPreparationOrigin(value:unknown):Extract<PreparationOrigin,{kind:'exception'}>{
 if(Array.isArray(value)&&(value.length===5||value.length===6||value.length===7)){const [id,file,owner,expression,phase,relations,metadata]=value;if(metadata!==undefined&&(typeof metadata!=='object'||metadata===null||Array.isArray(metadata)||Object.keys(metadata).some(key=>!['callerKeys','callerRelations','nonSql'].includes(key))))throw new Error('Invalid frozen preparation metadata');return checkedPreparationOrigin({id,file,owner,expression,phase,relations,...metadata});}
 if(typeof value!=='object'||value===null||!('id'in value)||typeof value.id!=='string'||!('file'in value)||typeof value.file!=='string'||!('owner'in value)||typeof value.owner!=='string'||!('expression'in value)||typeof value.expression!=='string'||!('phase'in value)||!['W','P','H','T'].some(phase=>phase===value.phase))throw new Error('Invalid frozen preparation origin');
 const phase=value.phase;if(phase!=='W'&&phase!=='P'&&phase!=='H'&&phase!=='T')throw new Error('Unknown preparation phase');
 const relations='relations'in value?value.relations:undefined;
 if(relations!==undefined&&(!Array.isArray(relations)||!relations.every(name=>typeof name==='string')))throw new Error('Invalid frozen preparation relations');
 const callerKeys='callerKeys'in value?value.callerKeys:undefined,callerRelations='callerRelations'in value?value.callerRelations:undefined;
 const nonSql='nonSql'in value?value.nonSql:undefined;if(nonSql!==undefined&&typeof nonSql!=='boolean')throw new Error('Invalid non-SQL preparation classification');
 if(callerKeys!==undefined&&(!Array.isArray(callerKeys)||!callerKeys.every(key=>typeof key==='string')))throw new Error('Invalid frozen SQL caller keys');
 if(callerRelations!==undefined&&(!Array.isArray(callerRelations)||!callerRelations.every(row=>typeof row==='object'&&row!==null&&Array.isArray(row.callers)&&row.callers.every((key:unknown)=>typeof key==='string')&&Array.isArray(row.relations)&&row.relations.every((name:unknown)=>typeof name==='string'))))throw new Error('Invalid frozen SQL caller relations');
 return {kind:'exception',id:value.id,file:value.file,owner:value.owner,expression:value.expression,phase,...(relations===undefined?{}:{relations}),...(callerKeys===undefined?{}:{callerKeys}),...(callerRelations===undefined?{}:{callerRelations}),...(nonSql===undefined?{}:{nonSql})};
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
  const sql=statement.origin?.kind==='module'&&statement.origin.replay!==undefined&&statement.sql===EXPLAIN_REPLAY_PREFIX+statement.origin.replay?statement.origin.replay:statement.sql;
  const match=/^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(sql),tag=match?.[1];
  if(tag!==undefined){
   if(!options.known.has(tag)){errors.push('unknown operation '+tag);continue;}
   if(statement.origin?.kind!=='module'){errors.push('forged module operation '+tag);continue;}
   const text=sql.slice(match![0].length);
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
  if(origin?.kind==='exception'&&statement.phase===origin.phase&&statement.exceptionId===origin.id){
   const expected=indexed.get(origin.id)?.find(expected=>expected.file===origin.file&&expected.owner===origin.owner&&expected.expression===origin.expression&&expected.phase===origin.phase);
   if(expected){
    if(expected.nonSql){errors.push('non-SQL origin used for SQL: '+origin.id);continue;}
    const context=(origin.callers??[]).filter(key=>expected.callerKeys?.includes(key)).sort();
    const scoped=expected.callerKeys?.length?expected.callerRelations?.find(row=>JSON.stringify(row.callers)===JSON.stringify(context)):undefined;
    if(expected.callerKeys?.length&&(!context.length||!scoped)){errors.push('exception lacks pinned caller: '+origin.id);continue;}
    if(OPEN_RELATION_PREPARATIONS.some(row=>row.file===expected.file&&row.owner===expected.owner&&row.expression===expected.expression))continue;
    const added=protectedRelations(statement.sql).filter(name=>!(scoped?.relations??expected.relations)?.includes(name));
    if(added.length)errors.push('exception adds protected relations: '+origin.id+': '+added.join(', '));
    continue;
   }
  }
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
 origin=executionOrigin(sql)??origin;
 if(origin.kind==='exception')origin={...origin,callers:origin.callers??callers.getStore()??[]};
 const supplied=nativeSpans.getStore(),frame:StatementFrame={operation:supplied?.operation??(origin.kind==='exception'?origin.file+'#'+origin.owner:'physical'),phase:origin.kind==='exception'?origin.phase:supplied?.phase??'physical',...(supplied?.spanId?{spanId:supplied.spanId}:{}),...(supplied?.parentSpanId?{parentSpanId:supplied.parentSpanId}:{}),origin,captured:captureObserved(sql,origin),...(origin.kind==='exception'?{exceptionId:origin.id}:{})};
 const statementId='physical-'+String(++physicalSequence);
 const emit=(event:StatementEvent)=>{for(const observe of physicalObservers)observe({kind:'event',value:event});};
 const prepared:StatementEvent={...frame,kind:'prepare',statementId,sql,binds:[]};
 productionViewDml.check(prepared);
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
  if(method==='exec')return execute('run',[],()=>executions.run([{origin,sql}],()=>withReadPreparation(origin,make)));
  const value=executions.run([{origin,sql}],()=>withReadPreparation(origin,make));
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
