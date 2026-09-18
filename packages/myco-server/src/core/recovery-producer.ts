/**
 * The hosted recovery producer's stage machine: it drives one admitted attempt from an export the provider runs, to a
 * downloaded SQL export beside its captured schema, through the inventory that export's own bytes name, the copy of
 * every object that inventory registers, and a staging manifest completed only once all of it is verified.
 *
 * An attempt resting at `downloaded` is a settled export-only attempt. It is never advanced and its open manifest is
 * never rewritten; only an attempt admitted through the inventory path reaches `complete`.
 *
 * Every durable fact lives in the checkpoint the caller supplies, which on the hosted target is the platform's own
 * object storage: the source is unavailable to queries while it exports, so no progress may depend on reading it. The
 * ports are the only way out to a provider or a store, which is what makes the machine testable without one. A port
 * answers classified facts and never text, so no provider message, URL or exception can reach a status or a log.
 */
import { emit } from '../telemetry.js';
import type { ErrorClass } from './adapters.js';
import {
  STAGING_FORMAT, STAGING_MANIFEST_FILE, STAGING_SCHEMA_FILE, STAGING_SQL_FILE, stagingPath, type RecoveryStagingManifest,
} from './recovery-staging.js';
import {
  continueInventory, newInventoryProgress, Stalled, within, type InventoryObject, type InventoryProgress,
  type InventoryRefusal, type SavedDigest,
} from './recovery-inventory.js';
import {
  endStatements, feedStatements, newStatementScan, tableColumns, tableDefinition, type StatementScan,
} from './sql-statements.js';

/**
 * How an attempt ends, or that it continues. `downloaded` is where a settled export-only attempt rests; the stages
 * an attempt advances through are named by `ADVANCING_STAGES`. `unconfirmed` is an attempt that sent its complete
 * manifest and could not confirm the publication inside its window: a write of it may still land, so the attempt
 * claims neither a published staging nor a failed one.
 */
export type AttemptStage =
  | 'export' | 'download' | 'inventory' | 'copy' | 'downloaded' | 'complete' | 'unconfirmed' | 'failed';

/**
 * The stages a continuation may advance. One list, so the checkpoint's own query, the admission refusal and the
 * dispatch cannot drift apart, and an attempt at `downloaded` or `complete` is picked up by none of them.
 */
export const ADVANCING_STAGES = ['export', 'download', 'inventory', 'copy'] as const;

/** The advancing stages as a SQL list, for a store that keeps attempts in its own table. */
export const ADVANCING_STAGES_SQL = ADVANCING_STAGES.map((stage) => `'${stage}'`).join(', ');

/** The table definitions a schema names, by table, in the comparable form the splitter answers. */
export type TableDefinitions = Record<string, string>;

/** How far the export text has been read: the split in hand, and the bytes of a character it ends mid-way through. */
export interface ScanProgress {
  defined: TableDefinitions;
  scan: StatementScan;
  scanBytes: string;
}

/** One attempt's durable state. */
export interface AttemptState {
  id: number;
  stage: AttemptStage;
  /** The prefix every file of this attempt is written under. */
  prefix: string;
  startedAt: number;
  error: ProducerRefusal | null;
  /** Transient failures spent so far; a fatal failure or the bound ends the attempt. */
  attempts: number;
  bookmark: string | null;
  polls: number;
  /** When this attempt first asked the provider for an export. A restart keeps it: the budget is attempt-wide. */
  exportStartedAt: number | null;
  exportCompletedAt: number | null;
  reExports: number;
  sqlBytes: number | null;
  sqlEtag: string | null;
  uploadId: string | null;
  downloadOffset: number;
  reconcileOffset: number;
  reconciled: number;
  /** The ordinary tables the capture named, which are the tables the export is asked for. */
  tables: string[];
  /** The definitions the capture held before any export ran, which the exported bytes are held to. */
  captured: TableDefinitions;
  defined: TableDefinitions;
  scan: StatementScan;
  scanBytes: string;
  /** When the inventory pass first ran for this attempt. A restart keeps it: the budget is attempt-wide. */
  inventoryStartedAt: number | null;
  /** How far the inventory has read the staged export, and the identity it has accumulated over those parts. */
  inventoryParts: number;
  inventoryBytes: number;
  inventoryScan: StatementScan;
  inventoryScanBytes: string;
  inventoryDigest: SavedDigest | null;
  /** The staged export's own fingerprint, from the pass that verified every recorded part of it. */
  databaseSha256: string | null;
  databaseBytes: number | null;
  copyStartedAt: number | null;
  /**
   * When this attempt's staging is complete, recorded before the manifest naming it is written. A rewrite after an
   * interruption reuses it, so the manifest an attempt publishes is the same manifest every time.
   */
  completedAt: number | null;
  /**
   * What admission published for this attempt, recorded by the checkpoint owner with the attempt itself. A completed
   * manifest takes its admission fields from here and only from here, never from a staging it is checking. An attempt
   * admitted without one settles at `downloaded`, as the producer that admitted it did.
   */
  admission: AdmittedManifest | null;
}

export interface AttemptPart { part: number; bytes: number; sha256: string; etag: string }

/** One object the staged export's own rows name, and what a staged copy of it records. */
export interface AttemptObject {
  /** The key an artifact stores the object under, which is the key the source rows name. */
  key: string;
  /** The key the source store holds the object's bytes under, as the source rows name it (`core/blob-objects.ts`). */
  source: string;
  bytes: number;
  /** The digest the source rows record, or null where a row records none. */
  sha256: string | null;
  /** The digest the staged copy's own bytes hashed to, once it is staged. */
  stagedSha256: string | null;
  stagedBytes: number | null;
}

/** The durable store an attempt advances in; the hosted target backs this with its own checkpoint SQL. */
export interface AttemptCheckpoint {
  open(): AttemptState | null;
  update(id: number, fields: Partial<AttemptState>): void;
  parts(id: number): AttemptPart[];
  /** Records one staged part with the cursor and the reading of its bytes, as one durable step. */
  recordPart(id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress): void;
  clearParts(id: number): void;
  /**
   * Records the inventory's own progress together with the objects that step found, as one durable step. The objects
   * are held one to a row: a whole inventory in one value would outgrow what the store takes for a row.
   */
  recordInventory(id: number, progress: InventoryProgress, objects: readonly InventoryObject[]): void;
  /** Objects the inventory registered whose copy is not staged yet, in the order they were registered. */
  pendingObjects(id: number, limit: number): AttemptObject[];
  /** Records one staged object copy, by the digest and size its own staged bytes answered. */
  recordCopied(id: number, key: string, staged: { sha256: string; bytes: number }): void;
  /** Every object the inventory registered, staged or not. */
  objects(id: number): AttemptObject[];
  objectCounts(id: number): { registered: number; staged: number };
  /** The signed download URL never leaves the checkpoint: it is not returned, reported or staged. */
  signedUrl(id: number): Promise<string | null>;
  setSignedUrl(id: number, url: string | null): Promise<void>;
}

