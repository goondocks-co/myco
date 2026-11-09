import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { SERVER_PROTOCOL, TRANSCRIPT_PARSE_ADAPTER } from '@myco-server-worker/constants.js';
const TRANSCRIPT_PRODUCER = { adapter: TRANSCRIPT_PARSE_ADAPTER, version: String(SERVER_PROTOCOL) };
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './member-token.js';
import { envelope, uuid,recordingLimiter } from './fixtures.js';
import {serverEnvFromBindings} from '@myco-server-worker/platform/cloudflare/env.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storeTargets=new WeakMap<RelationalStore,'native'|'D1'>();

export async function withDocumentStores(run: (db: RelationalStore, target: 'native'|'D1', native?: Database) => Promise<void>, through = Infinity): Promise<void> {
  const native = new Database(':memory:');
  native.exec('PRAGMA foreign_keys=ON');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const stores = [sqliteRelationalStore(native), await mf.getD1Database('DB')];
    const selected=process.env.MYCO_DOCUMENT_TEST_STORE;
    if(selected!==undefined&&!['native','D1'].includes(selected))throw new Error('Unknown document test store');
    for (const [index, db] of stores.entries()) {
      if(selected!==undefined&&selected!==(index===0?'native':'D1'))continue;
      storeTargets.set(db,index===0?'native':'D1');
      for (const step of SCHEMA_STEPS.filter(step => step.version <= through)) await db.batch(step.statements.map(sql => db.prepare(sql)));
      for(const project of ['project','other'])await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project,project).run();
      await run(db, index === 0 ? 'native' : 'D1', index === 0 ? native : undefined);
    }
  } finally { native.close(); await mf.dispose(); }
}

/** Transcript fixtures use the upload and capture writers on the selected store. */
export async function captureDocumentTranscript(db:RelationalStore,blobs:BlobStore,session:string,transcript:string,text:string,now:number,baseOffset=0,agent='cursor',projectId='project'){
  await ensureMember(db,'member',now,'member');
  const issued=await issueMemberToken(db,{memberId:'member',machineId:'machine'},now);
  const configured=serverEnvFromBindings({MYCO_DB:db,BUCKET:blobs,SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()});
  const env={...configured,blobs,platform:{...configured.platform,name:storeTargets.get(db)==='native'?'bun' as const:'cloudflare' as const}};
  const key=await sha256Hex(text),bytes=new TextEncoder().encode(text);
  const response=await handleBlob(env,new Request('http://127.0.0.1/blobs/'+key,{method:'PUT',headers:{'content-type':'text/plain'},body:bytes}),
    {projectId,machineId:'machine',tokenId:issued.tokenId,now,clock:()=>now,contentLength:bytes.length,params:{key}});
  if(!(await response.json() as {stored:boolean}).stored)throw new Error('fixture transcript upload refused');
  const result=await ingestEvent(db,{projectId,machineId:'machine',tokenId:issued.tokenId,bodyBytes:bytes.length,now},
    envelope({eventId:crypto.randomUUID(),sessionId:session,kind:'transcript.segment',createdAt:now,
      payload:{transcriptId:transcript,agent,blob:key,baseOffset,length:bytes.length,originPath:'fixture.jsonl',role:'primary'}}),env);
  if(!result.persisted)throw new Error(JSON.stringify(result));
  return env;
}

/** Captured facts use the admitted ingest writer on either relational adapter. */
export async function captureDocumentSession(db: RelationalStore, projectId = 'project', sessionId = 'session', options: { toolInput?: { path: string }; blobs?: BlobStore; idOffset?: number; promptText?:string; parsedMaterial?:boolean; promptId?:string; parentSessionId?:string; launchParentSessionId?:string } = {}) {
  const now = options.blobs === undefined ? 1 : Date.now();
  const id = (n: number) => n===20&&options.promptId!==undefined?options.promptId:uuid(n + (options.idOffset ?? 0));
  await ensureMember(db, 'member', now, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now };
  for (const event of [
    envelope({ eventId: id(1), sessionId, kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1, parentSessionId:options.parentSessionId,launchParentSessionId:options.launchParentSessionId } }),
    envelope({ eventId: id(2), sessionId, kind: 'prompt', payload: { promptId: id(20), text: options.promptText??'factcanary', origin: 'user' } }),
    envelope({ eventId: id(3), sessionId, kind: 'response', payload: { responseId: id(30), promptId: id(20), text: 'factcanary' } }),
    envelope({ eventId: id(4), sessionId, kind: 'tool.use', payload: { toolCallId: id(40), toolName: 'Read', input: options.toolInput ?? { path: 'test' }, success: true } }),
    envelope({ eventId: id(5), sessionId, kind: 'plan', payload: { planKey: id(50), content: 'factcanary', status: 'active' } }),
  ]) {
    const derived = options.parsedMaterial === true && event.kind !== 'session.start';
    const result = await ingestEvent(db, derived ? {...ctx,writeOrigin:'server'} : ctx,
      derived ? {...event,producer:TRANSCRIPT_PRODUCER} : event,
      options.blobs === undefined ? undefined : { db, blobs: options.blobs });
    if (!result.persisted) throw new Error(`fixture capture refused: ${JSON.stringify(result)}`);
  }
  return issued;
}
