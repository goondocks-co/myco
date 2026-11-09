import type { BlobStore } from '../adapters.js';
import { readStoredObject, readStoredRange } from '../stored-object.js';
import type { VectorPageRow } from '../../db/embeddings/vector-pages.js';

/**
 * Immutable stored pages of calibration member vectors. A page is a run of self-checking frames, each carrying its
 * member's id and the digest of the frame, so one member's vector is read and verified without the rest of its page.
 */
const DIGEST_BYTES = 32;
const VECTOR_PAGE_NAME = /^vector-pages\/([A-Za-z0-9._-]{1,64})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a stored vector could not be used: the store failed, or its bytes are gone, short or damaged. */
type VectorPageFault = 'store' | 'absent' | 'partial' | 'corrupt';

/** A stored page that cannot be read. Named and retryable: a step answers it rather than computing without the vector. */
export class VectorPageUnavailable extends Error {
  constructor(readonly fault: VectorPageFault, readonly page: Pick<VectorPageRow, 'page_id' | 'missing_at'> | null) {
    super(`a stored calibration vector page is unavailable: ${fault}`);
  }
}

interface PageSlot { id: string; offset: number; length: number }
interface EncodedPage { bytes: Uint8Array<ArrayBuffer>; slots: PageSlot[]; sha256: string }

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const digestOf = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
/** Where a Project's next page is stored. Each write takes a name no other write uses, so a late delete can only remove what it released. */
export const vectorPageKey = (projectId: string): string => `vector-pages/${projectId}/${crypto.randomUUID()}`;
/** The Project a name `vectorPageKey` wrote belongs to, or null for any other name. */
export const vectorPageProject = (physical: string): string | null => VECTOR_PAGE_NAME.exec(physical)?.[1] ?? null;

async function frame(id: string, vector: Uint8Array): Promise<Uint8Array> {
  const name = new TextEncoder().encode(id);
  const body = new Uint8Array(new ArrayBuffer(2 + name.byteLength + 4 + vector.byteLength));
  const view = new DataView(body.buffer);
  view.setUint16(0, name.byteLength);
  body.set(name, 2);
  view.setUint32(2 + name.byteLength, vector.byteLength);
  body.set(vector, 6 + name.byteLength);
  const sealed = new Uint8Array(body.byteLength + DIGEST_BYTES);
  sealed.set(body);
  sealed.set(await digestOf(body), body.byteLength);
  return sealed;
}

/** Members' float32 bytes as one page, in the order given. */
export async function encodeVectorPage(members: ReadonlyArray<{ id: string; bytes: Uint8Array }>): Promise<EncodedPage> {
  const frames = await Promise.all(members.map((m) => frame(m.id, m.bytes)));
  const bytes = new Uint8Array(new ArrayBuffer(frames.reduce((sum, f) => sum + f.byteLength, 0)));
  const slots: PageSlot[] = [];
  let offset = 0;
  frames.forEach((f, i) => {
    bytes.set(f, offset);
    slots.push({ id: members[i]!.id, offset, length: f.byteLength });
    offset += f.byteLength;
  });
  return { bytes, slots, sha256: hex(await digestOf(bytes)) };
}

/** The vector in a frame that proves whole and is the named member's, or null. */
async function vectorFrom(view: Uint8Array<ArrayBuffer>, id: string): Promise<Float32Array | null> {
  if (view.byteLength < 6 + DIGEST_BYTES) return null;
  const body = view.subarray(0, view.byteLength - DIGEST_BYTES);
  const digest = await digestOf(body);
  if (digest.some((b, i) => b !== view[body.byteLength + i])) return null;
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const nameBytes = data.getUint16(0);
  if (6 + nameBytes > body.byteLength || new TextDecoder().decode(body.subarray(2, 2 + nameBytes)) !== id) return null;
  const vectorBytes = data.getUint32(2 + nameBytes);
  if (6 + nameBytes + vectorBytes !== body.byteLength || vectorBytes % 4 !== 0) return null;
  return new Float32Array(body.slice(6 + nameBytes).buffer);
}

/**
 * Write a page and prove it: the store checks the digest, the object reads back byte for byte, and the store says the
 * publication survives a crash. Only after this may a row stop holding its bytes.
 */
export async function storeVectorPage(blobs: BlobStore, key: string, page: EncodedPage): Promise<void> {
  let stored;
  try {
    stored = await blobs.put(key, new Response(page.bytes).body, { size: page.bytes.byteLength, sha256: page.sha256 });
  } catch { throw new VectorPageUnavailable('store', null); }
  let held;
  try { held = await readStoredObject(blobs, key, page.bytes.byteLength); } catch { throw new VectorPageUnavailable('store', null); }
  if (held.kind === 'absent') throw new VectorPageUnavailable('absent', null);
  if (held.kind === 'size_mismatch') throw new VectorPageUnavailable('partial', null);
  if (hex(await digestOf(held.bytes)) !== page.sha256) throw new VectorPageUnavailable('corrupt', null);
  let durable: boolean;
  try { durable = stored.durable === true || await blobs.ensureDurable?.(key) === true; } catch { throw new VectorPageUnavailable('store', null); }
  if (!durable) throw new VectorPageUnavailable('store', null);
}

/** A member's place in a sealed page. */
export interface SealedMember { id: string; page_id: number; page_offset: number; page_length: number }

/**
 * The vectors of `members`, read from their pages: one range per page, spanning the members it holds. Every frame is
 * checked against its member; anything missing, short or damaged is a `VectorPageUnavailable`, never a vector.
 */
export async function readSealedVectors(blobs: BlobStore, rows: readonly VectorPageRow[], members: readonly SealedMember[]): Promise<Map<string, Float32Array>> {
  const pages = new Map(rows.map((row) => [row.page_id, row]));
  const grouped = new Map<number, SealedMember[]>();
  for (const member of members) grouped.set(member.page_id, [...(grouped.get(member.page_id) ?? []), member]);
  const out = new Map<string, Float32Array>();
  await Promise.all([...grouped].map(async ([pageId, held]) => {
    const page = pages.get(pageId);
    if (page === undefined) throw new VectorPageUnavailable('absent', null);
    const start = Math.min(...held.map((m) => m.page_offset));
    const length = Math.max(...held.map((m) => m.page_offset + m.page_length)) - start;
    const span = await readSpan(blobs, page, start, length);
    await Promise.all(held.map(async (member) => {
      const at = member.page_offset - start;
      const vector = await vectorFrom(span.subarray(at, at + member.page_length), member.id);
      if (vector === null) throw new VectorPageUnavailable('corrupt', page);
      out.set(member.id, vector);
    }));
  }));
  return out;
}

async function readSpan(blobs: BlobStore, page: VectorPageRow, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  let span;
  try { span = await readStoredRange(blobs, page.object_key, page.size, offset, length); } catch { throw new VectorPageUnavailable('store', page); }
  if (span.kind === 'absent') throw new VectorPageUnavailable('absent', page);
  if (span.kind === 'size_mismatch') throw new VectorPageUnavailable('partial', page);
  return span.bytes;
}
