import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import legacy from '../tests/myco-server/fixtures/view-read-legacy.json';
import {sourceBoundary,sourceSealChanges,type ExceptionClosure,type ParameterCaller,type StatementException} from '../tests/helpers/view-read-contract.js';
import {checkedPreparationSource} from '../tests/helpers/statement-recorder.js';
import {preparationSourceInventory,preparationSourceExceptions,preparationFoundationImports} from '../tests/helpers/view-read-policy.js';

const file='tests/myco-server/fixtures/view-read-preparations.json';
const namedTupleClasses=new Map<string,string>([
 ["d497a0f33d33410d048f75460442a1cc8687b4e133cd5858688e753e1c717adf","backup and restore SQL"],
 ["7be887ac862eae1e25cf58711d1080726bd613d9d55e3f54759b068275b7c5ea","backup and restore SQL"],
 ["1a1dd20ce699b8151f6f4f0d9abd678de5c31c2e878b78c871c10c2dc632b95f","embedding view schema SQL"],
 ["9ffd3c65104cc37d912cb9c9d42a7aa03518ff22a160b87060dfca4440ae0a55","embedding view schema SQL"],
 ["c2c19be56959c18e9c4fa15421de7731db26ca8fd62912bbcfff8c37a397db5b","capture delivery and replay proof SQL"],
 ["db74719fae7d0cb2b8050b1915404178ff73b4cfc15b38a5ffb6ec4768d9b1a2","embedding view schema SQL"],
 ["ccfb0bb812f59553e8519046007512a40279c9745942ee57c8d2e9156287529f","backup and restore SQL"],
 ["e794fb2d5263a67104ac24312580ef27fd413cc02f8ce73d7a55cc28daeb1346","parser presented-date finalization"],
 ["980a7ba4dd13a5b7b4447192db09e74d6348523744127d31161fa502fa4d5087","embedding view schema SQL"],
 ["6aa8082a509c9a218ab9e7f3142be093e82384fd25e2b2a4efb832e151988952","backup and restore SQL"],
 ["ddc32e69e29c92e25fc82ad1b900770c851da03ba3e5d6a623f8a2a6f38d218f","parser presented-date finalization"],
 ["41dc89ed404ef727eef92f697f736da3241f78f17eaff329160ee8cbfbdc5aa1","backup and restore SQL"],
 ["659bbdc9039b1b676c7f573b56363c69304de2d6b3b8d429a7a9865025ee8c13","backup and restore SQL"],
 ["7850160752dd47b5b1a921e9977b235bb8bf023e0534b2db0b794f64dffda551","backup and restore SQL"],
 ["8de220c560294ef25a91c5a83eadabe626523f84d6ae1198373f2d0eecaf0c1c","embedding view schema SQL"],
 ["874bbb176ed757e989128413eef41fb6db82ac335329d63c2eb726d48d66d7e4","backup and restore SQL"],
 ["b799217f8afb5fadda763ca036bbe0f3dec139c8e7cbfa6c9892b41157954e8f","capture delivery and replay proof SQL"],
 ["2bf79daf7ff1fa2ac02f7f5f0dac715fb8dba6bee0fbd97e2a7d75c17156f0f5","backup and restore SQL"],
 ["204b0390854a0cd4f3668e5a92a2d48ce9db09ce8cf5064071423900041d2861","parser presented-date finalization"],
 ["ec85364b42c4b8309946f73ead6a49d5a30bf646dd20d78baa35e2b4a2e77ea1","backup and restore SQL"],
 ["1c735d3c6c95b0a6ba2b0d71422f52d06b8908eb76417c03459257c738498a91","backup and restore SQL"],
 ["7fcc18b719dbd2b56376da820587c21dd8a77fcc5e76176803f4aee171baeac0","parser presented-date finalization"],
 ["2b2f07ba4549d9fbcfe7d5cd2ff1321995301a132de6782c5d3e29fe0bb941fb","backup and restore SQL"],
]);
export function classifySourceSealChange(
 change:{tupleId:string;change:string},
 changed:ExceptionClosure|ParameterCaller,
 exceptions:readonly StatementException[],
 previous?:string,
):string{
 const f=changed.file,o=changed.owner,deps=changed.dependencies;
 const named=namedTupleClasses.get(change.tupleId);
 const retained=previous&&![...namedTupleClasses.values()].includes(previous)?previous:undefined;
 const reason=named??retained??(
  exceptions.some(row=>row.id.startsWith('pr5-')&&row.file===f&&row.owner===o)||f.endsWith('/core/recall.ts')||f.endsWith('/ingest/projections.ts')||f.endsWith('/ingest/parser-checkpoint.ts')?'writer material and lifecycle':
  /\/(?:core\/(?:context-writes|plan-status|prompt-answer-retention|material-[^/]+)|ingest\/view-[^/]+|db\/schema-v105)\.ts$/.test(f)?'writer material and lifecycle':
  f.startsWith('packages/myco/src/server/')?'durable material recovery':
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
  change.change==='changed'||change.change==='removed'&&deps.length?'transitive callback fingerprint':
  undefined);
 if(!reason)throw new Error('Classify tuple '+change.tupleId+' '+f+'#'+o);
 return reason;
}


