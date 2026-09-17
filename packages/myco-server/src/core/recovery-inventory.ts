/**
 * The inventory a staged export carries: the objects its own bytes name, and the identity of those bytes.
 *
 * One pass reads the staged export by the parts the download recorded, holds every part to the digest recorded for
 * it, and feeds those verified bytes to both readers it needs: the statement reader that names the objects, and a
 * resumable digest that identifies the export. Bytes substituted after the download — at any length — change a part
 * digest and are refused before they reach either. The digest's state travels beside the part cursor, so an
 * interruption costs the part in hand and never a re-read of the whole export.
 *
 * Column positions come from the captured schema, never from an assumed order, and a row of an inventory table that
 * cannot be read is refused rather than skipped.
 *
 * Every port call carries an explicit deadline and the whole pass carries its own. A continuation stops beginning
 * parts at `stepMs` and finishes the part in hand, an overrun of one part and nothing more. The progress it answers
 * is its caller's to commit; this module computes, and the checkpoint owner makes the work durable.
 */
import { SHA256 } from '@stablelib/sha256';
import { endStatements, feedStatements, newStatementScan, readStatement, type StatementScan } from './sql-statements.js';
import { blobArtifactKey, snapshotBlobObject } from './blob-objects.js';

/** The tables whose rows name an object an artifact must carry. */
export const INVENTORY_TABLES = ['blobs', 'backups'] as const;

/** One object the export names, in the shape a staging manifest lists. */
/** An object a snapshot row names: `key` is where an artifact holds it, `source` where the source store holds its bytes. */
export interface InventoryObject { key: string; source: string; bytes: number; sha256: string | null }

/** How far the inventory has read, and what it has found. Plain data, so a checkpoint carries it. */
export interface InventoryProgress {
  /** Parts verified, decoded and hashed so far; the pass resumes at this part. */
  parts: number;
  bytes: number;
  objects: Record<string, InventoryObject>;
  scan: StatementScan;
  scanBytes: string;
  /** The digest's own state after those parts, saved as plain data in the same commit as the cursor. */
  digest: SavedDigest;
}

/** A resumable digest's state, as plain data a checkpoint can hold. */
export interface SavedDigest { state: number[]; buffer: number[]; bufferLength: number; bytesHashed: number }

const savedOf = (hash: SHA256): SavedDigest => {
  const held = hash.saveState();
  return {
    state: Array.from(held.state as unknown as ArrayLike<number>),
    buffer: Array.from((held.buffer ?? new Uint8Array()) as unknown as ArrayLike<number>),
    bufferLength: held.bufferLength,
    bytesHashed: held.bytesHashed,
  };
};

const restored = (saved: SavedDigest): SHA256 => {
  const hash = new SHA256();
  hash.restoreState({
    state: new Int32Array(saved.state),
    buffer: new Uint8Array(saved.buffer),
    bufferLength: saved.bufferLength,
    bytesHashed: saved.bytesHashed,
  } as unknown as Parameters<SHA256['restoreState']>[0]);
  return hash;
};

export const newInventoryProgress = (): InventoryProgress => ({
  parts: 0, bytes: 0, objects: {}, scan: newStatementScan(), scanBytes: '', digest: savedOf(new SHA256()),
});

