import { SHA256 } from '@stablelib/sha256';
import type { ContentStore, PreparedStatement, RelationalStore } from './adapters.js';
import { blobObjectKey } from './blob-objects.js';
import { readStoredObject } from './stored-object.js';
import { sha256HexOf, utf8 } from '../hash.js';
import { contentAssertion, prepareDerivedContent, prepareDerivedStream, verifiedContentSql,
  type DerivedContentSource, type VerifiedContent } from './registered-content.js';
import { sourceBytes, measureSource, type ContentRow } from './event-content.js';
import { recordBlobCandidates,releaseBlobs } from './object-release.js';
import { effectiveRawOwnerSql } from './raw-claims.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';

export const ARCHIVE_BUNDLE_VERSION = 1;
export const ARCHIVE_BUNDLE_ENTRIES = 64;
export const ARCHIVE_BUNDLE_BYTES = 1024 * 1024;
export const ARCHIVE_PREPARATION_PAGE = 8;
export const ARCHIVE_PREPARATION_WALL_MS = 500;
const METADATA_OBJECT_RECORD_ALLOWANCE = 1800;
const METADATA_IDENTITY_INDEX_COPIES = 6;
const METADATA_LOCATOR_ALLOWANCE = 40;
export type BundleKind = 'event' | 'tool-input';
export interface BundleEntry {
  kind: BundleKind; resourceId: string; eventId: string; envelopeHash: string;
  revision: number; rawRevision: number; offset: number; length: number; digest: string;
}
export interface BundleItem { kind: BundleKind; row: ContentRow; text?: string }
export interface PreparedBundle {
  preparationId: string;
  source: DerivedContentSource; body: VerifiedContent; receipt: VerifiedContent;
  entries: BundleEntry[]; items: Array<BundleItem & { preview: string }>;
  metadataBytes: number;
}
interface Header { version: number; projectId: string; sessionId: string; tokenId: string; entries: BundleEntry[] }

function metadataBytes(source:DerivedContentSource,body:VerifiedContent,receipt:VerifiedContent,entries:number):number {
  return 2*(METADATA_OBJECT_RECORD_ALLOWANCE+utf8(source.projectId+source.sessionId+source.tokenId+source.eventId+source.envelopeHash).length*METADATA_IDENTITY_INDEX_COPIES)
    +utf8(JSON.stringify({source,body,receipt})).length+entries*METADATA_LOCATOR_ALLOWANCE;
}

/** Conservative registration, proof, provenance, index and locator admission before publication. */
export function projectedBundleMetadata(items:readonly BundleItem[]):number {
  const first=items[0];if(!first)throw new Error('content_bundle_page_invalid');
  const digest='f'.repeat(64);
  const source:DerivedContentSource={projectId:first.row.project_id,sessionId:first.row.session_id,tokenId:first.row.token_id,
    eventId:first.row.event_id,envelopeHash:first.row.envelope_hash,sourceKind:'bundle',resourceId:digest};
  const proof:VerifiedContent={key:digest,digest,generation:digest,size:Number.MAX_SAFE_INTEGER};
  return metadataBytes(source,proof,proof,items.length);
}