export async function sealViewReadSource(derived?:{sources:Map<string,string>;exceptions:StatementException[];closures:ExceptionClosure[];callers:ParameterCaller[]},writer=false,check=false){
const policy=JSON.parse(readFileSync(file,'utf8'));
const sources=derived?.sources??new Map(preparationSourceInventory(process.cwd()).map(file=>[file,readFileSync(file,'utf8')]));
const closures:ExceptionClosure[]=derived?.closures??[],callers:ParameterCaller[]=derived?.callers??[],dependencyDiffs:string[]=[];
const exceptions=derived?.exceptions??preparationSourceExceptions.map(row=>({...row,phase:row.phase as StatementException['phase']}));
if(!derived)sourceBoundary(sources,exceptions,preparationFoundationImports,{
 validateBoundaries:false,closures:[],callers:[],captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),
 captureDependencies:(exception,dependencies)=>{if(JSON.stringify(exception.dependencies??[])!==JSON.stringify(dependencies))dependencyDiffs.push(exception.id);if(writer)exception.dependencies=dependencies},
});
if(dependencyDiffs.length&&!writer)throw new Error('Source exception dependencies changed: '+dependencyDiffs.join(', '));
const errors=sourceBoundary(new Map([...sources].filter(([file])=>file.startsWith('packages/'))),exceptions,preparationFoundationImports,{closures,callers});
if(errors.length)throw new Error(errors.join('\n'));
const historical=await checkedPreparationSource(legacy.sourceClosureProgram);
const key=(row:ExceptionClosure|ParameterCaller)=>'key' in row?row.key:JSON.stringify([row.file,row.owner,row.expression]);
const previous=new Map<string,string>(policy.sourceClosureChanges.map((row:{tupleId:string;reason:string})=>[row.tupleId,row.reason]));
const changedRows=new Map<string,ExceptionClosure|ParameterCaller>();
const one=(row:ExceptionClosure|ParameterCaller|undefined)=>({closures:row&&!('key' in row)?[row]:[],callers:row&&'key' in row?[row]:[]});
for(const kind of ['closures','callers'] as const){
 const before=new Map(historical[kind].map(row=>[key(row),row]));
 const after=new Map((kind==='closures'?closures:callers).map(row=>[key(row),row]));
 for(const identity of new Set([...before.keys(),...after.keys()])){
  const left=before.get(identity),right=after.get(identity);
  for(const change of sourceSealChanges(one(left),one(right)))changedRows.set(change.tupleId,(right??left)!);
 }
}
const classes=sourceSealChanges(historical,{closures,callers}).map(change=>{
 const changed=changedRows.get(change.tupleId);
 if(!changed)throw new Error('Unresolved tuple '+change.tupleId);
 const reason=classifySourceSealChange(change,changed,exceptions,previous.get(change.tupleId));
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
if(writer)policy.writer.sourceExceptions=exceptions.filter(row=>JSON.stringify(row)!==JSON.stringify(legacy.sourceExceptions.find(held=>held.id===row.id)));
const marker='__SOURCE_CLOSURE_CLASSES__';
policy.sourceClosureChanges=marker;
const output=JSON.stringify(policy,null,2).replace(JSON.stringify(marker),'[\n'+classes.map(row=>'    '+JSON.stringify(row)).join(',\n')+'\n  ]')+'\n';
if(check){if(readFileSync(file,'utf8')!==output)throw new Error('Stale live source seal: '+file)}else writeFileSync(file,output);
console.log(JSON.stringify({closures:closures.length,callers:callers.length,classes:classes.length,sha256:policy.sourceClosureProgram.sha256}));

}