/** What the inventory needs of a store and a digest, so the pass is testable without either. */
export interface InventoryPorts {
  /**
   * The staged bytes of one recorded part. The signal is aborted when the pass stops waiting for the call. A port
   * that can cancel its work — a fetch, a stream read — does so; a port whose operation cannot be cancelled must
   * discard the late result and release whatever it holds, and say so where it is documented. The abort bounds when
   * the pass stops waiting, not what the far side continues to do.
   */
  readPart(prefix: string, offset: number, bytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  /** The digest of those bytes, as the platform computes it. */
  digest(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
  now(): number;
}

export interface InventoryLimits {
  /** Parts one continuation may verify and decode. */
  maxPartsPerStep: number;
  /**
   * How long a continuation may spend before it stops beginning parts. The part in hand still finishes, and it
   * costs a read, a digest and the decode between them — each port call bounded by `requestMs` of its own, the
   * decode bounded by the statement reader's own limits. So `requestMs` bounds a call, never a whole part.
   */
  stepMs: number;
  /** How long the whole pass may take, across continuations and restarts. */
  inventoryMs: number;
  /** How long one call to a store or a digest may take before the pass refuses. */
  requestMs: number;
}

export const INVENTORY_LIMITS: InventoryLimits = {
  maxPartsPerStep: 4, stepMs: 20_000, inventoryMs: 600_000, requestMs: 30_000,
};

/**
 * What one checkpoint may hold of a statement it is still reading. The store refuses a row of 3 MiB and accepts one
 * of 2 MiB, so a statement held across a part boundary is bounded well inside that and refused rather than written
 * as a row the store rejects. A row of an inventory table is orders of magnitude smaller than this.
 */
export const CHECKPOINT_STATEMENT_CHARS = 512 * 1024;

/** Why an inventory pass cannot finish. */
export type InventoryRefusal =
  | 'object_changed' | 'export_unparsable' | 'inventory_disagrees' | 'inventory_unreadable' | 'export_stalled'
  | 'inventory_oversize';

export type InventoryStep =
  | { done: false; progress: InventoryProgress }
  | { done: true; progress: InventoryProgress; database: { sha256: string; bytes: number } }
  | { done: false; refusal: InventoryRefusal; facts: Record<string, number | boolean> };

/** One recorded download part: where it sits in the staged export, and the digest the download wrote for it. */
export interface RecordedPart { part: number; bytes: number; sha256: string }

/** What the pass is given: the staging, its recorded parts, and the columns the captured schema declares. */
export interface InventoryInput {
  prefix: string;
  parts: readonly RecordedPart[];
  sqlBytes: number;
  startedAt: number;
  /** Column order per table, read from the captured schema by the canonical definition reader. */
  columns: Readonly<Record<string, readonly string[]>>;
  progress: InventoryProgress;
}

const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Uint8Array => new Uint8Array((hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

/** A call or a pass that outlived its deadline. */
export class Stalled extends Error {}
class Unreadable extends Error {}

/** Whether a rejection is a port reporting that it honoured the signal. */
const abortReason = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

/**
 * Runs one port call under a deadline and answers only a timely result.
 *
 * The deadline's own abort decides the outcome: past it, whatever the call answers — a value, a `null`, an
 * `AbortError`, another failure — refuses as a passed deadline, whichever settled first. A call that outruns its
 * budget without being aborted refuses on the clock read when it settles. A failure of the port's own is that
 * failure.
 */
export async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, now: () => number): Promise<T> {
  if (ms <= 0) throw new Stalled('a recovery call had no budget left');
  const started = now();
  const controller = new AbortController();
  const passed = () => new Stalled('a recovery call passed its deadline');
  // The platform's own deadline signal, so this module schedules nothing of its own.
  const deadline = AbortSignal.timeout(ms);
  let onDeadline: (() => void) | undefined;
  try {
    const value = await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        onDeadline = () => { controller.abort(passed()); reject(passed()); };
        deadline.addEventListener('abort', onDeadline);
      }),
    ]);
    if (controller.signal.aborted) throw passed();
    if (now() - started > ms) throw new Stalled('a recovery call settled past its deadline');
    return value;
  } catch (error) {
    const expired = controller.signal.aborted;
    controller.abort(error);
    if (error instanceof Stalled) throw error;
    throw expired || abortReason(error) ? passed() : error;
  } finally {
    if (onDeadline !== undefined) deadline.removeEventListener('abort', onDeadline);
  }
}

/** Splits bytes at the last complete character, so a character divided between parts is decoded once and whole. */
function splitCharacters(bytes: Uint8Array): { text: string; tail: Uint8Array } {
  let cut = bytes.length;
  for (let back = 1; back <= 4 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back]!;
    if (byte < 0x80) break;
    if (byte >= 0xc0) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      if (needed > back) cut = bytes.length - back;
      break;
    }
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, cut)), tail: bytes.subarray(cut) };
}

/**
 * The object one row of an inventory table names. A statement that is not such a row answers `null`; a row of one of
 * those tables whose values or columns cannot be read raises, so the caller refuses rather than losing an object.
 */