/** A bundle contains one session and one immutable uploader evidence class. */
export async function prepareArchiveBundle(env: Pick<ContentStore,'db'|'blobs'>, items: BundleItem[], now: number,
  measured?: Array<{digest:string;preview:string}>,memberTokenId?:string,finishDigest?:(tail:Uint8Array<ArrayBuffer>)=>string): Promise<PreparedBundle> {
  const first=items[0];
  if(first===undefined||items.length>ARCHIVE_BUNDLE_ENTRIES) throw new Error('content_bundle_page_invalid');
  if(items.some(item=>item.row.project_id!==first.row.project_id||item.row.session_id!==first.row.session_id
    ||item.row.token_id!==first.row.token_id||item.row.raw_owner!==first.row.raw_owner
    ||item.row.raw_provenance!==first.row.raw_provenance)) throw new Error('content_bundle_provenance_mixed');
  if(items.length>1&&items.reduce((sum,item)=>sum+item.row.bytes,0)>ARCHIVE_BUNDLE_BYTES) throw new Error('content_bundle_page_invalid');
  const small=items.reduce((sum,item)=>sum+item.row.bytes,0)<=ARCHIVE_BUNDLE_BYTES;
  const streams=await Promise.all(items.map(async item=>{
    if(item.text!==undefined)return ()=>new Blob([utf8(item.text!)]).stream();
    const stream=sourceBytes(env.db,item.kind,item.row);
    if(!small)return stream;
    const bytes=await new Response(stream()).arrayBuffer();
    if(bytes.byteLength!==item.row.bytes)throw new Error('content_source_changed');
    return ()=>new Blob([bytes]).stream();
  }));
  const measures=measured??await Promise.all(streams.map((stream,i)=>measureSource(stream,items[i]!.row.bytes)));
  let offset=0;
  const entries=items.map((item,i):BundleEntry=>{
    const entry={kind:item.kind,resourceId:item.row.resource_id,eventId:item.row.event_id,envelopeHash:item.row.envelope_hash,
      revision:item.row.content_revision,rawRevision:item.row.raw_revision??0,offset,length:item.row.bytes,digest:measures[i]!.digest};
    offset+=entry.length;return entry;
  });
  const header:Header={version:ARCHIVE_BUNDLE_VERSION,projectId:first.row.project_id,sessionId:first.row.session_id,
    tokenId:first.row.token_id,entries};
  const footer=utf8(JSON.stringify(header));
  const prefix=utf8(JSON.stringify(header)+'\n'+footer.length.toString(16).padStart(8,'0'));
  const stream=()=>{
    let at=0;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    return new ReadableStream<Uint8Array>({async pull(controller){
      while(at<streams.length){
        reader??=streams[at]!().getReader();
        const next=await reader.read();
        if(!next.done){controller.enqueue(next.value);return;}
        reader.releaseLock();reader=undefined;at++;
      }
      if(at===streams.length){controller.enqueue(prefix);at++;return;}
      controller.close();
    },async cancel(){if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}}}, {highWaterMark:0});
  };
  let size=items.reduce((sum,item)=>sum+item.row.bytes,0)+prefix.length;let digest:string;
  if(finishDigest)digest=finishDigest(prefix);
  else {
    const hash=new SHA256();const reader=stream().getReader();let counted=0;
    try {for(;;){const next=await reader.read();if(next.done)break;hash.update(next.value);counted+=next.value.byteLength;}
      if(counted!==size)throw new Error('content_source_changed');
      digest=[...hash.digest()].map(value=>value.toString(16).padStart(2,'0')).join('');
    } finally {try{await reader.cancel();}finally{reader.releaseLock();hash.clean();}}
  }
  const source:DerivedContentSource={projectId:header.projectId,sessionId:header.sessionId,tokenId:header.tokenId,
    eventId:first.row.event_id,envelopeHash:first.row.envelope_hash,sourceKind:'bundle',resourceId:digest,memberTokenId};
  const preparationId=crypto.randomUUID();
  await env.db.prepare(`INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,expires_at)
    VALUES(?,?,?,?)`).bind(preparationId,source.projectId,digest,now+BLOB_RESERVATION_TTL_MS).run();
  try {
    const bodyGuard={sql:`EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND expires_at>?)`,
      params:()=>[preparationId,source.projectId,digest,Date.now()]};
    const body=await prepareDerivedStream(env,source,{size,digest,stream},now,bodyGuard);
    const receiptText=JSON.stringify({version:ARCHIVE_BUNDLE_VERSION,header,body});
    const receiptKey=await sha256HexOf(utf8(receiptText));
    const updated=await env.db.prepare(`UPDATE prepared_archive_bundles SET receipt_key=?,expires_at=?
      WHERE preparation_id=? AND project_id=? AND archive_key=?`)
      .bind(receiptKey,Math.max(now,Date.now())+BLOB_RESERVATION_TTL_MS,preparationId,source.projectId,digest).run();
    if(updated.meta.changes!==1)throw new Error('content_preparation_expired');
    const receiptGuard={sql:`EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND receipt_key=? AND expires_at>?)`,
      params:()=>[preparationId,source.projectId,digest,receiptKey,Date.now()]};
    const receipt=await prepareDerivedContent(env,{...source,sourceKind:'receipt',resourceId:'bundle:'+body.key},
      receiptText,now,receiptGuard);
    return {preparationId,source,body,receipt,entries,items:items.map((item,i)=>({...item,preview:measures[i]!.preview})),
      metadataBytes:metadataBytes(source,body,receipt,entries.length)};
  } catch(error) {
    await releaseArchivePreparation(env.db,preparationId,now);
    throw error;
  }
}

