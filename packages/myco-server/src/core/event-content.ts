import { SHA256 } from '@stablelib/sha256';
import type { RelationalStore, ContentStore } from './adapters.js';
import type { Bound } from '../db/index.js';
import { dropScanCheckpoint, inlineBodySlice, readScanCheckpoint, writeScanCheckpoint } from '../db/events/content-scan.js';
import { prepareArchiveBundle,bundleArchiveStatements,readBundleEntry,type PreparedBundle } from './archive-bundle.js';
import { readVerifiedContentText, type DerivedContentSource, type VerifiedContent } from './registered-content.js';
import { blobObjectKey } from './blob-objects.js';
import { storedEvent } from '../db/events/body.js';
import { TOOL_INPUT_PREVIEW_BYTES } from './tool-input.js';

const CONTENT_SLICE_BYTES = 1024 * 1024;
const CONTENT_SCAN_BYTES_PER_PASS = 1024 * 1024;

export interface ContentRow {
  project_id: string;
  resource_id: string;
  session_id: string;
  event_id: string;
  token_id: string;
  envelope_hash: string;
  content_revision: number;
  bytes: number;
  received_at: number;
  retained_bytes?: number;
  raw_revision?: number;
  raw_owner?: string | null;
  raw_provenance?: string | null;
}

interface PreparedArchive {
  source: DerivedContentSource;
  body: VerifiedContent;
  receipt: VerifiedContent;
  bundle: PreparedBundle;
}

type SourceKind = 'event';
type ScanCheckpoint = Pick<ContentRow,'session_id'|'event_id'|'token_id'|'envelope_hash'|'content_revision'|'bytes'> & { scanned_bytes: number; hash_state: string; preview_bytes: string };
type HashSnapshot = { state: number[]; buffer: number[] | null; bufferLength: number; bytesHashed: number };

const snapshot = (hash: SHA256): HashSnapshot => {
  const saved = hash.saveState();
  const result = { state: [...saved.state], buffer: saved.buffer === undefined ? null : [...saved.buffer],
    bufferLength: saved.bufferLength, bytesHashed: saved.bytesHashed };
  hash.cleanSavedState(saved);
  return result;
};

const restoreHash = (serialized: string, offset: number): SHA256 => {
  const saved = JSON.parse(serialized) as HashSnapshot;
  if (!Array.isArray(saved.state) || saved.state.length !== 8 || !saved.state.every(Number.isInteger)
    || (saved.buffer !== null && (!Array.isArray(saved.buffer) || saved.buffer.length !== 128
      || !saved.buffer.every(value => Number.isInteger(value) && value >= 0 && value <= 255)))
    || !Number.isSafeInteger(saved.bufferLength) || saved.bufferLength < 0 || saved.bufferLength >= 64
    || saved.bytesHashed !== offset) throw new Error('content_scan_checkpoint_invalid');
  return new SHA256().restoreState({ state: Int32Array.from(saved.state),
    buffer: saved.buffer === null ? undefined : Uint8Array.from(saved.buffer),
    bufferLength: saved.bufferLength, bytesHashed: saved.bytesHashed });
};

const sameSource = (held: ScanCheckpoint, row: ContentRow): boolean => held.session_id === row.session_id
  && held.event_id === row.event_id && held.token_id === row.token_id && held.envelope_hash === row.envelope_hash
  && held.content_revision === row.content_revision && held.bytes === row.bytes;

/** One complete source revision, sought and sliced by UTF-8 bytes. */
export function sourceBytes(db: RelationalStore, _kind: SourceKind, row: ContentRow): () => ReadableStream<Uint8Array> {
  return () => {
    let at = 0;
    return new ReadableStream({
      async pull(controller) {
        if (at >= row.bytes) { controller.close(); return; }
        const length = Math.min(CONTENT_SLICE_BYTES, row.bytes-at);
        const held = await inlineBodySlice(db, row, at+1, length);
        if (held === null) throw new Error('content_source_changed');
        const bytes = new Uint8Array(held);
        if (bytes.byteLength !== length) throw new Error('content_source_changed');
        at += length;
        controller.enqueue(bytes);
      },
    }, { highWaterMark: 0 });
  };
}

/** Exact original bytes and their byte-safe display prefix, without reading a whole oversized row. */
export async function measureSource(stream: () => ReadableStream<Uint8Array>, expected: number): Promise<{ digest: string; preview: string }> {
  const hash = new SHA256();
  const first = new Uint8Array(Math.min(TOOL_INPUT_PREVIEW_BYTES, expected));
  let at = 0;
  const reader = stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
      if (at < first.byteLength) first.set(next.value.subarray(0, first.byteLength-at), at);
      at += next.value.byteLength;
      if (at > expected) throw new Error('content_source_changed');
    }
    if (at !== expected) throw new Error('content_source_changed');
    const digest = [...hash.digest()].map(value => value.toString(16).padStart(2,'0')).join('');
    return { digest, preview: new TextDecoder('utf-8', { fatal: true }).decode(first, { stream: first.byteLength < expected }) };
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); hash.clean(); } }
}