export function inventoryObjectOf(
  statement: string, columns: Readonly<Record<string, readonly string[]>>,
): InventoryObject | null {
  const reading = readStatement(statement, [...INVENTORY_TABLES]);
  // A row of an inventory table this reader cannot read is not a statement to pass over.
  if (reading.kind === 'unreadable') throw new Unreadable(`a row of ${reading.table} cannot be read`);
  if (reading.kind === 'other') return null;
  const { row } = reading;
  if (!(INVENTORY_TABLES as readonly string[]).includes(row.table)) return null;
  const order = row.columns ?? columns[row.table] ?? null;
  if (order === null) throw new Unreadable(`no captured schema names the columns of ${row.table}`);
  if (order.length !== row.values.length) throw new Unreadable(`a row of ${row.table} names ${row.values.length} of ${order.length} columns`);
  const at = (name: string) => {
    const index = order.indexOf(name);
    return index < 0 ? null : row.values[index] ?? null;
  };
  if (row.table === 'blobs') {
    const project = at('project_id');
    const key = at('key');
    const size = at('size');
    const generation = at('generation');
    if (project?.kind !== 'text' || key?.kind !== 'text' || size?.kind !== 'integer') {
      throw new Unreadable('a blobs row does not carry a project, a key and a size');
    }
    if (generation !== null && generation.kind !== 'text' && generation.kind !== 'null') throw new Unreadable('a blobs row carries a generation this reader cannot read');
    let object;
    try {
      object = snapshotBlobObject({ project_id: project.text, key: key.text, generation: generation?.kind === 'text' ? generation.text : null });
    } catch {
      throw new Unreadable('a blobs row names an object outside the stored grammar');
    }
    // A blob is content-addressed: its key is the digest its bytes must hash to.
    return { key: blobArtifactKey(object.projectId, object.key), source: object.objectKey, bytes: size.integer, sha256: object.key };
  }
  const key = at('key');
  const size = at('size_bytes');
  const digest = at('sha256');
  if (key?.kind !== 'text' || size?.kind !== 'integer') throw new Unreadable('a backups row does not carry a key and a size');
  if (digest !== null && digest.kind !== 'text' && digest.kind !== 'null') throw new Unreadable('a backups row carries a digest this reader cannot read');
  return { key: key.text, source: key.text, bytes: size.integer, sha256: digest?.kind === 'text' ? digest.text : null };
}

const ordered = (parts: readonly RecordedPart[]): RecordedPart[] => [...parts].sort((left, right) => left.part - right.part);
const offsetOf = (parts: readonly RecordedPart[], upTo: number): number =>
  parts.slice(0, upTo).reduce((sum, part) => sum + part.bytes, 0);

/**
 * What one call may have: the least of its own limit and what the whole pass has left. The step budget is not part
 * of it — a step spends `stepMs` deciding whether to begin another part, and each call of the part it has begun runs
 * to this budget. So a continuation may overrun `stepMs` by one part's work, and by nothing else.
 */
const budget = (limits: InventoryLimits, now: number, stageStarted: number): number =>
  Math.min(limits.requestMs, limits.inventoryMs - (now - stageStarted));

/** Reads one recorded part and holds it to its recorded digest, inside what the pass budget allows. */
async function verifiedPart(
  input: InventoryInput, ports: InventoryPorts, limits: InventoryLimits, part: RecordedPart, offset: number,
): Promise<Uint8Array | { refusal: InventoryRefusal; facts: Record<string, number | boolean> }> {
  const allowed = () => budget(limits, ports.now(), input.startedAt);
  const bytes = await within((signal) => ports.readPart(input.prefix, offset, part.bytes, signal), allowed(), ports.now);
  if (bytes === null || bytes.byteLength !== part.bytes) {
    return { refusal: 'object_changed', facts: { part: part.part, read: bytes?.byteLength ?? -1 } };
  }
  if (await within((signal) => ports.digest(bytes, signal), allowed(), ports.now) !== part.sha256) {
    return { refusal: 'object_changed', facts: { part: part.part, digest: false } };
  }
  return bytes;
}

/**
 * Advances the inventory by up to `maxPartsPerStep` recorded parts, then identifies the export by accumulating a
 * digest over those same verified parts. Every step is bounded, and a pass that outlives its budget refuses.
 */