/** Publication evidence and all source revisions are checked in the adopting transaction. */
export function bundlePublicationStatements(db:RelationalStore,bundle:PreparedBundle,
  adoption?:{sql:string;params:readonly unknown[]}):PreparedStatement[] {
  const body=verifiedContentSql(bundle.source,bundle.body);
  const receipt=verifiedContentSql({...bundle.source,sourceKind:'receipt',resourceId:'bundle:'+bundle.body.key},bundle.receipt);
  return [
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND receipt_key=? AND expires_at>?)`,
      [bundle.preparationId,bundle.source.projectId,bundle.body.key,bundle.receipt.key,Date.now()],adoption),
    ...contentAssertion(db,`${body.sql} AND ${receipt.sql} AND NOT EXISTS
      (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)`,
      [...body.params,...receipt.params,bundle.source.projectId,bundle.source.sessionId],adoption),
    db.prepare(`INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,
      archive_key,receipt_key,digest,size,version,entry_count) SELECT ?,?,?,?,?,?,?,?,?,?,?
      ${adoption===undefined?'':`WHERE (${adoption.sql})`} ON CONFLICT(project_id,archive_key) DO NOTHING`)
      .bind(bundle.source.projectId,bundle.source.sessionId,bundle.source.tokenId,bundle.source.eventId,bundle.source.envelopeHash,
        bundle.body.key,bundle.receipt.key,bundle.body.digest,bundle.body.size,ARCHIVE_BUNDLE_VERSION,bundle.entries.length,...(adoption?.params??[])),
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM archive_bundles WHERE project_id=? AND archive_key=? AND receipt_key=?
      AND session_id=? AND token_id=? AND digest=? AND size=? AND entry_count=?)`,
      [bundle.source.projectId,bundle.body.key,bundle.receipt.key,bundle.source.sessionId,bundle.source.tokenId,
        bundle.body.digest,bundle.body.size,bundle.entries.length],adoption),
    db.prepare(`DELETE FROM prepared_archive_bundles WHERE preparation_id=? AND project_id=? AND archive_key=? AND receipt_key=?
      ${adoption===undefined?'':`AND (${adoption.sql})`}`)
      .bind(bundle.preparationId,bundle.source.projectId,bundle.body.key,bundle.receipt.key,...(adoption?.params??[])),
  ];
}

