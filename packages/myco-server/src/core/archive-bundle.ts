import { SHA256 } from '@stablelib/sha256';
import type { ContentStore, RelationalStore } from './adapters.js';
import type { Bound } from '../db/index.js';
import { agedArchivePreparations, bundleArchive, bundleRegistrations, contentProofHeld, preparationLiveGuard, preparationReceiptGuard,
  readArchivePreparation, readStoredBundle, recordArchivePreparation, releaseArchivePreparationRows, stampArchivePreparationReceipt,
  storedBundleEvidence } from '../db/storage/archive-bundles.js';
import { blobObjectKey } from './blob-objects.js';

import { readStoredObject } from './stored-object.js';
import { sha256HexOf, utf8 } from '../hash.js';
import { prepareDerivedContent, prepareDerivedStream,
  type ContentPublicationGuard, type DerivedContentSource, type VerifiedContent } from './registered-content.js';
import { verifiedContentSql } from '../db/storage/content-source.js';
import { sourceBytes, measureSource, type ContentRow } from './event-content.js';
import { releaseBlobs } from './object-release.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';

const ARCHIVE_BUNDLE_VERSION = 1;
export const ARCHIVE_BUNDLE_ENTRIES = 64;
export const ARCHIVE_BUNDLE_BYTES = 1024 * 1024;
export const ARCHIVE_PREPARATION_PAGE = 8;
export const ARCHIVE_PREPARATION_WALL_MS = 500;
const METADATA_OBJECT_RECORD_ALLOWANCE = 1800;
const METADATA_IDENTITY_INDEX_COPIES = 6;
const METADATA_LOCATOR_ALLOWANCE = 40;
type BundleKind = 'event' | 'tool-input';
interface BundleEntry {
  kind: BundleKind; resourceId: string; eventId: string; envelopeHash: string;
  revision: number; rawRevision: number; offset: number; length: number; digest: string;
}
export interface BundleItem { kind: 'event'; row: ContentRow; text?: string }
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
  await recordArchivePreparation(env.db,preparationId,source.projectId,digest,now+BLOB_RESERVATION_TTL_MS);
  try {
    const body=await prepareDerivedStream(env,source,{size,digest,stream},now,preparationLiveGuard(preparationId,source.projectId,digest));
    const receiptText=JSON.stringify({version:ARCHIVE_BUNDLE_VERSION,header,body});
    const receiptKey=await sha256HexOf(utf8(receiptText));
    const stamped=await stampArchivePreparationReceipt(env.db,{preparationId,projectId:source.projectId,archiveKey:digest},
      receiptKey,Math.max(now,Date.now())+BLOB_RESERVATION_TTL_MS);
    if(!stamped)throw new Error('content_preparation_expired');
    const receipt=await prepareDerivedContent(env,{...source,sourceKind:'receipt',resourceId:'bundle:'+body.key},
      receiptText,now,preparationReceiptGuard(preparationId,source.projectId,digest,receiptKey));
    return {preparationId,source,body,receipt,entries,items:items.map((item,i)=>({...item,preview:measures[i]!.preview})),
      metadataBytes:metadataBytes(source,body,receipt,entries.length)};
  } catch(error) {
    await releaseArchivePreparation(env.db,preparationId,now);
    throw error;
  }
}

/** Publishes the bundle and moves its source rows onto compact locators, in the caller's transaction; no per-entry catalogue or index is created. */
export function bundleArchiveStatements(_db:RelationalStore,bundle:PreparedBundle):Bound<never,'write'>[] {
  if(bundle.items.length===0||bundle.items.length>ARCHIVE_BUNDLE_ENTRIES)throw new Error('content_bundle_page_invalid');
  if (bundle.items.some(item => item.kind !== 'event')) throw new Error('content_bundle_kind_unsupported');
  const sources=JSON.stringify(bundle.items.map(item=>({kind:item.kind,...item.row})));
  const locators=JSON.stringify(bundle.items.map((item,entry)=>({kind:item.kind,project:item.row.project_id,
    id:item.row.resource_id,entry,preview:item.preview,bytes:item.row.bytes})));
  return bundleArchive({preparationId:bundle.preparationId,projectId:bundle.source.projectId,sessionId:bundle.source.sessionId,
    tokenId:bundle.source.tokenId,eventId:bundle.source.eventId,envelopeHash:bundle.source.envelopeHash,
    archiveKey:bundle.body.key,receiptKey:bundle.receipt.key,digest:bundle.body.digest,size:bundle.body.size,
    version:ARCHIVE_BUNDLE_VERSION,entries:bundle.entries.length,
    body:verifiedContentSql(bundle.source,bundle.body),
    receipt:verifiedContentSql({...bundle.source,sourceKind:'receipt',resourceId:'bundle:'+bundle.body.key},bundle.receipt)},
  sources,locators);
}

