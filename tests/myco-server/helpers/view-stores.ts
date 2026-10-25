import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope, uuid } from './fixtures.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProject} from '@myco-server-worker/read/sessions.js';

export async function withViewStores(run: (db: RelationalStore, target: string) => Promise<void>, through = Infinity): Promise<void> {
  const native = new Database(':memory:');
  native.exec('PRAGMA foreign_keys=ON');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const stores = [sqliteRelationalStore(native), await mf.getD1Database('DB')];
    for (const [index, db] of stores.entries()) {
      for (const step of SCHEMA_STEPS.filter(step => step.version <= through)) await db.batch(step.statements.map(sql => db.prepare(sql)));
      for(const project of ['project','other'])await createProject(db,project,project,1);
      await run(db, index === 0 ? 'native' : 'D1');
    }
  } finally { native.close(); await mf.dispose(); }
}

/** Captured facts use the admitted ingest writer on either relational adapter. */
export async function captureViewSession(db: RelationalStore, projectId = 'project', sessionId = 'session', options: { toolInput?: { path: string }; blobs?: BlobStore } = {}): Promise<void> {
  const now = options.blobs === undefined ? 1 : Date.now();
  await ensureMember(db, 'member', now, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now };
  for (const event of [
    envelope({ eventId: uuid(1), sessionId, kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1 } }),
    envelope({ eventId: uuid(2), sessionId, kind: 'prompt', payload: { promptId: uuid(20), text: 'factcanary', origin: 'user' } }),
    envelope({ eventId: uuid(3), sessionId, kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'factcanary' } }),
    envelope({ eventId: uuid(4), sessionId, kind: 'tool.use', payload: { toolCallId: uuid(40), toolName: 'Read', input: options.toolInput ?? { path: 'test' }, success: true } }),
    envelope({ eventId: uuid(5), sessionId, kind: 'plan', payload: { planKey: uuid(50), content: 'factcanary', status: 'active' } }),
  ]) {
    const result = await ingestEvent(db, ctx, event, options.blobs === undefined ? undefined : { db, blobs: options.blobs });
    if (!result.persisted) throw new Error(`fixture capture refused: ${JSON.stringify(result)}`);
  }
}

/** Independent copies retain the canonical ids and revisions minted by the fixture's writers. */
export async function withViewStorePair(target:'native'|'D1',seed:(db:RelationalStore)=>Promise<unknown>,run:(baseline:RelationalStore,candidate:RelationalStore)=>Promise<void>):Promise<void>{
 const initialize=async(db:RelationalStore)=>{
  for(const step of SCHEMA_STEPS)await db.batch(step.statements.map(sql=>db.prepare(sql)));
  await createProject(db,'project','project',1);await createProject(db,'other','other',1);
  await seed(db);
 };
 if(target==='native'){
  const source=new Database(':memory:');let candidate:Database|undefined;
  try{
   source.exec('PRAGMA foreign_keys=ON');
   const baseline=sqliteRelationalStore(source);await initialize(baseline);
   candidate=Database.deserialize(source.serialize());
   candidate.exec('PRAGMA foreign_keys=ON');
   await run(baseline,sqliteRelationalStore(candidate));
  }finally{source.close();candidate?.close();}
  return;
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myco-view-pair-'));
 const boot=(persist:string)=>new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-01',d1Databases:{DB:'00000000-0000-4000-8000-000000000001'},resourcePersistencePath:persist}));
 let source:InstanceType<typeof Miniflare>|undefined,baseline:InstanceType<typeof Miniflare>|undefined,candidate:InstanceType<typeof Miniflare>|undefined;
 try{
  const original=path.join(root,'source');source=boot(original);
  await initialize(await source.getD1Database('DB'));await source.dispose();source=undefined;
  const first=path.join(root,'baseline'),second=path.join(root,'candidate');
  fs.cpSync(original,first,{recursive:true});fs.cpSync(original,second,{recursive:true});
  baseline=boot(first);candidate=boot(second);
  await run(await baseline.getD1Database('DB'),await candidate.getD1Database('DB'));
 }finally{
  try{await Promise.all([source?.dispose(),baseline?.dispose(),candidate?.dispose()]);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
}