/** Existing rows carry compact locators; no per-entry catalogue or index is created. */
export function bundleArchiveStatements(db:RelationalStore,bundle:PreparedBundle):PreparedStatement[] {
  if(bundle.items.length===0||bundle.items.length>ARCHIVE_BUNDLE_ENTRIES)throw new Error('content_bundle_page_invalid');
  const sources=JSON.stringify(bundle.items.map(item=>({kind:item.kind,...item.row})));
  const sourceGuard=`NOT EXISTS (SELECT 1 FROM json_each(?) j
    LEFT JOIN events e ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.event_id')
    LEFT JOIN raw_credentials c ON c.token_id=json_extract(j.value,'$.token_id')
    LEFT JOIN tool_calls t ON t.project_id=json_extract(j.value,'$.project_id') AND t.tool_call_id=json_extract(j.value,'$.resource_id')
    WHERE e.event_id IS NULL OR e.session_id<>json_extract(j.value,'$.session_id')
      OR e.envelope_hash<>json_extract(j.value,'$.envelope_hash') OR (json_extract(j.value,'$.kind')='event' AND e.token_id<>json_extract(j.value,'$.token_id'))
      OR COALESCE(e.raw_revision,0)<>COALESCE(json_extract(j.value,'$.raw_revision'),0)
      OR (json_type(j.value,'$.raw_owner') IS NOT NULL AND ${effectiveRawOwnerSql('c.owner_member_id','c.provenance','e.raw_revision')}
        IS NOT json_extract(j.value,'$.raw_owner'))
      OR (json_type(j.value,'$.raw_provenance') IS NOT NULL AND c.provenance IS NOT json_extract(j.value,'$.raw_provenance'))
      OR CASE json_extract(j.value,'$.kind') WHEN 'event' THEN
        e.payload_format<>'inline' OR e.content_revision<>json_extract(j.value,'$.content_revision')
          OR length(CAST(e.payload AS BLOB))<>json_extract(j.value,'$.bytes')
        ELSE t.tool_call_id IS NULL OR t.event_id<>e.event_id OR t.session_id<>e.session_id
          OR t.token_id<>json_extract(j.value,'$.token_id') OR t.content_revision<>json_extract(j.value,'$.content_revision')
          OR CASE WHEN json_extract(j.value,'$.input_bundle_id') IS NULL THEN length(CAST(t.input AS BLOB))<>json_extract(j.value,'$.bytes')
            ELSE t.input_bundle_id IS NOT json_extract(j.value,'$.input_bundle_id') OR t.input_bundle_entry IS NOT json_extract(j.value,'$.input_bundle_entry')
              OR t.input_bytes<>json_extract(j.value,'$.bytes') END END)`;
  const statements=[...contentAssertion(db,sourceGuard,[sources]),...bundlePublicationStatements(db,bundle)];
  const locators=JSON.stringify(bundle.items.map((item,entry)=>({kind:item.kind,project:item.row.project_id,
    id:item.row.resource_id,entry,preview:item.preview,bytes:item.row.bytes})));
  for(const kind of ['event','tool-input'] as const){
    if(!bundle.items.some(item=>item.kind===kind))continue;
    const table=kind==='event'?'events':'tool_calls';const id=kind==='event'?'event_id':'tool_call_id';
    const value=(field:string)=>`(SELECT json_extract(j.value,'$.${field}') FROM json_each(?) j
      WHERE json_extract(j.value,'$.kind')='${kind}' AND json_extract(j.value,'$.project')=${table}.project_id
        AND json_extract(j.value,'$.id')=${table}.${id})`;
    const identity=`rowid IN (SELECT r.rowid FROM json_each(?) j CROSS JOIN ${table} r
      WHERE json_extract(j.value,'$.kind')='${kind}' AND r.project_id=json_extract(j.value,'$.project')
        AND r.${id}=json_extract(j.value,'$.id'))`;
    if(kind==='event')statements.push(db.prepare(`UPDATE events SET
      archived_ended_at=COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.endedAt') END,created_at),
      archived_title_only_end=CASE WHEN kind='session.end' AND json_valid(payload) AND json_type(payload,'$.endedAt') IS NULL
        AND json_type(payload,'$.title') IS NOT NULL THEN 1 ELSE 0 END,
      archived_prompt_origin=CASE WHEN json_valid(payload) THEN json_extract(payload,'$.origin') END,
      bundle_id=(SELECT id FROM archive_bundles WHERE project_id=? AND archive_key=?),bundle_entry=${value('entry')},
      payload='{}',payload_format='archived',payload_bytes=0 WHERE ${identity}`)
      .bind(bundle.source.projectId,bundle.body.key,locators,locators));
    else statements.push(db.prepare(`UPDATE tool_calls SET input=${value('preview')},input_bytes=${value('bytes')},input_blob_key=NULL,
      input_bundle_id=(SELECT id FROM archive_bundles WHERE project_id=? AND archive_key=?),input_bundle_entry=${value('entry')}
      WHERE ${identity}`).bind(locators,locators,bundle.source.projectId,bundle.body.key,locators,locators));
  }
  statements.push(db.prepare(`DELETE FROM content_scan_checkpoints WHERE rowid IN
    (SELECT c.rowid FROM json_each(?) j CROSS JOIN content_scan_checkpoints c
      WHERE c.project_id=json_extract(j.value,'$.project_id')
        AND c.source_kind=json_extract(j.value,'$.kind')
        AND c.resource_id=json_extract(j.value,'$.resource_id')
        AND c.content_revision=json_extract(j.value,'$.content_revision')
        AND c.envelope_hash=json_extract(j.value,'$.envelope_hash'))`).bind(sources));
  statements.push(db.prepare(`DELETE FROM storage_cleanup_omissions WHERE rowid IN
    (SELECT o.rowid FROM json_each(?) j CROSS JOIN storage_cleanup_omissions o
      WHERE o.project_id=json_extract(j.value,'$.project_id') AND o.resource_kind=json_extract(j.value,'$.kind')
        AND o.resource_id=json_extract(j.value,'$.resource_id'))`).bind(sources));
  const old=JSON.stringify(bundle.items.filter(item=>item.row.input_bundle_id!==null&&item.row.input_bundle_id!==undefined)
    .map(item=>({id:item.row.input_bundle_id,entry:item.row.input_bundle_entry,key:item.row.input_archive_key,
      receipt:item.row.input_receipt_key,resourceId:item.row.resource_id})));
  statements.push(db.prepare(`DELETE FROM archive_bundles WHERE rowid IN
    (SELECT a.rowid FROM json_each(?) j CROSS JOIN archive_bundles a
      WHERE a.id=json_extract(j.value,'$.id') AND a.project_id=? AND a.entry_count=1
        AND json_extract(j.value,'$.entry')=0
        AND EXISTS(SELECT 1 FROM tool_calls t WHERE t.project_id=a.project_id
          AND t.tool_call_id=json_extract(j.value,'$.resourceId') AND t.input_bundle_id IS NOT a.id)
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id
          AND e.event_id=a.event_id AND e.bundle_id=a.id))`)
    .bind(old,bundle.source.projectId));
  for(const kind of ['bundle','receipt'] as const){
    const sourceId=kind==='bundle'?"json_extract(j.value,'$.key')":"'bundle:'||json_extract(j.value,'$.key')";
    const key=kind==='bundle'?"json_extract(j.value,'$.key')":"json_extract(j.value,'$.receipt')";
    statements.push(db.prepare(`DELETE FROM registered_content_proofs WHERE rowid IN
      (SELECT p.rowid FROM json_each(?) j CROSS JOIN registered_content_proofs p
        WHERE p.project_id=? AND p.source_kind='${kind}' AND p.source_id=${sourceId} AND p.key=${key}
          AND NOT EXISTS(SELECT 1 FROM archive_bundles a WHERE a.project_id=p.project_id AND a.archive_key=p.key)
          AND NOT EXISTS(SELECT 1 FROM archive_bundles a WHERE a.project_id=p.project_id AND a.receipt_key=p.key))`)
      .bind(old,bundle.source.projectId));
  }
  statements.push(...recordBlobCandidates(db,bundle.items.flatMap(item=>[item.row.input_archive_key,item.row.input_receipt_key]
    .filter((key):key is string=>typeof key==='string').map(key=>({projectId:bundle.source.projectId,key}))),Date.now()));
  return statements;
}

