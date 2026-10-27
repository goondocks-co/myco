import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import legacy from '../tests/myco-server/fixtures/view-read-legacy.json';
import {sourceBoundary,sourceSealChanges,type ExceptionClosure,type ParameterCaller,type StatementException} from '../tests/helpers/view-read-contract.js';
import {checkedPreparationSource} from '../tests/helpers/statement-recorder.js';
import {preparationSourceInventory} from '../tests/helpers/view-read-policy.js';

const file='tests/myco-server/fixtures/view-read-preparations.json';
const policy=JSON.parse(readFileSync(file,'utf8'));
const sources=new Map(preparationSourceInventory(process.cwd()).map(file=>[file,readFileSync(file,'utf8')]));
const closures:ExceptionClosure[]=[],callers:ParameterCaller[]=[],dependencyDiffs:string[]=[];
const exceptions=legacy.sourceExceptions.map(row=>({...row,phase:row.phase as StatementException['phase']}));
sourceBoundary(sources,exceptions,legacy.foundationImports,{
 closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),
 captureDependencies:(exception,dependencies)=>{if(JSON.stringify(exception.dependencies??[])!==JSON.stringify(dependencies))dependencyDiffs.push(exception.id)},
});
if(dependencyDiffs.length)throw new Error('Source exception dependencies changed: '+dependencyDiffs.join(', '));
const errors=sourceBoundary(new Map([...sources].filter(([file])=>file.startsWith('packages/'))),exceptions,legacy.foundationImports,{closures,callers});
if(errors.length)throw new Error(errors.join('\n'));
const historical=await checkedPreparationSource(legacy.sourceClosureProgram);
const key=(row:ExceptionClosure|ParameterCaller)=>'key' in row?row.key:JSON.stringify([row.file,row.owner,row.expression]);
const previous=new Map<string,string>(policy.sourceClosureChanges.map((row:{tupleId:string;reason:string})=>[row.tupleId,row.reason]));
const classes=sourceSealChanges(historical,{closures,callers}).map(change=>{
 const before=historical[change.kind as 'closures'|'callers'],after=change.kind==='closures'?closures:callers;
 const changed=after.find(row=>{
  const left=before.find(old=>key(old)===key(row));
  return createHash('sha256').update(JSON.stringify([change.kind,change.change,left??null,row])).digest('hex')===change.tupleId;
 })??before.find(row=>createHash('sha256').update(JSON.stringify([change.kind,change.change,row,null])).digest('hex')===change.tupleId);
 if(!changed)throw new Error('Unresolved tuple '+change.tupleId);
 const f=changed.file,o=changed.owner,deps=changed.dependencies;
 const reason=previous.get(change.tupleId)??(
  f.endsWith('/read/plans.ts')&&o==='setPlanStatus'?'moved plan-status SQL':
  f.endsWith('/core/injection.ts')?'renamed injection composition':
  f.endsWith('/core/write-guard-store.ts')?'opaque-context decorator':
  f.endsWith('/core/attention-state.ts')||f.endsWith('/read/meta.ts')?'bounded refusal/status metadata':
  f.endsWith('/server/sql-dump.ts')?'SQL identifier dependency fingerprint':
  f.endsWith('/thin-learning-admission.test.ts')||deps.some(p=>/\/(?:db\/thin-learning-admission|db\/schema-v104)\.ts$/.test(p.file))?'schema 104 admission projection':
  f.startsWith('tests/')&&(f.includes('view-')||f.endsWith('/statement-recorder.ts'))?'focused view fixtures':
  f.startsWith('packages/myco-server/src/read/')||deps.some(p=>/\/(?:read\/(?:processed|prompts|search|turns|extraction-coverage|embedding|sessions|session-activity|children|kpis)|core\/(?:release-provenance|search-index))\.ts$/.test(p.file))?'module-owned read preparation':
  change.change==='added'&&f.startsWith('tests/')?'writer-shaped fixture instrumentation':
  change.change==='removed'&&!deps.length&&!changed.parameters.length&&!changed.activeParameters?.length?'closed literal sink':
  change.change==='changed'||change.change==='removed'&&deps.length?'transitive callback fingerprint':undefined);
 if(!reason)throw new Error('Classify tuple '+change.tupleId+' '+f+'#'+o);
 return {...change,reason};
});
const dependencies:ExceptionClosure['dependencies'][number][]=[],indices=new Map<string,number>();
const compact=(row:ExceptionClosure|ParameterCaller)=>({...row,dependencies:row.dependencies.map(dep=>{
 const key=JSON.stringify(dep),held=indices.get(key);if(held!==undefined)return held;
 const index=dependencies.length;dependencies.push(dep);indices.set(key,index);return index;
})});
const compactClosures=closures.map(compact),compactCallers=callers.map(compact);
const raw=Buffer.from(JSON.stringify({codec:1,dependencies,closures:compactClosures,callers:compactCallers}));
policy.sourceClosureProgram={encoding:'gzip-base64-json',sha256:createHash('sha256').update(raw).digest('hex'),data:gzipSync(raw).toString('base64')};
policy.fixtureReconciliation.sourceGraphSha256=policy.sourceClosureProgram.sha256;
const marker='__SOURCE_CLOSURE_CLASSES__';
policy.sourceClosureChanges=marker;
writeFileSync(file,JSON.stringify(policy,null,2).replace(JSON.stringify(marker),'[\n'+classes.map(row=>'    '+JSON.stringify(row)).join(',\n')+'\n  ]')+'\n');
console.log(JSON.stringify({closures:closures.length,callers:callers.length,classes:classes.length,sha256:policy.sourceClosureProgram.sha256}));
