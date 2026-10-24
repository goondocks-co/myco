import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {localUnplacedContextRecords,cloudflareUnplacedContextRecords} from '@myco/server/hook-placement-status.js';
import {resolveLocalPaths} from '@myco/server/local.js';
import {LocalVolume} from '@myco/server/local-volume.js';
import {writeDeploymentRecord,type CloudflareFetch} from '@myco/server/cloudflare.js';
import {migrateOnly} from '@myco-server-worker/platform/bun/server-main.js';
import {sqliteRelationalStore} from '@myco-server-worker/platform/bun/sqlite.js';
import {createProject} from '@myco-server-worker/read/sessions.js';
import {composePromptContext,recallLeaves,answerDeliveredStatement} from '@myco-server-worker/core/recall.js';
import {sessionWriteAdmission} from '@myco-server-worker/ingest/projections.js';
import {seedLegacyFixture} from '../helpers/view-read-legacy-fixtures.js';
import {factoryReadTrace,checkpointReadObservations} from '../setup/view-read-preload.js';
import {readTag,runtimeBoundary} from '../helpers/view-read-contract.js';
import {withStatementSpan} from '../helpers/statement-recorder.js';

async function writerSource(run:(source:{root:string;paths:ReturnType<typeof resolveLocalPaths>;sqlite:Database})=>Promise<void>){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myco-read-operators-')),paths=resolveLocalPaths(path.join(root,'source'));
 let sqlite:Database|undefined;
 try{
 await new LocalVolume(paths).exclusive(async()=>{
  fs.mkdirSync(path.dirname(paths.databasePath),{recursive:true});migrateOnly(paths.databasePath);
  sqlite=new Database(paths.databasePath);
  const db=sqliteRelationalStore(sqlite);await createProject(db,'project','project',1);await seedLegacyFixture(db);
  const admission=sessionWriteAdmission({projectId:'project',machineId:'machine'},'session'),now=Date.now();
  const answer=await composePromptContext(db,{projectId:'project'},recallLeaves({'cortex.spores.inject_on_prompt_submit':false}),true,{sessionId:'session',text:'let us write the implementation plan',now,admission,promptId:null,scopeReason:'absent_key'});
  if(!answer.answerId)throw new Error('Fixture context answer missing');
  await answerDeliveredStatement(db,{projectId:'project',sessionId:'session',id:answer.answerId,at:now,promptId:null,scopeReason:'absent_key'},admission.admission).run();
 });
 if(!sqlite)throw new Error('Fixture source missing');
 await checkpointReadObservations();await run({root,paths,sqlite});
 }finally{sqlite?.close();fs.rmSync(root,{recursive:true,force:true})}
}
async function assertStatusTrace(){
 const trace=await factoryReadTrace(),reads=trace.statements.filter(row=>readTag(row.sql)?.operation.startsWith('M21:'));
 expect(reads).toHaveLength(2);expect(reads.map(row=>row.method)).toEqual(['first','first']);
 expect(new Set(reads.map(row=>row.sql)).size).toBe(2);
 expect(trace.events.filter(row=>readTag(row.sql)?.operation.startsWith('M21:')).map(row=>row.kind).sort()).toEqual(['bind','bind','execute','execute','prepare','prepare']);
 expect(runtimeBoundary(reads)).toEqual([]);
}
test('native hook status uses the recorded M21 operation under volume ownership',()=>writerSource(async({paths})=>{
 expect(await withStatementSpan('operator.native-hook-status','operator',()=>localUnplacedContextRecords(paths))).toBe(1);
 await assertStatusTrace();
}),30000);
test('D1 hook status uses the actual operator adapter and recorded M21 operation',()=>writerSource(async({root,sqlite})=>{
 const mycoHome=path.join(root,'hosted');
 writeDeploymentRecord({accountId:'fixture-account',databaseId:'fixture-db',workerName:'fixture',databaseName:'fixture',bucketName:'fixture',versionId:null,deployedAt:new Date(0).toISOString()},mycoHome);
 let queries=0;
 const fetch:CloudflareFetch=async(_url,init)=>{
  const body=JSON.parse(String(init.body)) as {sql:string;params:unknown[]};queries++;
  const results=sqlite.query(body.sql).all(...body.params as (string|number|null)[]);
  return Response.json({success:true,result:[{success:true,results,meta:{changes:0,rows_read:1,rows_written:0}}]});
 };
 const runner={async run(_command:string,args:readonly string[]){if(!args.includes('token'))throw new Error('Unexpected operator command');return {code:0,stdout:JSON.stringify({type:'oauth',token:'fixture-operator-token'}),stderr:''}}};
 expect(await withStatementSpan('operator.d1-hook-status','operator',()=>cloudflareUnplacedContextRecords({mycoHome,accountId:'fixture-account',runner,fetch}))).toBe(1);
 expect(queries).toBe(2);await assertStatusTrace();
}),30000);