type BundleEnv=Pick<ContentStore,'db'|'blobs'>;
interface Loaded { header:Header; bytes:Uint8Array<ArrayBuffer>; start:number }
type BundleRecord={project_id:string;session_id:string;token_id:string;event_id:string;envelope_hash:string;
  archive_key:string;receipt_key:string;digest:string;size:number;version:number;entry_count:number};
type Registration={generation:string|null;size:number};
export type BundleEntryIdentity={projectId:string;entry:number;kind:BundleKind;resourceId:string;
  eventId?:string;envelopeHash?:string;tokenId?:string;revision?:number;rawRevision?:number};
const requestCaches=new WeakMap<BundleEnv,Map<string,Promise<Loaded>>>();
/** A fresh request scope shares verified bundle reads within that request. */
export function bundleContentEnv<T extends BundleEnv>(env:T):T {
  const scoped={...env};requestCaches.set(scoped,new Map());return scoped;
}

async function parseBundleObjects(blobs:BundleEnv['blobs'],row:BundleRecord,body:Registration,receiptRegistration:Registration):Promise<Loaded>{
  const projectId=row.project_id;
  if(row.version!==ARCHIVE_BUNDLE_VERSION||row.digest!==row.archive_key||body.size!==row.size
    ||!Number.isSafeInteger(row.entry_count)||row.entry_count<1||row.entry_count>ARCHIVE_BUNDLE_ENTRIES)
    throw new Error('event_content_reference_invalid');
  const receipt=await readStoredObject(blobs,blobObjectKey(projectId,row.receipt_key,receiptRegistration.generation),receiptRegistration.size);
  if(receipt.kind!=='read'||await sha256HexOf(receipt.bytes)!==row.receipt_key) throw new Error('event_content_receipt_invalid');
  const inventory=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.bytes)) as {version:number;header:Header;body:VerifiedContent};
  const object=await readStoredObject(blobs,blobObjectKey(projectId,row.archive_key,body.generation),row.size);
  if(object.kind!=='read'||await sha256HexOf(object.bytes)!==row.digest) throw new Error('event_content_archive_invalid');
  const trailer=new TextDecoder('utf-8',{fatal:true}).decode(object.bytes.subarray(-9));
  if(!/^\n[0-9a-f]{8}$/.test(trailer))throw new Error('content_bundle_format_invalid');
  const headerLength=parseInt(trailer.slice(1),16);const start=object.bytes.length-9-headerLength;
  if(start<0)throw new Error('content_bundle_format_invalid');
  const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(object.bytes.subarray(start,start+headerLength))) as Header;
  if(header.version!==ARCHIVE_BUNDLE_VERSION||header.projectId!==projectId||header.sessionId!==row.session_id||header.tokenId!==row.token_id
    ||header.entries.length!==row.entry_count||JSON.stringify(header)!==JSON.stringify(inventory.header)
    ||inventory.version!==ARCHIVE_BUNDLE_VERSION||inventory.body.key!==row.archive_key||inventory.body.size!==row.size
    ||inventory.body.digest!==row.digest) throw new Error('event_content_receipt_invalid');
  let end=0;
  for(const entry of header.entries){
    if((entry.kind!=='event'&&entry.kind!=='tool-input')||typeof entry.resourceId!=='string'||typeof entry.eventId!=='string'
      ||typeof entry.envelopeHash!=='string'||!Number.isSafeInteger(entry.revision)||!Number.isSafeInteger(entry.rawRevision)
      ||typeof entry.digest!=='string'||!/^[0-9a-f]{64}$/.test(entry.digest)
      ||!Number.isSafeInteger(entry.offset)||entry.offset!==end||!Number.isSafeInteger(entry.length)||entry.length<0)
      throw new Error('content_bundle_format_invalid');
    if(await sha256HexOf(object.bytes.subarray(end,end+entry.length))!==entry.digest)
      throw new Error('content_bundle_entry_digest_mismatch');
    end+=entry.length;
  }
  if(end!==start) throw new Error('content_bundle_format_invalid');
  return {header,bytes:new Uint8Array(object.bytes),start:0};
}