export async function continueInventory(
  input: InventoryInput, ports: InventoryPorts, limits: InventoryLimits = INVENTORY_LIMITS,
): Promise<InventoryStep> {
  const started = ports.now();
  const stalled = (at: number): boolean => at - input.startedAt > limits.inventoryMs;
  if (stalled(started)) {
    return { done: false, refusal: 'export_stalled', facts: { elapsedMs: started - input.startedAt, parts: input.progress.parts } };
  }
  const progress: InventoryProgress = {
    parts: input.progress.parts,
    bytes: input.progress.bytes,
    objects: { ...input.progress.objects },
    scan: { ...input.progress.scan },
    scanBytes: input.progress.scanBytes,
    digest: input.progress.digest,
  };
  const parts = ordered(input.parts);
  if (parts.reduce((sum, part) => sum + part.bytes, 0) !== input.sqlBytes) {
    return { done: false, refusal: 'inventory_disagrees', facts: { parts: parts.length, expected: input.sqlBytes } };
  }
  let offset = offsetOf(parts, progress.parts);
  if (progress.digest.bytesHashed !== offset) {
    // The digest's own count and the cursor are written together; a disagreement is a checkpoint nothing may trust.
    return { done: false, refusal: 'inventory_disagrees', facts: { bytesHashed: progress.digest.bytesHashed, offset } };
  }

  try {
    const hash = restored(progress.digest);
    for (let step = 0; step < limits.maxPartsPerStep && progress.parts < parts.length; step += 1) {
      const now = ports.now();
      if (stalled(now)) {
        return { done: false, refusal: 'export_stalled', facts: { elapsedMs: now - input.startedAt, parts: progress.parts } };
      }
      // The step's own time decides whether to begin another part; the progress it returns is for its caller to
      // commit, and only that commit makes the work durable.
      if (now - started >= limits.stepMs) return { done: false, progress };
      const part = parts[progress.parts]!;
      const read = await verifiedPart(input, ports, limits, part, offset);
      if (!(read instanceof Uint8Array)) return { done: false, ...read };
      const held = fromHex(progress.scanBytes);
      const whole = new Uint8Array(held.byteLength + read.byteLength);
      whole.set(held);
      whole.set(read, held.byteLength);
      const { text, tail } = splitCharacters(whole);
      const take = (statement: string): void => {
        const object = inventoryObjectOf(statement, input.columns);
        if (object !== null) progress.objects[object.key] = object;
      };
      const retention = { rows: [...INVENTORY_TABLES] };
      const last = progress.parts + 1 === parts.length;
      try {
        feedStatements(progress.scan, text, retention, take);
        if (last) endStatements(progress.scan, retention, take);
      } catch (error) {
        if (error instanceof Unreadable) throw error;
        return { done: false, refusal: 'export_unparsable', facts: { part: part.part, offset } };
      }
      // A statement carried to the next continuation travels in the checkpoint, so it is held to what a row takes.
      const carried = progress.scan.statement.length + progress.scan.pending.length;
      if (carried > CHECKPOINT_STATEMENT_CHARS) {
        return { done: false, refusal: 'inventory_oversize', facts: { part: part.part, characters: carried } };
      }
      // The same verified bytes identify the export, and the digest's state is committed with the cursor.
      hash.update(read);
      progress.scanBytes = hexOf(tail);
      progress.parts += 1;
      progress.bytes += part.bytes;
      progress.digest = savedOf(hash);
      offset += part.bytes;
    }

    if (progress.parts < parts.length) return { done: false, progress };
    if (progress.digest.bytesHashed !== input.sqlBytes) {
      return { done: false, refusal: 'inventory_disagrees', facts: { bytesHashed: progress.digest.bytesHashed, expected: input.sqlBytes } };
    }
    const sha256 = hexOf(restored(progress.digest).digest());
    if (ports.now() - input.startedAt > limits.inventoryMs) {
      return { done: false, refusal: 'export_stalled', facts: { elapsedMs: ports.now() - input.startedAt, parts: progress.parts } };
    }
    return { done: true, progress, database: { sha256, bytes: progress.digest.bytesHashed } };
  } catch (error) {
    if (error instanceof Stalled) {
      return { done: false, refusal: 'export_stalled', facts: { elapsedMs: ports.now() - input.startedAt, parts: progress.parts } };
    }
    if (error instanceof Unreadable) {
      return { done: false, refusal: 'inventory_unreadable', facts: { parts: progress.parts } };
    }
    throw error;
  }
}