/**
 * Why a port could not answer, as facts alone: a request or an answer that did not arrive whole, a refused status, a
 * failure the provider itself reported, an answer whose shape cannot be used, or a staging store that could not take
 * a write. A port hands over no message of any kind.
 */
export interface PortFailure {
  cause: 'transport' | 'http' | 'provider' | 'protocol' | 'storage';
  /** The status a refusal carried, where one exists. */
  status: number | null;
  transient: boolean;
}

export type ExportAnswer =
  | { status: 'running'; bookmark: string }
  | { status: 'complete'; bookmark: string; signedUrl: string }
  | { status: 'error'; bookmark: string | null; failure: PortFailure };

/** One ranged read of the signed export, or what stands in the way of reading it. */
export type RangeAnswer =
  | { status: 'part'; bytes: Uint8Array | ReadableStream<Uint8Array>; length: number; total: number; etag: string | null }
  | { status: 'gone' }
  | { status: 'unranged' }
  | { status: 'error'; failure: PortFailure };

/** One staged object copy, or what stands in the way of it. */
export type CopyAnswer =
  | { status: 'copied'; sha256: string; bytes: number }
  | { status: 'missing' }
  | { status: 'error'; failure: PortFailure };

export interface ProducerPorts {
  /** POST the export, or poll the one `bookmark` names. Reaches the provider's fixed API origin and nowhere else. */
  pollExport(bookmark: string | null): Promise<ExportAnswer>;
  /** Read `length` bytes of the signed export at `offset`. The signed URL carries no credential. */
  readRange(url: string, offset: number, length: number): Promise<RangeAnswer>;
  /** Write one part of the staged export, answering its digest and provider etag. */
  writePart(prefix: string, uploadId: string, part: number, body: Uint8Array | ReadableStream<Uint8Array>, length: number): Promise<{ sha256: string; etag: string }>;
  beginUpload(prefix: string): Promise<string>;
  completeUpload(prefix: string, uploadId: string, parts: AttemptPart[]): Promise<{ bytes: number } | null>;
  abortUpload(prefix: string, uploadId: string): Promise<void>;
  /** Read back a stored range of the staged export, for reconciling an interrupted completion. */
  readStoredRange(prefix: string, offset: number, length: number): Promise<{ sha256: string } | null>;
  storedSize(prefix: string): Promise<number | null>;
  /**
   * Read one recorded part of the staged export, for the inventory that reads the objects its rows name. The signal
   * is aborted when the stage stops waiting; a store whose read cannot be cancelled discards the late result.
   */
  readStagedPart(prefix: string, offset: number, bytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  /** The digest of bytes in hand, as the platform computes it. */
  digest(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
  /**
   * Copy one registered object from its `source` key into this attempt's staging under its `key`, answering the digest and size the staged bytes hashed
   * to. A copy repeated after a reset writes the same key again rather than assuming the first one landed. Where
   * `expected.sha256` is null the port measures a digest over the bytes it streams, so every staged object carries
   * one; that digest binds the copy, not the write the source row never recorded. The port streams: it holds no
   * whole object, and refuses a source whose size is not the size the row records before any byte is written. When
   * the signal aborts, the port stops streaming and releases what it holds; a store write that cannot be cancelled
   * may still land, and a later copy of the same key replaces it.
   */
  copyObject(prefix: string, object: { key: string; source: string }, expected: { bytes: number; sha256: string | null }, signal: AbortSignal): Promise<CopyAnswer>;
  /** Write the staging manifest and the captured schema. */
  writeStagingFile(prefix: string, name: string, body: string, signal?: AbortSignal): Promise<void>;
  /** Read back a staging file this attempt published, or null where the staging holds none. */
  readStagingFile(prefix: string, name: string, signal?: AbortSignal): Promise<string | null>;
  now(): number;
}

export interface ProducerLimits {
  /** Bytes per downloaded part. */
  partBytes: number;
  /** How long one admitted attempt may hold an export open in total, across continuations and restarts. */
  exportPollMs: number;
  /** How long one call to the provider may take. The total an attempt may spend is `exportPollMs + requestMs`. */
  requestMs: number;
  /** How many times one continuation may poll before it returns for another. */
  maxPollsPerStep: number;
  /** How long one continuation may spend in total. */
  stepMs: number;
  /** Transient failures one attempt may spend before it fails. */
  maxTransient: number;
  /** How many times one attempt may ask the provider for a fresh export before it fails. */
  maxReExports: number;
  /** Recorded parts the inventory may verify and read in one continuation. */
  maxPartsPerStep: number;
  /** Objects the copy may stage in one continuation. */
  maxObjectsPerStep: number;
  /** How long one attempt may spend reading its inventory, across continuations and restarts. */
  inventoryMs: number;
  /** How long one attempt may spend copying its objects, across continuations and restarts. */
  copyMs: number;
  /** How long one object's copy may take; an object that takes longer is spent as a transient failure. */
  objectMs: number;
  /**
   * How long after its completion time is recorded a staging may take to be confirmed published. Inside this window
   * an unconfirmed publication is retried; past it, the attempt rests `unconfirmed` and holds back no new attempt.
   */
  publishMs: number;
}

/**
 * How long an advancing attempt may go without committing any checkpoint before it is failed as `producer_stalled`.
 *
 * Distinct from the stage deadlines (`exportPollMs`, `inventoryMs`, `copyMs`, `publishMs`), which a continuation
 * checks against a stage's own start while it runs. This fence covers the attempt no continuation advances at all:
 * every continuation commits a checkpoint at least once per step, well inside it, so only an attempt whose steps no
 * longer complete reaches it. It is checked when a hold is settled and when a continuation begins.
 */
export const PRODUCER_STALL_MS = 30 * 60_000;

/** How long each clean-up step of a failed attempt may take: aborting its upload, clearing its signed download. */
export const FAILURE_CLEANUP_MS = 30_000;

export const PRODUCER_LIMITS: ProducerLimits = {
  partBytes: 32 * 1024 * 1024, exportPollMs: 600_000, requestMs: 30_000, maxPollsPerStep: 12, stepMs: 20_000,
  maxTransient: 5, maxReExports: 3, maxPartsPerStep: 4, maxObjectsPerStep: 32, inventoryMs: 600_000, copyMs: 1_800_000,
  objectMs: 300_000, publishMs: 1_800_000,
};

/** What a continuation did, and when the attempt next needs one. `null` means nothing is open. */
export interface ContinuationReport {
  attempt: number | null;
  stage: AttemptStage | 'idle';
  progressed: boolean;
  /** Milliseconds until this attempt needs another continuation, or null when it needs none. */
  nextInMs: number | null;
  /** True only while the source is exporting, so a caller can hold back work that reads it. */
  sourcePaused: boolean;
  error?: ProducerRefusal;
}

const IDLE: ContinuationReport = { attempt: null, stage: 'idle', progressed: false, nextInMs: null, sourcePaused: false };

/** A failure the producer may spend a transient attempt on, rather than ending the attempt. */
export class TransientProducerFailure extends Error {
  constructor(readonly failure: PortFailure) { super('a recovery port answered a transient failure'); }
}

/**
 * Why an attempt ended, from a closed set. What an owner reads and what a log carries name a member of this set and
 * nothing else, which keeps provider text, a signed URL and an exception message out of both.
 */
export type ProducerRefusal =
  | 'provider_unavailable' | 'provider_refused' | 'export_failed' | 'export_not_offered' | 'export_unparsable'
  | 'export_stalled'
  /** A native producer's own child refused the artifact, or its caller withdrew it. */
  | 'artifact_refused' | 'artifact_cancelled'
  | 'download_unranged' | 'download_changed' | 'download_lost' | 'staging_unreconciled'
  | 'staging_changed' | 'inventory_disagrees' | 'inventory_unreadable' | 'inventory_oversize'
  | 'object_missing' | 'object_changed' | 'copy_stalled' | 'staging_incomplete'
  | 'schema_disagrees' | 'producer_stalled' | 'internal';

/** What the inventory pass's own refusals mean in the producer's closed set. */
const INVENTORY_REFUSAL: Record<InventoryRefusal, ProducerRefusal> = {
  object_changed: 'staging_changed', export_unparsable: 'export_unparsable', export_stalled: 'export_stalled',
  inventory_disagrees: 'inventory_disagrees', inventory_unreadable: 'inventory_unreadable',
  inventory_oversize: 'inventory_oversize',
};

const COPY_REFUSAL: Record<PortFailure['cause'], ProducerRefusal> = {
  transport: 'provider_unavailable', http: 'object_changed', provider: 'object_changed',
  protocol: 'object_changed', storage: 'provider_unavailable',
};

const EXPORT_REFUSAL: Record<PortFailure['cause'], ProducerRefusal> = {
  transport: 'provider_unavailable', http: 'provider_refused', provider: 'export_failed',
  protocol: 'export_not_offered', storage: 'provider_unavailable',
};

const DOWNLOAD_REFUSAL: Record<PortFailure['cause'], ProducerRefusal> = {
  transport: 'provider_unavailable', http: 'download_changed', provider: 'download_changed',
  protocol: 'download_changed', storage: 'provider_unavailable',
};

/** The exception shapes a log may name, so an unexpected throw is classified rather than quoted. */
const THROWN = ['Error', 'TypeError', 'RangeError', 'SyntaxError'] as const;
type ThrownShape = (typeof THROWN)[number] | 'other';

const thrownShape = (error: unknown): ThrownShape => {
  const named = error instanceof Error ? error.name : '';
  return (THROWN as readonly string[]).includes(named) ? named as ThrownShape : 'other';
};

/** Records what a log may carry: the refusal, and counts. No value here can hold text a provider chose. */
function refuse(
  attempt: AttemptState, refusal: ProducerRefusal, facts: Record<string, number | boolean> = {}, shape?: ThrownShape,
): ProducerRefusal {
  emit({ kind: 'recovery_attempt_failed', attempt: attempt.id, stage: attempt.stage, refusal, ...facts, ...(shape === undefined ? {} : { thrown: shape }) });
  return refusal;
}

/**
 * Advances the one open attempt by one continuation. It never opens an attempt: admission is a separate decision
 * that reads the Deployment, and this runs while the Deployment may be unreadable.
 */
export async function continueAttempt(
  checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits = PRODUCER_LIMITS,
): Promise<ContinuationReport> {
  const open = checkpoint.open();
  if (open === null) return IDLE;
  const started = ports.now();
  try {
    if (open.stage === 'export') return await pollExportStage(open, checkpoint, ports, limits, started);
    if (open.stage === 'download') return await downloadStage(open, checkpoint, ports, limits, started);
    if (open.stage === 'inventory') return await inventoryStage(open, checkpoint, ports, limits, started);
    if (open.stage === 'copy') return await copyStage(open, checkpoint, ports, limits, started);
    return { ...IDLE, attempt: open.id, stage: open.stage };
  } catch (error) {
    if (error instanceof TransientProducerFailure && open.attempts + 1 < limits.maxTransient) {
      const { cause, status } = error.failure;
      emit({ kind: 'recovery_attempt_transient', attempt: open.id, stage: open.stage, spent: open.attempts + 1, cause, status });
      checkpoint.update(open.id, { attempts: open.attempts + 1, error: 'provider_unavailable' });
      return { attempt: open.id, stage: open.stage, progressed: false, nextInMs: 1_000, sourcePaused: open.stage === 'export', error: 'provider_unavailable' };
    }
    if (error instanceof TransientProducerFailure) {
      return failAttempt(open, checkpoint, ports, 'provider_unavailable', { spent: open.attempts, status: error.failure.status ?? 0 });
    }
    // An interrupted step spends one bounded attempt and keeps its stage; exhaustion is terminal.
    if (open.attempts + 1 < limits.maxTransient) {
      emit({ kind: 'recovery_attempt_interrupted', attempt: open.id, stage: open.stage, spent: open.attempts + 1, thrown: thrownShape(error) });
      checkpoint.update(open.id, { attempts: open.attempts + 1 });
      return { attempt: open.id, stage: open.stage, progressed: false, nextInMs: 1_000, sourcePaused: open.stage === 'export' };
    }
    return failAttempt(open, checkpoint, ports, 'internal', { spent: open.attempts + 1 }, thrownShape(error));
  }
}

/** Fails an attempt: the terminal state is durable first, then its upload is aborted and its signed download cleared, and the refusal is announced. */
export async function failAttempt(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, refusal: ProducerRefusal,
  facts: Record<string, number | boolean> = {}, shape?: ThrownShape, cleanupMs = FAILURE_CLEANUP_MS,
): Promise<ContinuationReport> {
  const upload = attempt.uploadId;
  // The terminal state is durable before it is announced, and the clearing up that follows cannot change it.
  checkpoint.update(attempt.id, { stage: 'failed', error: refusal, uploadId: null });
  // Each clean-up step has its own deadline, so one that never settles cannot hold back the next or the announcement.
  const reached = (work: () => Promise<void>): Promise<boolean> => within(work, cleanupMs, ports.now).then(() => true, () => false);
  const aborted = upload === null ? true : await reached(() => ports.abortUpload(attempt.prefix, upload));
  const cleared = await reached(() => checkpoint.setSignedUrl(attempt.id, null));
  refuse(attempt, refusal, { ...facts, uploadAborted: aborted, signedUrlCleared: cleared }, shape);
  return { attempt: attempt.id, stage: 'failed', progressed: true, nextInMs: null, sourcePaused: false, error: refusal };
}

/**
 * Starts this attempt's export again inside its bound: the parts and the signed download go, the cursor returns to
 * the beginning, and the attempt's export origin stands.
 */
async function restartExport(
  state: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits,
  exhausted: ProducerRefusal,
): Promise<ContinuationReport> {
  if (state.reExports + 1 > limits.maxReExports) {
    return failAttempt(state, checkpoint, ports, exhausted, { reExports: state.reExports + 1 });
  }
  if (state.uploadId !== null) await ports.abortUpload(state.prefix, state.uploadId).catch(() => undefined);
  checkpoint.clearParts(state.id);
  await checkpoint.setSignedUrl(state.id, null);
  checkpoint.update(state.id, {
    stage: 'export', bookmark: null, exportCompletedAt: null,
    sqlBytes: null, sqlEtag: null, uploadId: null, downloadOffset: 0, reconcileOffset: 0, reExports: state.reExports + 1,
    ...freshScan(),
  });
  return { attempt: state.id, stage: 'export', progressed: true, nextInMs: 0, sourcePaused: false };
}

/** Polls the export back to back inside one continuation; the source is unreadable for as long as this runs. */
async function pollExportStage(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<ContinuationReport> {
  let bookmark = attempt.bookmark;
  const before = attempt.polls;
  let polls = before;
  // The attempt's export origin, held in the checkpoint: one budget covers every continuation and restart.
  const exportStartedAt = attempt.exportStartedAt ?? started;
  if (attempt.exportStartedAt === null) checkpoint.update(attempt.id, { exportStartedAt: started });
  const stalled = (at: number): boolean => at - exportStartedAt > limits.exportPollMs;
  for (let step = 0; step < limits.maxPollsPerStep && ports.now() - started < limits.stepMs; step += 1) {
    if (stalled(ports.now())) {
      checkpoint.update(attempt.id, { polls });
      return failAttempt(attempt, checkpoint, ports, 'export_stalled', { elapsedMs: ports.now() - exportStartedAt, polls });
    }
    const answer = await ports.pollExport(bookmark);
    polls += 1;
    if (answer.status === 'error') {
      if (answer.failure.transient) throw new TransientProducerFailure(answer.failure);
      checkpoint.update(attempt.id, { polls });
      // A refused bookmark this attempt holds starts the export again inside its bound; a refused fresh request
      // ends the attempt.
      if (answer.failure.cause === 'provider' && bookmark !== null) {
        return restartExport({ ...attempt, bookmark, polls }, checkpoint, ports, limits, 'export_failed');
      }
      return failAttempt(attempt, checkpoint, ports, EXPORT_REFUSAL[answer.failure.cause], { status: answer.failure.status ?? 0, polls });
    }
    bookmark = answer.bookmark;
    checkpoint.update(attempt.id, { bookmark, polls });
    // An export still running past the budget ends the attempt; a completion a poll inside the budget answered
    // stands.
    if (answer.status === 'running' && stalled(ports.now())) {
      return failAttempt({ ...attempt, bookmark }, checkpoint, ports, 'export_stalled', { elapsedMs: ports.now() - exportStartedAt, polls });
    }
    if (answer.status === 'complete') {
      await checkpoint.setSignedUrl(attempt.id, answer.signedUrl);
      checkpoint.update(attempt.id, { stage: 'download', exportCompletedAt: ports.now() });
      return { attempt: attempt.id, stage: 'download', progressed: true, nextInMs: 0, sourcePaused: false };
    }
  }
  // The export still runs, so the next continuation must arrive at once: an unpolled export cancels itself.
  return { attempt: attempt.id, stage: 'export', progressed: polls > before, nextInMs: 0, sourcePaused: true };
}

/** Ranged reads of the signed export into staged parts, each recorded with its digest before the next begins. */
async function downloadStage(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<ContinuationReport> {
  let state = attempt;
  let progressed = false;
  const restart = (): Promise<ContinuationReport> => restartExport(state, checkpoint, ports, limits, 'download_lost');

  while (state.sqlBytes === null || state.downloadOffset < state.sqlBytes) {
    if (ports.now() - started > limits.stepMs) {
      return { attempt: state.id, stage: 'download', progressed, nextInMs: 0, sourcePaused: false };
    }
    const url = await checkpoint.signedUrl(state.id);
    if (url === null) return restart();
    const length = state.sqlBytes === null ? limits.partBytes : Math.min(limits.partBytes, state.sqlBytes - state.downloadOffset);
    const answer = await ports.readRange(url, state.downloadOffset, length);
    if (answer.status === 'gone') return restart();
    if (answer.status === 'unranged') return failAttempt(state, checkpoint, ports, 'download_unranged');
    if (answer.status === 'error') {
      if (answer.failure.transient) throw new TransientProducerFailure(answer.failure);
      return failAttempt(state, checkpoint, ports, DOWNLOAD_REFUSAL[answer.failure.cause], { status: answer.failure.status ?? 0 });
    }
    if (state.sqlBytes === null) {
      checkpoint.update(state.id, { sqlBytes: answer.total, sqlEtag: answer.etag });
      state = { ...state, sqlBytes: answer.total, sqlEtag: answer.etag };
    } else if (answer.total !== state.sqlBytes || (state.sqlEtag !== null && answer.etag !== null && answer.etag !== state.sqlEtag)) {
      return failAttempt(state, checkpoint, ports, 'download_changed', { total: answer.total, expected: state.sqlBytes });
    }
    let uploadId = state.uploadId;
    if (uploadId === null) {
      uploadId = await ports.beginUpload(state.prefix);
      checkpoint.update(state.id, { uploadId });
      state = { ...state, uploadId };
    }
    const number = checkpoint.parts(state.id).length + 1;
    const written = await ports.writePart(state.prefix, uploadId, number, answer.bytes, answer.length);
    const offset = state.downloadOffset + answer.length;
    const last = offset >= (state.sqlBytes ?? offset);
    let progress: ScanProgress;
    try {
      progress = readDefinitions(state, answer.bytes, last);
    } catch {
      return failAttempt(state, checkpoint, ports, 'export_unparsable', { offset });
    }
    // The cursor and the reading of the bytes it covers commit together, so a resumed attempt reads every byte once.
    checkpoint.recordPart(state.id, { part: number, bytes: answer.length, ...written }, offset, progress);
    state = { ...state, downloadOffset: offset, ...progress };
    progressed = true;
  }

  // The capture and the exported bytes must define the same tables the same way: a capture that no longer describes
  // the export is not a snapshot of anything. `sqlite_sequence` carries rows without a definition of its own.
  const disagreement = definitionsDisagree(state.captured, state.defined);
  if (disagreement !== null) return failAttempt(state, checkpoint, ports, 'schema_disagrees', disagreement);
  const parts = checkpoint.parts(state.id);
  const completed = state.uploadId === null ? null : await ports.completeUpload(state.prefix, state.uploadId, parts);
  if (completed === null) {
    // An interrupted completion leaves the upload gone and the object present: only the recorded part digests decide.
    const reconciled = await reconcileStored(state, checkpoint, ports, limits, started);
    if (reconciled.pending) return { attempt: state.id, stage: 'download', progressed: true, nextInMs: 0, sourcePaused: false };
    if (!reconciled.ok) return failAttempt(state, checkpoint, ports, 'staging_unreconciled', reconciled.facts ?? {});
    checkpoint.update(state.id, { reconciled: 1 });
  } else if (completed.bytes !== state.sqlBytes) {
    return failAttempt(state, checkpoint, ports, 'staging_unreconciled', { staged: completed.bytes, expected: state.sqlBytes ?? 0 });
  }
  await checkpoint.setSignedUrl(state.id, null);
  // The staged export is whole and verified. An attempt whose admission is recorded reads the inventory its rows name
  // next; one admitted without that record rests where the producer that admitted it left such an attempt.
  if ((state.admission ?? null) === null) {
    checkpoint.update(state.id, { stage: 'downloaded', uploadId: null, error: null });
    return { attempt: state.id, stage: 'downloaded', progressed: true, nextInMs: null, sourcePaused: false };
  }
  checkpoint.update(state.id, { stage: 'inventory', uploadId: null, error: null });
  return { attempt: state.id, stage: 'inventory', progressed: true, nextInMs: 0, sourcePaused: false };
}

/**
 * Reads the staged export by its recorded parts: every part held to the digest the download wrote for it, its rows
 * read for the objects they name, and one resumable digest accumulated over those same verified bytes. The objects
 * are committed one to a row as they are found, so no checkpoint value grows with the export.
 */
async function inventoryStage(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<ContinuationReport> {
  let state = attempt;
  if (state.inventoryStartedAt === null) {
    checkpoint.update(state.id, { inventoryStartedAt: started });
    state = { ...state, inventoryStartedAt: started };
  }
  if (state.sqlBytes === null) return failAttempt(state, checkpoint, ports, 'inventory_disagrees', { sqlBytes: -1 });
  if ((state.admission ?? null) === null) return failAttempt(state, checkpoint, ports, 'staging_incomplete', { admitted: false });
  const columns = tableColumnsOf(state.captured);
  const progress: InventoryProgress = {
    parts: state.inventoryParts,
    bytes: state.inventoryBytes,
    // Objects already found are rows of their own, so a continuation carries none of them in hand.
    objects: {},
    scan: state.inventoryScan,
    scanBytes: state.inventoryScanBytes,
    digest: state.inventoryDigest ?? newInventoryProgress().digest,
  };
  const step = await continueInventory(
    {
      prefix: state.prefix,
      parts: checkpoint.parts(state.id).map((part) => ({ part: part.part, bytes: part.bytes, sha256: part.sha256 })),
      sqlBytes: state.sqlBytes,
      startedAt: state.inventoryStartedAt ?? started,
      columns,
      progress,
    },
    {
      readPart: (prefix, offset, bytes, signal) => ports.readStagedPart(prefix, offset, bytes, signal),
      digest: (bytes, signal) => ports.digest(bytes, signal),
      now: ports.now,
    },
    {
      maxPartsPerStep: limits.maxPartsPerStep, stepMs: limits.stepMs, inventoryMs: limits.inventoryMs,
      requestMs: limits.requestMs,
    },
  );
  if ('refusal' in step) return failAttempt(state, checkpoint, ports, INVENTORY_REFUSAL[step.refusal], step.facts);
  const found = Object.values(step.progress.objects);
  checkpoint.recordInventory(state.id, step.progress, found);
  if (!step.done) {
    return { attempt: state.id, stage: 'inventory', progressed: true, nextInMs: 0, sourcePaused: false };
  }
  checkpoint.update(state.id, {
    stage: 'copy', databaseSha256: step.database.sha256, databaseBytes: step.database.bytes, error: null,
  });
  emit({
    kind: 'recovery_inventory_read', attempt: state.id, bytes: step.database.bytes,
    objects: checkpoint.objectCounts(state.id).registered,
  });
  return { attempt: state.id, stage: 'copy', progressed: true, nextInMs: 0, sourcePaused: false };
}

/**
 * Copies every object the inventory registered into this attempt's staging, one bounded batch per continuation, and
 * completes the staging once every one of them is staged and verified. A copy repeated after a reset writes the same
 * key again: the staging store holds the object, so a repeated write costs bytes and changes nothing.
 *
 * Each copy runs under the reviewed deadline owner, bounded by `objectMs` and by what `copyMs` has left. A copy that
 * settles past its deadline is never recorded: inside the stage budget it is spent as a transient failure, and past
 * it the attempt ends before anything is published.
 */
async function copyStage(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<ContinuationReport> {
  let state = attempt;
  if (state.copyStartedAt === null) {
    checkpoint.update(state.id, { copyStartedAt: started });
    state = { ...state, copyStartedAt: started };
  }
  const copyStartedAt = state.copyStartedAt ?? started;
  const left = (at: number): number => limits.copyMs - (at - copyStartedAt);
  const stalled = (at: number): Promise<ContinuationReport> =>
    failAttempt(state, checkpoint, ports, 'copy_stalled', { elapsedMs: at - copyStartedAt, staged: checkpoint.objectCounts(state.id).staged });
  let progressed = false;
  for (let staged = 0; staged < limits.maxObjectsPerStep; staged += 1) {
    const now = ports.now();
    const pending = checkpoint.pendingObjects(state.id, 1);
    if (pending.length === 0) break;
    if (left(now) <= 0) return stalled(now);
    if (now - started >= limits.stepMs) break;
    const object = pending[0]!;
    let answer: CopyAnswer;
    try {
      answer = await within(
        (signal) => ports.copyObject(state.prefix, { key: object.key, source: object.source }, { bytes: object.bytes, sha256: object.sha256 }, signal),
        Math.min(limits.objectMs, left(now)), ports.now,
      );
    } catch (error) {
      if (!(error instanceof Stalled)) throw error;
      const at = ports.now();
      if (left(at) <= 0) return stalled(at);
      throw new TransientProducerFailure({ cause: 'transport', status: null, transient: true });
    }
    if (answer.status === 'missing') {
      return failAttempt(state, checkpoint, ports, 'object_missing', { bytes: object.bytes });
    }
    if (answer.status === 'error') {
      if (answer.failure.transient) throw new TransientProducerFailure(answer.failure);
      return failAttempt(state, checkpoint, ports, COPY_REFUSAL[answer.failure.cause], { status: answer.failure.status ?? 0 });
    }
    // A staged copy answers for itself: its size, and the digest the source recorded wherever it recorded one.
    if (answer.bytes !== object.bytes || (object.sha256 !== null && answer.sha256 !== object.sha256)) {
      return failAttempt(state, checkpoint, ports, 'object_changed', { staged: answer.bytes, expected: object.bytes });
    }
    checkpoint.recordCopied(state.id, object.key, { sha256: answer.sha256, bytes: answer.bytes });
    progressed = true;
  }
  const counts = checkpoint.objectCounts(state.id);
  if (counts.staged < counts.registered) {
    return { attempt: state.id, stage: 'copy', progressed, nextInMs: 0, sourcePaused: false };
  }
  return await completeStaging(state, checkpoint, ports, limits);
}

/** The column order each captured definition declares, for the reader that maps a row by its own schema. */
function tableColumnsOf(captured: TableDefinitions): Record<string, readonly string[]> {
  const columns: Record<string, readonly string[]> = {};
  for (const [table, definition] of Object.entries(captured)) {
    const declared = tableColumns(definition);
    if (declared !== null) columns[table] = declared;
  }
  return columns;
}

/** The fields a staging manifest carries from admission, which completion keeps rather than writes again. */
export interface AdmittedManifest {
  source: { target: string; locator: string };
  startedAt: string;
  schema: { sha256: string; bytes: number };
  configuration: Record<string, unknown>;
  credentialsRequired: string[];
}

/**
 * The manifest a completed staging carries: what admission published, the fingerprint of the export every recorded
 * part is held to, and every object the export's own rows name with the digest its staged copy answered.
 */
export function completeStagingManifest(input: {
  admitted: AdmittedManifest;
  completedAt: number;
  database: { sha256: string; bytes: number };
  bookmark: string | null;
  objects: readonly { key: string; bytes: number; sha256: string }[];
}): RecoveryStagingManifest {
  return {
    format: STAGING_FORMAT,
    source: input.admitted.source,
    status: 'complete',
    startedAt: input.admitted.startedAt,
    completedAt: new Date(input.completedAt).toISOString(),
    database: input.database,
    schema: input.admitted.schema,
    ...(input.bookmark === null ? {} : { exportBookmark: input.bookmark }),
    configuration: input.admitted.configuration,
    credentialsRequired: input.admitted.credentialsRequired,
    objects: [...input.objects].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  };
}

/**
 * Completes the staging, once every registered object is staged and verified, and confirms that publication.
 *
 * The publication contract:
 * - Before a completion time is recorded nothing is published, so the copy budget still applies and an attempt past
 *   it ends without writing a manifest.
 * - The completion time is recorded before the manifest naming it is written, so every write and every read-back
 *   compares one exact manifest body.
 * - A manifest that reads back as exactly that body is published, whenever its write settled, and the attempt
 *   completes. Nothing else confirms a publication: a write that answered in time and a read-back that matches are the
 *   same evidence, and an answer that never came is no evidence at all.
 * - A store write cannot be withdrawn once sent, so a staging that reads as unpublished proves nothing about a write
 *   still on its way. Inside `publishMs` an unconfirmed publication is written again and read again; past it the
 *   attempt rests `unconfirmed` — no failure is claimed, no success is assumed, and no new attempt is held back.
 *   `reconcileUnconfirmed` settles such an attempt to `complete` once its exact manifest reads back.
 * - A staging that reads back as a different completed manifest belongs to no write of this attempt, and ends
 *   `staging_changed`.
 */
async function completeStaging(
  state: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits,
): Promise<ContinuationReport> {
  const objects = checkpoint.objects(state.id);
  const unstaged = objects.filter((object) => object.stagedSha256 === null);
  if (unstaged.length > 0) return failAttempt(state, checkpoint, ports, 'staging_incomplete', { unstaged: unstaged.length });
  if (state.databaseSha256 === null || state.databaseBytes === null) {
    return failAttempt(state, checkpoint, ports, 'staging_incomplete', { database: false });
  }
  const pending = (at: number, completedAt: number): ContinuationReport => {
    if (at - completedAt > limits.publishMs) return unconfirmed(state, checkpoint, at - completedAt);
    emit({ kind: 'recovery_publication_unconfirmed', attempt: state.id, elapsedMs: at - completedAt });
    return { attempt: state.id, stage: 'copy', progressed: false, nextInMs: 1_000, sourcePaused: false, error: 'provider_unavailable' };
  };

  const read = await readPublished(state, ports, limits);
  if (read.status === 'unreadable') {
    if (state.completedAt !== null) return pending(ports.now(), state.completedAt);
    throw new TransientProducerFailure({ cause: 'storage', status: null, transient: true });
  }
  const expected = expectedManifest(state, objects);
  if (expected === null) return failAttempt(state, checkpoint, ports, 'staging_incomplete', { admitted: false });
  // A staging holding no manifest at all is not the staging admission published.
  if (read.body === null) return failAttempt(state, checkpoint, ports, 'staging_incomplete', { published: false });

  let completedAt = state.completedAt;
  if (completedAt !== null) {
    if (read.body === expected(completedAt)) return completed(state, checkpoint, objects.length, state.databaseBytes);
    if (publishedStatus(read.body) === 'complete') return failAttempt(state, checkpoint, ports, 'staging_changed', { published: true });
    if (ports.now() - completedAt > limits.publishMs) return unconfirmed(state, checkpoint, ports.now() - completedAt);
  } else {
    if (publishedStatus(read.body) === 'complete') return failAttempt(state, checkpoint, ports, 'staging_changed', { published: true });
    const now = ports.now();
    if (state.copyStartedAt !== null && now - state.copyStartedAt > limits.copyMs) {
      return failAttempt(state, checkpoint, ports, 'copy_stalled', { elapsedMs: now - state.copyStartedAt, staged: objects.length });
    }
    completedAt = now;
    checkpoint.update(state.id, { completedAt });
  }

  const body = expected(completedAt);
  try {
    await within(
      (signal) => ports.writeStagingFile(state.prefix, STAGING_MANIFEST_FILE, body, signal),
      Math.min(limits.requestMs, limits.publishMs - (ports.now() - completedAt)), ports.now,
    );
  } catch {
    return pending(ports.now(), completedAt);
  }
  return completed(state, checkpoint, objects.length, state.databaseBytes);
}

/**
 * Settles an attempt resting `unconfirmed`: if its staging now reads back as exactly the manifest it wrote, that
 * publication landed and the attempt completes; any other reading leaves it as it rests. One bounded read, and never
 * a write: this confirms a publication and never makes one.
 */
export async function reconcileUnconfirmed(
  state: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits = PRODUCER_LIMITS,
): Promise<AttemptStage> {
  if (state.stage !== 'unconfirmed' || state.completedAt === null || state.databaseBytes === null) return state.stage;
  const objects = checkpoint.objects(state.id);
  if (objects.some((object) => object.stagedSha256 === null)) return state.stage;
  const expected = expectedManifest(state, objects);
  if (expected === null) return state.stage;
  const read = await readPublished(state, ports, limits);
  if (read.status === 'unreadable' || read.body !== expected(state.completedAt)) return state.stage;
  completed(state, checkpoint, objects.length, state.databaseBytes);
  return 'complete';
}

/** The staging's manifest as the store holds it now, read under the deadline owner. */
async function readPublished(
  state: AttemptState, ports: ProducerPorts, limits: ProducerLimits,
): Promise<{ status: 'read'; body: string | null } | { status: 'unreadable' }> {
  try {
    const body = await within((signal) => ports.readStagingFile(state.prefix, STAGING_MANIFEST_FILE, signal), limits.requestMs, ports.now);
    return { status: 'read', body };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * The exact manifest body this attempt publishes for a given completion time, built only from what the checkpoint
 * owner holds: the admission it recorded, the export fingerprint and the staged objects it verified. What a staging
 * holds is compared with this, and never contributes to it. Null where the checkpoint holds no admission.
 */
function expectedManifest(state: AttemptState, objects: readonly AttemptObject[]): ((completedAt: number) => string) | null {
  const admission = state.admission ?? null;
  if (admission === null || state.databaseSha256 === null || state.databaseBytes === null) return null;
  const database = { sha256: state.databaseSha256, bytes: state.databaseBytes };
  return (completedAt) => JSON.stringify(completeStagingManifest({
    admitted: admission,
    completedAt,
    database,
    bookmark: state.bookmark,
    objects: objects.map((object) => ({ key: object.key, bytes: object.stagedBytes ?? object.bytes, sha256: object.stagedSha256! })),
  }), null, 2);
}

/** Rests the attempt `unconfirmed`: terminal for the continuation, claiming neither publication nor failure. */
function unconfirmed(state: AttemptState, checkpoint: AttemptCheckpoint, elapsedMs: number): ContinuationReport {
  checkpoint.update(state.id, { stage: 'unconfirmed', error: null });
  emit({ kind: 'recovery_publication_unconfirmed', attempt: state.id, elapsedMs, resting: true });
  return { attempt: state.id, stage: 'unconfirmed', progressed: true, nextInMs: null, sourcePaused: false };
}

/** The status a staging manifest's body declares, where it declares one. */
function publishedStatus(body: string | null): string | null {
  if (body === null) return null;
  try {
    const held = JSON.parse(body) as { status?: unknown };
    return typeof held.status === 'string' ? held.status : null;
  } catch { return null; }
}

function completed(state: AttemptState, checkpoint: AttemptCheckpoint, objects: number, bytes: number): ContinuationReport {
  checkpoint.update(state.id, { stage: 'complete', error: null });
  emit({ kind: 'recovery_staging_completed', attempt: state.id, objects, bytes });
  return { attempt: state.id, stage: 'complete', progressed: true, nextInMs: null, sourcePaused: false };
}

/** A reading of the export text from its start, for an attempt that begins its download again. */
export const freshScan = (): ScanProgress => ({ defined: {}, scan: newStatementScan(), scanBytes: '' });

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

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
 * Reads the table definitions one staged part carries, through the same statement splitter an import reads an export
 * with: a `CREATE TABLE` inside a row value stays inside that value, and a definition split across parts is read
 * once it is whole.
 */
export function readDefinitions(
  attempt: AttemptState, bytes: Uint8Array | ReadableStream<Uint8Array>, last: boolean,
): ScanProgress {
  if (!(bytes instanceof Uint8Array)) return { defined: attempt.defined, scan: attempt.scan, scanBytes: attempt.scanBytes };
  const held = fromHex(attempt.scanBytes);
  const whole = new Uint8Array(held.byteLength + bytes.byteLength);
  whole.set(held);
  whole.set(bytes, held.byteLength);
  const { text, tail } = splitCharacters(whole);
  const defined = { ...attempt.defined };
  const scan = { ...attempt.scan };
  const take = (statement: string): void => {
    const table = tableDefinition(statement);
    if (table !== null) defined[table.name] = table.definition;
  };
  feedStatements(scan, text, 'definitions', take);
  if (last) endStatements(scan, 'definitions', take);
  return { defined, scan, scanBytes: toHex(tail) };
}

/** The captured definitions an export must carry, in the same comparable form the export text is read into. */
export function capturedDefinitions(schema: readonly { storage: string | null; sql: string }[]): TableDefinitions {
  const captured: TableDefinitions = {};
  for (const object of schema) {
    if (object.storage !== 'table') continue;
    const table = tableDefinition(object.sql);
    if (table !== null) captured[table.name] = table.definition;
  }
  return captured;
}

/**
 * Whether the export defines every captured table exactly as the capture holds it. Counts alone answer, so a table
 * name never travels into a status or a log.
 */
export function definitionsDisagree(
  captured: TableDefinitions, defined: TableDefinitions,
): { captured: number; defined: number; missing: number; extra: number; changed: number } | null {
  const names = Object.keys(captured);
  const missing = names.filter((name) => defined[name] === undefined).length;
  const changed = names.filter((name) => defined[name] !== undefined && defined[name] !== captured[name]).length;
  // `sqlite_sequence` holds the high-water marks of AUTOINCREMENT tables and carries no definition of its own.
  const extra = Object.keys(defined).filter((name) => captured[name] === undefined && name !== 'sqlite_sequence').length;
  if (missing === 0 && changed === 0 && extra === 0) return null;
  return { captured: names.length, defined: Object.keys(defined).length, missing, extra, changed };
}

/** Holds an already-stored export to the digests recorded as each part streamed, a part at a time. */
async function reconcileStored(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<{ ok: boolean; pending: boolean; facts?: Record<string, number | boolean> }> {
  const parts = checkpoint.parts(attempt.id);
  if (parts.length === 0) return { ok: false, pending: false, facts: { parts: 0 } };
  const recorded = parts.reduce((sum, part) => sum + part.bytes, 0);
  if (recorded !== attempt.sqlBytes) return { ok: false, pending: false, facts: { recorded, expected: attempt.sqlBytes ?? 0 } };
  let index = 0;
  let at = 0;
  while (index < parts.length && at + parts[index]!.bytes <= attempt.reconcileOffset) { at += parts[index]!.bytes; index += 1; }
  while (index < parts.length) {
    if (ports.now() - started > limits.stepMs) return { ok: false, pending: true };
    const part = parts[index]!;
    const stored = await ports.readStoredRange(attempt.prefix, at, part.bytes);
    if (stored === null) return { ok: false, pending: false, facts: { absent: true, at } };
    if (stored.sha256 !== part.sha256) return { ok: false, pending: false, facts: { part: part.part, digest: false } };
    at += part.bytes;
    index += 1;
    checkpoint.update(attempt.id, { reconcileOffset: at });
  }
  const size = await ports.storedSize(attempt.prefix);
  if (size !== attempt.sqlBytes) return { ok: false, pending: false, facts: { staged: size ?? 0, expected: attempt.sqlBytes ?? 0 } };
  return { ok: true, pending: false };
}

/** What one attempt's staging is opened from: where it goes, what produced it, and the schema it captured. */
export interface AttemptPublication {
  prefix: string;
  target: string;
  locator: string;
  startedAt: number;
  schema: { sha256: string; bytes: number };
  schemaText: string;
  configuration: Record<string, unknown>;
  credentialsRequired: readonly string[];
}

/**
 * Stages the capture, then records the attempt through `record`. The record is the publication: a staging write that
 * fails, or an interruption before it, leaves no attempt at all, so no continuation can advance one whose schema and
 * manifest are not both staged.
 */
export async function publishAttempt(
  ports: ProducerPorts, input: AttemptPublication, record: (admission: AdmittedManifest) => void,
): Promise<void> {
  const opened = openStagingManifest({ ...input, bookmark: null });
  await ports.writeStagingFile(input.prefix, STAGING_SCHEMA_FILE, input.schemaText);
  await ports.writeStagingFile(input.prefix, STAGING_MANIFEST_FILE, JSON.stringify(opened, null, 2));
  // The owner records exactly the admission it just published, the one anchor a completed manifest is built from.
  record({
    source: opened.source, startedAt: opened.startedAt, schema: opened.schema,
    configuration: opened.configuration, credentialsRequired: opened.credentialsRequired,
  });
}

/** The manifest an open staging carries: enough to describe what is staged, and never a completed artifact. */
export function openStagingManifest(input: {
  target: string; locator: string; startedAt: number; schema: { sha256: string; bytes: number }; configuration: Record<string, unknown>;
  credentialsRequired: readonly string[]; bookmark: string | null;
}): RecoveryStagingManifest {
  return {
    format: STAGING_FORMAT,
    source: { target: input.target, locator: input.locator },
    status: 'open',
    startedAt: new Date(input.startedAt).toISOString(),
    schema: input.schema,
    ...(input.bookmark === null ? {} : { exportBookmark: input.bookmark }),
    configuration: input.configuration,
    credentialsRequired: [...input.credentialsRequired],
    objects: [],
  };
}

/**
 * What a producer produces. The hosted producer stages a capture in its object store; a native Deployment's
 * producer writes the verified artifact directly.
 */
export type RecoveryForm = 'staging' | 'artifact';

/** What an owner may see of an attempt: its progress, never a credential and never a claim of recoverability. */
export interface RecoveryProducerStatus {
  attempt: number | null;
  stage: AttemptStage | 'idle';
  /**
   * What this Deployment's producer produces, which decides what a complete attempt may be called.
   *
   * A `staging` is a capture an operator must still materialize and verify; an `artifact` is already the verified
   * form a restore consumes. Nothing may describe one in the other's words.
   */
  form: RecoveryForm;
  /** The instant of this attempt's admission, which a schedule reads its cadence from. Null where there is none. */
  startedAt: number | null;
  /** A staging, complete or not, is not a recoverable artifact until an operator materializes and verifies it. */
  recoverable: false;
  staged: {
    prefix: string; sqlBytes: number | null; downloadedBytes: number; parts: number;
    /** The objects the export's own rows registered, and how many of them have a verified staged copy. */
    objects: { registered: number; staged: number };
  } | null;
  export: { polls: number; bookmark: boolean; reExports: number } | null;
  error: ProducerRefusal | null;
  transientSpent: number;
  /** The schema capture this attempt staged, so a later read can tell whether the Deployment has moved on. */
  stagedSchema: { sha256: string; bytes: number } | null;
  /** Set once the Deployment's schema no longer matches that capture. */
  schemaDrifted?: boolean;
  /** Set on an admission that named a retired hold token: it admits nothing. */
  holdRetired?: true;
  /** Set once retention began releasing this attempt's staged payload: `staged` answers none from then on. */
  stagingPruned?: true;
}

/** Which staged payloads a Deployment keeps. The producer holds the attempts; the policy comes from the Deployment. */
export interface StagingPrunePolicy {
  /** Complete stagings to keep; the newest counts toward it. */
  keep: number;
  /** Hold tokens the Deployment still holds open, or could not read: their attempts are never touched. */
  protect: readonly string[];
}

/** What one retention pass is asked to do, and what it may spend doing it. */
export interface StagingPruneRequest extends StagingPrunePolicy {
  /** Files this pass may release. One wake releases no more than this, so no pass is unbounded. */
  budget: number;
}

/** What one retention pass did. `pending` is what it left for the next wake, whether begun or not yet begun. */
export interface StagingPruneReport {
  releasedFiles: number;
  releasedStagings: number;
  pending: number;
  /**
   * How a store refusal that ended the pass classifies, where one did. The attempt keeps its identity and its
   * cursor, and no provider or exception text travels with it.
   */
  refused: ErrorClass | null;
}

/**
 * What admission hands the producer: the tables to export, the schema captured before any export, and who started it.
 * The Deployment's recorded configuration and the credentials a recovery needs are the producer's own to record; no
 * caller supplies them.
 */
export interface RecoveryAdmission {
  /** The recovery hold this Deployment opened for the attempt, before any export ran; the attempt carries it for life. */
  holdToken: string;
  tables: readonly string[];
  schema: string;
  /** The definitions that schema holds, which the exported bytes are later held to. */
  captured: TableDefinitions;
  /** The member who admitted the attempt, recorded in the staging's configuration. */
  startedBy: string;
}

/** Whether the producer can record a complete configuration for a new attempt, and why not when it cannot. */
export type RecoveryAdmissionReadiness = { ready: true } | { ready: false; reason: string };

/**
 * What a recovery hold's attempt says about it, read and decided in one step of the producer that owns attempts:
 * - `open`: an attempt carrying the hold is still advancing, and its objects may not be released yet;
 * - `closed`: the attempt carrying it rests in a stage that advances no further, so its snapshot and staged objects are
 *   whatever they will be;
 * - `retired`: no attempt carries it, and none ever will: the token is recorded as retired in the same step, and
 *   admission refuses a retired token.
 */
export type HoldSettlement =
  | { state: 'open'; attempt: number; stage: AttemptStage }
  | { state: 'closed'; attempt: number; stage: AttemptStage }
  | { state: 'retired' };

/** The settlement an attempt row carrying a hold decides, or `retired` where none carries it. */
export function settlementOf(attempt: { id: number; stage: AttemptStage } | null): HoldSettlement {
  if (attempt === null) return { state: 'retired' };
  return (ADVANCING_STAGES as readonly string[]).includes(attempt.stage)
    ? { state: 'open', attempt: attempt.id, stage: attempt.stage }
    : { state: 'closed', attempt: attempt.id, stage: attempt.stage };
}

/** Raised inside the producer's admission for a hold token already retired; admission answers `holdRetired` instead. */
export class HoldRetired extends Error {
  constructor() {
    super('the recovery hold this admission named is already retired; start the export again');
    this.name = 'HoldRetired';
  }
}

/** Starting and inspecting this Deployment's producer, as a target supplies it. The credential stays in the target. */
export interface RecoveryProducerPort {
  /** Whether a new attempt may be admitted. Status, hold settlement and an attempt already admitted do not depend on it. */
  admission: RecoveryAdmissionReadiness;
  admit(admission: RecoveryAdmission): Promise<RecoveryProducerStatus>;
  /** Decide a hold against the attempts, retiring a token no attempt carries; see `HoldSettlement`. */
  settleHold(token: string): Promise<HoldSettlement>;
  status(): Promise<RecoveryProducerStatus>;
  /** Record that the Deployment's schema drifted from the staged capture, failing the attempt. */
  noteSchemaDrift(attempt: number): Promise<RecoveryProducerStatus>;
  /** How many staged payloads this policy lets go of and retention has not finished releasing. */
  pendingStagingPrunes(policy: StagingPrunePolicy): Promise<number>;
  /** Release the staged payloads the policy lets go of, bounded by the request's budget. */
  pruneStagings(request: StagingPruneRequest): Promise<StagingPruneReport>;
  /**
   * Make progress on the attempt already in flight, for a producer that has to be asked.
   *
   * A producer whose work runs outside this process needs a caller to notice that it stopped; one driven by its
   * own clock's continuations implements none of this.
   */
  resumeAttempt?(): Promise<void>;
}

/** Where an attempt's staged export lives. */
export const stagedSqlKey = (prefix: string): string => stagingPath(prefix, STAGING_SQL_FILE);