async function loadBundle(env:BundleEnv,projectId:string,bundleId:number):Promise<Loaded>{
  const row=await env.db.prepare(`SELECT a.*,b.generation,rb.generation AS receipt_generation,rb.size AS receipt_size
    FROM archive_bundles a JOIN blobs b ON b.project_id=a.project_id AND b.key=a.archive_key AND b.size=a.size
    JOIN blobs rb ON rb.project_id=a.project_id AND rb.key=a.receipt_key WHERE a.project_id=? AND a.id=?`)
    .bind(projectId,bundleId).first<BundleRecord & {generation:string|null;receipt_generation:string|null;receipt_size:number}>();
  if(!row) throw new Error('event_content_reference_invalid');
  const source:DerivedContentSource={projectId,sessionId:row.session_id,tokenId:row.token_id,eventId:row.event_id,
    envelopeHash:row.envelope_hash,sourceKind:'bundle',resourceId:row.archive_key};
  for(const [key,generation,size,kind,id] of [[row.archive_key,row.generation,row.size,'bundle',row.archive_key],
    [row.receipt_key,row.receipt_generation,row.receipt_size,'receipt','bundle:'+row.archive_key]] as const){
    const proof=verifiedContentSql({...source,sourceKind:kind,resourceId:id},{key,generation,size,digest:key});
    if(!(await env.db.prepare(`SELECT 1 AS ok WHERE ${proof.sql}`).bind(...proof.params).first())) throw new Error('event_content_reference_invalid');
  }
  return parseBundleObjects(env.blobs,row,{generation:row.generation,size:row.size},
    {generation:row.receipt_generation,size:row.receipt_size});
}