import {createHash} from 'node:crypto';
import {captureSchema,exportedTables} from '@myco-server-worker/core/recovery-schema.js';
import {completeStagingManifest} from '@myco-server-worker/core/recovery-producer.js';
import {newStatementScan,feedStatements,endStatements,significantStatement,identifierAt} from '@myco-server-worker/core/sql-statements.js';
import {writeRecoverySql} from '@myco/server/recovery-sql.js';
import {materializeRecoveryStaging} from '@myco/server/recovery-materialize.js';
import {restoreLocalDeployment} from '@myco/server/local-recovery.js';
import {STAGING_MANIFEST_FILE,STAGING_SCHEMA_FILE,STAGING_SQL_FILE} from '@myco/server/recovery-contract.js';
import {observePhysicalStatements,type RecordedStatement} from '../helpers/statement-recorder.js';
import {protectedSql} from '../helpers/view-read-contract.js';

const fingerprint=(bytes:string)=>({bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')});
async function stagedArtifact(source:{root:string;paths:ReturnType<typeof resolveLocalPaths>;sqlite:Database}){
 const staging=path.join(source.root,'staging'),artifact=path.join(source.root,'artifact');
 fs.mkdirSync(staging);const schema=await captureSchema(sqliteRelationalStore(source.sqlite));
 const allowed=new Set(exportedTables(schema)),snapshot=path.join(source.root,'writer.sqlite'),dump=path.join(source.root,'provider.sql');
 source.sqlite.query('VACUUM INTO ?').run(snapshot);
 writeRecoverySql(snapshot,dump);
 const scan=newStatementScan(),tables:string[]=[];
 let rowsComplete=false;
 const consume=(statement:string)=>{
  const sql=significantStatement(statement),form=/^(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+INTO\s+)/i.exec(sql);
  if(/^DROP\s+TABLE\s+__myco_recovery_value\s*;/i.test(sql)){rowsComplete=true;return;}
  if(rowsComplete)return;
  if(form){const named=identifierAt(sql,form[0].length);if(named&&!named.qualified&&allowed.has(named.name))tables.push(statement);}
  else if(/^PRAGMA\s+defer_foreign_keys\s*=/i.test(sql)||/^DELETE\s+FROM\s+sqlite_sequence/i.test(sql))tables.push(statement);
 };
 feedStatements(scan,fs.readFileSync(dump,'utf8'),'all',consume);endStatements(scan,'all',consume);
 expect(rowsComplete).toBe(true);
 const exported=tables.join('\n'),captured=JSON.stringify(schema),now=Date.now();
 fs.writeFileSync(path.join(staging,STAGING_SCHEMA_FILE),captured);fs.writeFileSync(path.join(staging,STAGING_SQL_FILE),exported);
 const manifest=completeStagingManifest({admitted:{source:{target:'cloudflare',locator:'writer-shaped-local-staging'},startedAt:new Date(now).toISOString(),schema:fingerprint(captured),configuration:{},credentialsRequired:[]},completedAt:now+1,database:fingerprint(exported),bookmark:null,objects:[]});
 fs.writeFileSync(path.join(staging,STAGING_MANIFEST_FILE),JSON.stringify(manifest));
 const result=await materializeRecoveryStaging({staging,destination:artifact});
 expect(result.source.receipt).toMatch(/^[a-f0-9]{64}$/);
 const secretsFile=path.join(source.root,'independent.env');
 fs.writeFileSync(secretsFile,'SECRET_WRAP_KEY='+Buffer.alloc(32,7).toString('base64')+'\nSESSION_SECRET=fixture-session-secret-with-thirty-two-bytes\nGITHUB_CLIENT_ID=fixture-client\nGITHUB_CLIENT_SECRET=fixture-client-secret\n',{mode:0o600});
 return {artifact,secretsFile};
}
function physicalCapture(){
 const statements:RecordedStatement[]=[];
 const stop=observePhysicalStatements(row=>{if(row.kind==='statement')statements.push(row.value)});
 return {statements,stop};
}
function assertRecoveryTrace(statements:RecordedStatement[],expected:string){
 const reads=statements.filter(row=>protectedSql(row.sql));
 expect(reads.length).toBeGreaterThan(0);
 expect(reads.some(row=>row.origin?.kind==='exception'&&row.origin.file===expected&&row.phase==='P')).toBe(true);
 expect(reads.every(row=>row.origin?.kind==='exception'&&['P','H'].includes(row.phase))).toBe(true);
 expect(runtimeBoundary(reads)).toEqual([]);
 expect(reads.some(row=>row.sql.includes('plans'))).toBe(true);
}
test('local recovery materializes real staging and records the actual maintenance reads',()=>writerSource(async source=>{
 const observed=physicalCapture();
 try{
  const staged=await withStatementSpan('operator.local-materialize','P',()=>stagedArtifact(source));
  const paths=resolveLocalPaths(path.join(source.root,'restored'));
  await withStatementSpan('operator.local-restore','P',()=>restoreLocalDeployment({source:staged.artifact,secretsFile:staged.secretsFile,paths,tenantMode:'replacement',sourceRetired:true}));
  expect(await localUnplacedContextRecords(paths)).toBe(1);
  assertRecoveryTrace(observed.statements,'packages/myco/src/server/recovery-bundle.ts');
  expect(observed.statements.some(row=>row.origin?.kind==='exception'&&row.origin.file==='packages/myco/src/server/local-recovery.ts')).toBe(true);
 }finally{observed.stop()}
}),60000);

import {restoreCloudflareDeployment} from '@myco/server/cloudflare-recovery.js';
import {readDeploymentRecord} from '@myco/server/cloudflare.js';
import {VECTOR_INDEX_DIMENSIONS,VECTOR_METADATA_FIELDS} from '@myco/server/vector-config.js';
import type {CommandRunner} from '@myco/server/runner.js';

test('Cloudflare recovery records source maintenance and restores through the fake provider',()=>writerSource(async source=>{
 const observed=physicalCapture(),destination=new Database(':memory:'),mycoHome=path.join(source.root,'hosted-restore');
 try{
  const staged=await stagedArtifact(source);await checkpointReadObservations();observed.statements.length=0;
  let imports=0,deploys=0;
  const answer=(stdout='',code=0)=>({code,stdout,stderr:''});
  const runner:CommandRunner={async run(_command,args){
   const flat=args.slice(2).join(' ');
   if(flat==='--version')return answer('4.126.0');
   if(flat==='whoami')return answer('fixture');
   if(flat==='d1 list --json'||flat==='vectorize list --json')return answer('[]');
   if(flat.startsWith('d1 create'))return answer('11111111-2222-4333-8444-555555555555');
   if(flat.startsWith('r2 bucket create')||flat.startsWith('vectorize create '))return answer();
   if(flat.startsWith('vectorize get '))return answer(JSON.stringify({config:{dimensions:VECTOR_INDEX_DIMENSIONS,metric:'cosine'}}));
   if(flat.startsWith('vectorize list-metadata-index '))return answer(JSON.stringify(VECTOR_METADATA_FIELDS.map(propertyName=>({propertyName,indexType:propertyName==='created_at'?'Number':'String'}))));
   if(flat.startsWith('secrets-store store list'))return answer('f'.repeat(32));
   if(flat.startsWith('secrets-store secret create')||flat.startsWith('secret '))return answer();
   if(flat.startsWith('deployments list'))return answer('Worker not found [code: 10007]',1);
   if(flat.startsWith('auth token'))return answer(JSON.stringify({type:'oauth',token:'fixture-operator-token'}));
   if(args.includes('--command'))return answer(JSON.stringify([{success:true,results:destination.query(args[args.indexOf('--command')+1]!).all()}]));
   if(args.includes('--file')){destination.transaction(()=>destination.exec(fs.readFileSync(args[args.indexOf('--file')+1]!,'utf8')))();imports++;return answer();}
   if(flat.startsWith('d1 migrations apply'))return answer();
   if(flat.startsWith('deploy ')){deploys++;return answer('Current Version ID: 11111111-2222-4333-8444-555555555555\nhttps://fixture.account.workers.dev');}
   throw new Error('Unexpected fake provider command '+flat);
  }};
  const fetch:CloudflareFetch=async()=>{throw new Error('Unexpected recovery object request')};
  const restored=await withStatementSpan('operator.cloudflare-restore','P',()=>restoreCloudflareDeployment({source:staged.artifact,secretsFile:staged.secretsFile,mycoHome,accountId:'fixture-account',sourceRetired:true,tenantMode:'replacement',runner,fetch}));
  expect(restored.record.databaseId).toBe('11111111-2222-4333-8444-555555555555');expect(imports).toBe(2);expect(deploys).toBe(2);
  expect(readDeploymentRecord(mycoHome)?.databaseId).toBe(restored.record.databaseId);
  expect(destination.query('SELECT text FROM prompt_batches WHERE prompt_id=?').get('00000000-0000-7000-8000-000000000020')).toEqual({text:'baseline prompt'});
  assertRecoveryTrace(observed.statements,'packages/myco/src/server/recovery-sql.ts');
  expect(observed.statements.some(row=>row.origin?.kind==='exception'&&row.origin.file==='packages/myco/src/server/cloudflare-recovery-database.ts')).toBe(true);
 }finally{observed.stop();destination.close()}
}),60000);