/** A durable exact body and a durable inventory receipt precede any relational clear. */
async function prepareMeasuredArchive(env: Pick<ContentStore,'db'|'blobs'>, kind: SourceKind, row: ContentRow,
  measured: {digest:string;preview:string}, now: number,finishDigest?:(tail:Uint8Array<ArrayBuffer>)=>string): Promise<PreparedArchive & { preview: string }> {
  const bundle=await prepareArchiveBundle(env,[{kind,row}],now,[measured],undefined,finishDigest);
  return {source:bundle.source,body:bundle.body,receipt:bundle.receipt,bundle,preview:measured.preview};
}

export async function prepareArchive(env: Pick<ContentStore,'db'|'blobs'>, kind: SourceKind, row: ContentRow, now: number): Promise<PreparedArchive & { preview: string }> {
  return prepareMeasuredArchive(env,kind,row,await measureSource(sourceBytes(env.db,kind,row),row.bytes),now);
}

/** Each pass hashes at most one MiB, then persists the exact source revision and hash state. */
export async function prepareArchiveStep(env: Pick<ContentStore,'db'|'blobs'>,kind:SourceKind,row:ContentRow,now:number):
  Promise<{status:'pending';scanned:number}|{status:'ready';archive:PreparedArchive & {preview:string}}> {
  if(row.bytes<=CONTENT_SCAN_BYTES_PER_PASS) return {status:'ready',archive:await prepareArchive(env,kind,row,now)};
  const db=env.db;
  let held:ScanCheckpoint|null=await readScanCheckpoint(db,row.project_id,kind,row.resource_id);
  if(held!==null&&!sameSource(held,row)) {
    await dropScanCheckpoint(db,row.project_id,kind,row.resource_id,held);
    held=null;
  }
  const at=held?.scanned_bytes??0;
  if(!Number.isSafeInteger(at)||at<0||at>row.bytes) throw new Error('content_scan_checkpoint_invalid');
  const hash=held===null?new SHA256():restoreHash(held.hash_state,at);
  const preview=held===null?[]:JSON.parse(held.preview_bytes) as number[];
  if(!Array.isArray(preview)||preview.length!==Math.min(at,TOOL_INPUT_PREVIEW_BYTES)
    ||!preview.every(value=>Number.isInteger(value)&&value>=0&&value<=255)) throw new Error('content_scan_checkpoint_invalid');
  try {
    if(at===row.bytes) {
      const measured={digest:[...hash.digest()].map(value=>value.toString(16).padStart(2,'0')).join(''),
        preview:new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(preview),{stream:true})};
      return {status:'ready',archive:await prepareMeasuredArchive(env,kind,row,measured,now,tail=>{
        const finalHash=restoreHash(held!.hash_state,at);
        try{finalHash.update(tail);return [...finalHash.digest()].map(value=>value.toString(16).padStart(2,'0')).join('');}
        finally{finalHash.clean();}
      })};
    }
    let next=at;
    const end=Math.min(row.bytes,at+CONTENT_SCAN_BYTES_PER_PASS);
    while(next<end) {
      const length=Math.min(CONTENT_SLICE_BYTES,end-next);
      const read=await inlineBodySlice(db,row,next+1,length);
      if(read===null) throw new Error('content_source_changed');
      const bytes=new Uint8Array(read);
      if(bytes.byteLength!==length) throw new Error('content_source_changed');
      hash.update(bytes);
      if(preview.length<TOOL_INPUT_PREVIEW_BYTES) preview.push(...bytes.subarray(0,TOOL_INPUT_PREVIEW_BYTES-preview.length));
      next+=length;
    }
    const stored=await writeScanCheckpoint(db,kind,row,{scanned:next,state:JSON.stringify(snapshot(hash)),preview:JSON.stringify(preview),
      now,heldAt:held===null?null:at});
    if(!stored) throw new Error('content_scan_source_changed');
    return {status:'pending',scanned:next-at};
  } finally {hash.clean();}
}

/** Installs lifecycle facts and the discriminator together with the exact archived body. */
export function eventArchiveStatements(db: RelationalStore, row: ContentRow, archive: PreparedArchive): Bound<never,'write'>[] {
  if(!archive.bundle.items.some(item=>item.kind==='event'&&item.row.project_id===row.project_id&&item.row.event_id===row.event_id))
    throw new Error('content_bundle_entry_invalid');
  return bundleArchiveStatements(db,archive.bundle);
}

/** Resolves the exact stored event body in any form it has been held in; format and integrity failures remain visible. */
export async function eventContent(env: Pick<ContentStore,'db'|'blobs'>, projectId: string, eventId: string): Promise<string|null> {
  const row=await storedEvent(env.db,projectId,eventId);
  if(row===null)return null;
  if(row.payload_format==='inline')return row.payload;
  if(row.payload_format==='blob'){
    if(row.body_key===null||row.body_size===null)throw new Error('event_content_reference_invalid');
    return readVerifiedContentText(env,blobObjectKey(projectId,row.body_key,row.body_generation),row.body_size,row.body_key);
  }
  if(row.payload_format!=='archived')throw new Error('event_content_format_unsupported');
  if(row.bundle_id===null||row.bundle_entry===null)throw new Error('event_content_reference_invalid');
  return readBundleEntry(env,{projectId,bundleId:row.bundle_id,entry:row.bundle_entry,kind:'event',resourceId:eventId,
    eventId,envelopeHash:row.envelope_hash,tokenId:row.token_id});
}