async function readEntry(loaded:Loaded,identity:BundleEntryIdentity):Promise<string>{
  const entry=loaded.header.entries[identity.entry];
  if(!Number.isSafeInteger(identity.entry)||!entry||entry.kind!==identity.kind||entry.resourceId!==identity.resourceId
    ||(identity.eventId!==undefined&&entry.eventId!==identity.eventId)
    ||(identity.envelopeHash!==undefined&&entry.envelopeHash!==identity.envelopeHash)
    ||(identity.tokenId!==undefined&&identity.tokenId!==loaded.header.tokenId)
    ||(identity.revision!==undefined&&identity.revision!==entry.revision)
    ||(identity.rawRevision!==undefined&&identity.rawRevision!==entry.rawRevision)) throw new Error('content_bundle_entry_invalid');
  const bytes=loaded.bytes.subarray(loaded.start+entry.offset,loaded.start+entry.offset+entry.length);
  if(await sha256HexOf(bytes)!==entry.digest) throw new Error('content_bundle_entry_digest_mismatch');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

/** Verify imported publication evidence and all requested entries before inserting relational rows. */
export async function verifyBundleArtifact(env:BundleEnv,row:BundleRecord,proofs:readonly Record<string,unknown>[],
  locators:readonly BundleEntryIdentity[]):Promise<void>{
  const registrations=await env.db.batch([row.archive_key,row.receipt_key].map(key=>
    env.db.prepare(`SELECT generation,size FROM blobs WHERE project_id=? AND key=?`).bind(row.project_id,key)));
  const [body,receipt]=registrations.map(result=>result.results[0] as Registration|undefined);
  if(body===undefined||receipt===undefined||body.size!==row.size)throw new Error('event_content_reference_invalid');
  for(const [key,kind,sourceId,size] of [[row.archive_key,'bundle',row.archive_key,body.size],
    [row.receipt_key,'receipt',`bundle:${row.archive_key}`,receipt.size]] as const){
    if(!proofs.some(proof=>proof.project_id===row.project_id&&proof.key===key&&proof.source_kind===kind
      &&proof.source_id===sourceId&&proof.event_id===row.event_id&&proof.envelope_hash===row.envelope_hash
      &&proof.session_id===row.session_id&&proof.digest===key&&proof.size===size&&proof.durable===1))
      throw new Error('event_content_reference_invalid');
  }
  const loaded=await parseBundleObjects(env.blobs,row,body,receipt);
  for(const locator of locators){
    if(locator.projectId!==row.project_id)throw new Error('content_bundle_entry_invalid');
    await readEntry(loaded,locator);
  }
}

/** Resolves and verifies exact bytes and immutable source identity for one compact locator. */
export async function readBundleEntry(env:BundleEnv,identity:BundleEntryIdentity & {bundleId:number}):Promise<string>{
  const cache=requestCaches.get(env);const key=identity.projectId+':'+identity.bundleId;
  let pending=cache?.get(key);if(!pending){pending=loadBundle(env,identity.projectId,identity.bundleId);cache?.set(key,pending);}
  return readEntry(await pending,identity);
}

type PreparationRecord={preparation_id:string;project_id:string;archive_key:string;receipt_key:string|null;expires_at:number};

/** Releases one preparation's exact evidence through the object-release owner. */
async function releaseArchivePreparation(db:RelationalStore,preparationId:string,now:number,agedOnly=false):Promise<number>{
  const row=await db.prepare(`SELECT preparation_id,project_id,archive_key,receipt_key,expires_at
    FROM prepared_archive_bundles WHERE preparation_id=?`).bind(preparationId).first<PreparationRecord>();
  if(row===null||(agedOnly&&row.expires_at>now))return 0;
  const pairs=[row.archive_key,row.receipt_key].filter((key):key is string=>key!==null)
    .map(key=>({projectId:row.project_id,key}));
  const current={sql:`EXISTS (SELECT 1 FROM prepared_archive_bundles p
    WHERE p.preparation_id=? AND p.project_id=? AND p.archive_key=? AND p.receipt_key IS ?
      AND p.expires_at=?${agedOnly?' AND p.expires_at<=?':''})`,
    params:[row.preparation_id,row.project_id,row.archive_key,row.receipt_key,row.expires_at,...(agedOnly?[now]:[])]};
  const results=await db.batch([
    db.prepare(`DELETE FROM registered_content_proofs WHERE project_id=? AND source_kind='bundle'
      AND source_id=? AND key=? AND NOT EXISTS
        (SELECT 1 FROM archive_bundles WHERE project_id=? AND archive_key=?)
      AND NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=? AND archive_key=? AND preparation_id<>?) AND ${current.sql}`)
      .bind(row.project_id,row.archive_key,row.archive_key,row.project_id,row.archive_key,
        row.project_id,row.archive_key,row.preparation_id,...current.params),
    ...(row.receipt_key===null?[]:[db.prepare(`DELETE FROM registered_content_proofs
      WHERE project_id=? AND source_kind='receipt' AND source_id=? AND key=? AND NOT EXISTS
        (SELECT 1 FROM archive_bundles WHERE project_id=? AND receipt_key=?)
      AND NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=? AND receipt_key=? AND preparation_id<>?) AND ${current.sql}`)
      .bind(row.project_id,'bundle:'+row.archive_key,row.receipt_key,row.project_id,row.receipt_key,
        row.project_id,row.receipt_key,row.preparation_id,...current.params)]),
    ...recordBlobCandidates(db,pairs,now,current),
    db.prepare(`DELETE FROM prepared_archive_bundles WHERE preparation_id=? AND project_id=?
      AND archive_key=? AND receipt_key IS ? AND expires_at=? ${agedOnly?'AND expires_at<=?':''}`)
      .bind(...current.params),
  ]);
  if(results.at(-1)?.meta.changes!==1)return 0;
  await releaseBlobs(db,pairs,now);
  return 1;
}

/** Discard a prepared bundle after a failed or abandoned adoption. */
export async function discardArchiveBundle(env:BundleEnv,bundle:PreparedBundle,now:number):Promise<number>{
  return releaseArchivePreparation(env.db,bundle.preparationId,now);
}

/** One age-indexed page of abandoned preparations, including partial body/receipt publication. */
export async function reconcileArchivePreparations(db:RelationalStore,now:number,page=ARCHIVE_PREPARATION_PAGE,
  clock:()=>number=Date.now):Promise<number>{
  const deadline=clock()+ARCHIVE_PREPARATION_WALL_MS;
  const {results}=await db.prepare(`SELECT preparation_id FROM prepared_archive_bundles
    WHERE expires_at<=? ORDER BY expires_at,preparation_id LIMIT ?`)
    .bind(now,page).all<{preparation_id:string}>();
  let released=0;
  for(const [index,row] of results.entries()){
    if(index>0&&clock()>=deadline)break;
    released+=await releaseArchivePreparation(db,row.preparation_id,now,true);
  }
  return released;
}

/** Whether the age index still holds work for the next wake. */
export async function archivePreparationsPending(db:RelationalStore,now:number):Promise<boolean>{
  return await db.prepare(`SELECT 1 AS pending FROM prepared_archive_bundles
    WHERE expires_at<=? ORDER BY expires_at,preparation_id LIMIT 1`).bind(now).first()!==null;
}