type BundleEnv=Pick<ContentStore,'db'|'blobs'>;
interface Loaded { evidence?:ContentPublicationGuard[];header:Header; bytes:Uint8Array<ArrayBuffer>; start:number }
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
  const row=await readStoredBundle(env.db,projectId,bundleId);
  if(!row) throw new Error('event_content_reference_invalid');
  const source:DerivedContentSource={projectId,sessionId:row.session_id,tokenId:row.token_id,eventId:row.event_id,
    envelopeHash:row.envelope_hash,sourceKind:'bundle',resourceId:row.archive_key};
  const evidence:ContentPublicationGuard[]=[];
  for(const [key,generation,size,kind,id] of [[row.archive_key,row.generation,row.size,'bundle',row.archive_key],
    [row.receipt_key,row.receipt_generation,row.receipt_size,'receipt','bundle:'+row.archive_key]] as const){
    const proof=verifiedContentSql({...source,sourceKind:kind,resourceId:id},{key,generation,size,digest:key});
    if(!(await contentProofHeld(env.db,proof))) throw new Error('event_content_reference_invalid');
    evidence.push(proof);
  }
  evidence.push(storedBundleEvidence(projectId,bundleId,row));
  const loaded=await parseBundleObjects(env.blobs,row,{generation:row.generation,size:row.size},
    {generation:row.receipt_generation,size:row.receipt_size});
  return {...loaded,evidence};
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
  locators:readonly BundleEntryIdentity[]):Promise<ReadonlyMap<string,string>>{
  const {body,receipt}=await bundleRegistrations(env.db,row.project_id,row.archive_key,row.receipt_key);
  if(body===undefined||receipt===undefined||body.size!==row.size)throw new Error('event_content_reference_invalid');
  for(const [key,kind,sourceId,size] of [[row.archive_key,'bundle',row.archive_key,body.size],
    [row.receipt_key,'receipt',`bundle:${row.archive_key}`,receipt.size]] as const){
    if(!proofs.some(proof=>proof.project_id===row.project_id&&proof.key===key&&proof.source_kind===kind
      &&proof.source_id===sourceId&&proof.event_id===row.event_id&&proof.envelope_hash===row.envelope_hash
      &&proof.session_id===row.session_id&&proof.digest===key&&proof.size===size&&proof.durable===1))
      throw new Error('event_content_reference_invalid');
  }
  const loaded=await parseBundleObjects(env.blobs,row,body,receipt);
  const contents=new Map<string,string>();
  for(const locator of locators){
    if(locator.projectId!==row.project_id)throw new Error('content_bundle_entry_invalid');
    contents.set(locator.resourceId,await readEntry(loaded,locator));
  }
  return contents;
}

/** Resolves and verifies exact bytes and immutable source identity for one compact locator. */
export async function readBundleEntry(env:BundleEnv,identity:BundleEntryIdentity & {bundleId:number},evidence?:ContentPublicationGuard[]):Promise<string>{
  const cache=requestCaches.get(env);const key=identity.projectId+':'+identity.bundleId;
  let pending=cache?.get(key);if(!pending){pending=loadBundle(env,identity.projectId,identity.bundleId);cache?.set(key,pending);}
  const loaded=await pending;
  if(evidence)evidence.push(...(loaded.evidence??[]));
  return readEntry(loaded,identity);
}

/** Releases one preparation's exact evidence through the object-release owner. */
async function releaseArchivePreparation(db:RelationalStore,preparationId:string,now:number,agedOnly=false):Promise<number>{
  const row=await readArchivePreparation(db,preparationId);
  if(row===null||(agedOnly&&row.expires_at>now))return 0;
  if(!await releaseArchivePreparationRows(db,row,now,{agedOnly}))return 0;
  await releaseBlobs(db,[row.archive_key,row.receipt_key].filter((key):key is string=>key!==null).map(key=>({projectId:row.project_id,key})),now);
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
  let released=0;
  for(const [index,preparationId] of (await agedArchivePreparations(db,now,page)).entries()){
    if(index>0&&clock()>=deadline)break;
    released+=await releaseArchivePreparation(db,preparationId,now,true);
  }
  return released;
}

/** Whether the age index still holds work for the next wake. */
export async function archivePreparationsPending(db:RelationalStore,now:number):Promise<boolean>{
  return (await agedArchivePreparations(db,now,1)).length>0;
}
