/**
 * The hosted recovery producer's stage machine: it drives one admitted attempt from an export the provider runs to a
 * downloaded SQL export beside its captured schema, and stops there. This slice produces no inventory, no object
 * copies and no complete staging, so nothing it writes may be read as a recoverable artifact.
 *
 * Every durable fact lives in the checkpoint the caller supplies, which on the hosted target is the platform's own
 * object storage: the source is unavailable to queries while it exports, so no progress may depend on reading it. The
 * ports are the only way out to a provider or a store, which is what makes the machine testable without one. A port
 * answers classified facts and never text, so no provider message, URL or exception can reach a status or a log.
 */
import { emit } from '../telemetry.js';
import {
  STAGING_FORMAT, STAGING_MANIFEST_FILE, STAGING_SCHEMA_FILE, STAGING_SQL_FILE, stagingPath, type RecoveryStagingManifest,
} from './recovery-staging.js';
import {
  endStatements, feedStatements, newStatementScan, tableDefinition, type StatementScan,
} from './sql-statements.js';

/** How an attempt ends, or that it continues. */
export type AttemptStage = 'export' | 'download' | 'downloaded' | 'failed';

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
}

export interface AttemptPart { part: number; bytes: number; sha256: string; etag: string }

/** The durable store an attempt advances in; the hosted target backs this with its own checkpoint SQL. */
export interface AttemptCheckpoint {
  open(): AttemptState | null;
  update(id: number, fields: Partial<AttemptState>): void;
  parts(id: number): AttemptPart[];
  /** Records one staged part with the cursor and the reading of its bytes, as one durable step. */
  recordPart(id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress): void;
  clearParts(id: number): void;
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
  /** Write the staging manifest and the captured schema. */
  writeStagingFile(prefix: string, name: string, body: string): Promise<void>;
  now(): number;
}

export interface ProducerLimits {
  /** Bytes per downloaded part. */
  partBytes: number;
  /** How long one continuation may poll an export before it returns for another. */
  exportPollMs: number;
  /** How long one continuation may spend in total. */
  stepMs: number;
  /** Transient failures one attempt may spend before it fails. */
  maxTransient: number;
  /** How many times one attempt may ask the provider for a fresh export before it fails. */
  maxReExports: number;
}

export const PRODUCER_LIMITS: ProducerLimits = { partBytes: 32 * 1024 * 1024, exportPollMs: 600_000, stepMs: 20_000, maxTransient: 5, maxReExports: 3 };

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
  | 'download_unranged' | 'download_changed' | 'download_lost' | 'staging_unreconciled'
  | 'schema_disagrees' | 'internal';

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
    return { ...IDLE, attempt: open.id, stage: open.stage };
  } catch (error) {
    if (error instanceof TransientProducerFailure && open.attempts + 1 < limits.maxTransient) {
      const { cause, status } = error.failure;
      emit({ kind: 'recovery_attempt_transient', attempt: open.id, stage: open.stage, spent: open.attempts + 1, cause, status });
      checkpoint.update(open.id, { attempts: open.attempts + 1, error: 'provider_unavailable' });
      return { attempt: open.id, stage: open.stage, progressed: false, nextInMs: 1_000, sourcePaused: open.stage === 'export', error: 'provider_unavailable' };
    }
    if (error instanceof TransientProducerFailure) {
      return fail(open, checkpoint, ports, 'provider_unavailable', { spent: open.attempts, status: error.failure.status ?? 0 });
    }
    return fail(open, checkpoint, ports, 'internal', {}, thrownShape(error));
  }
}

async function fail(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, refusal: ProducerRefusal,
  facts: Record<string, number | boolean> = {}, shape?: ThrownShape,
): Promise<ContinuationReport> {
  const named = refuse(attempt, refusal, facts, shape);
  if (attempt.uploadId !== null) await ports.abortUpload(attempt.prefix, attempt.uploadId).catch(() => undefined);
  await checkpoint.setSignedUrl(attempt.id, null);
  checkpoint.update(attempt.id, { stage: 'failed', error: named, uploadId: null });
  return { attempt: attempt.id, stage: 'failed', progressed: true, nextInMs: null, sourcePaused: false, error: named };
}

/** Polls the export back to back inside one continuation; the source is unreadable for as long as this runs. */
async function pollExportStage(
  attempt: AttemptState, checkpoint: AttemptCheckpoint, ports: ProducerPorts, limits: ProducerLimits, started: number,
): Promise<ContinuationReport> {
  let bookmark = attempt.bookmark;
  const before = attempt.polls;
  let polls = before;
  if (attempt.exportStartedAt === null) checkpoint.update(attempt.id, { exportStartedAt: started });
  for (let first = true; first || ports.now() - started < Math.min(limits.exportPollMs, limits.stepMs); first = false) {
    const answer = await ports.pollExport(bookmark);
    polls += 1;
    if (answer.status === 'error') {
      if (answer.failure.transient) throw new TransientProducerFailure(answer.failure);
      return fail(attempt, checkpoint, ports, EXPORT_REFUSAL[answer.failure.cause], { status: answer.failure.status ?? 0, polls });
    }
    bookmark = answer.bookmark;
    checkpoint.update(attempt.id, { bookmark, polls });
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
  const restartExport = async (): Promise<ContinuationReport> => {
    if (state.reExports + 1 > limits.maxReExports) {
      return fail(state, checkpoint, ports, 'download_lost', { reExports: state.reExports + 1 });
    }
    if (state.uploadId !== null) await ports.abortUpload(state.prefix, state.uploadId).catch(() => undefined);
    checkpoint.clearParts(state.id);
    await checkpoint.setSignedUrl(state.id, null);
    checkpoint.update(state.id, {
      stage: 'export', bookmark: null, exportStartedAt: null, exportCompletedAt: null,
      sqlBytes: null, sqlEtag: null, uploadId: null, downloadOffset: 0, reconcileOffset: 0, reExports: state.reExports + 1,
      ...freshScan(),
    });
    return { attempt: state.id, stage: 'export', progressed: true, nextInMs: 0, sourcePaused: false };
  };

  while (state.sqlBytes === null || state.downloadOffset < state.sqlBytes) {
    if (ports.now() - started > limits.stepMs) {
      return { attempt: state.id, stage: 'download', progressed, nextInMs: 0, sourcePaused: false };
    }
    const url = await checkpoint.signedUrl(state.id);
    if (url === null) return restartExport();
    const length = state.sqlBytes === null ? limits.partBytes : Math.min(limits.partBytes, state.sqlBytes - state.downloadOffset);
    const answer = await ports.readRange(url, state.downloadOffset, length);
    if (answer.status === 'gone') return restartExport();
    if (answer.status === 'unranged') return fail(state, checkpoint, ports, 'download_unranged');
    if (answer.status === 'error') {
      if (answer.failure.transient) throw new TransientProducerFailure(answer.failure);
      return fail(state, checkpoint, ports, DOWNLOAD_REFUSAL[answer.failure.cause], { status: answer.failure.status ?? 0 });
    }
    if (state.sqlBytes === null) {
      checkpoint.update(state.id, { sqlBytes: answer.total, sqlEtag: answer.etag });
      state = { ...state, sqlBytes: answer.total, sqlEtag: answer.etag };
    } else if (answer.total !== state.sqlBytes || (state.sqlEtag !== null && answer.etag !== null && answer.etag !== state.sqlEtag)) {
      return fail(state, checkpoint, ports, 'download_changed', { total: answer.total, expected: state.sqlBytes });
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
      return fail(state, checkpoint, ports, 'export_unparsable', { offset });
    }
    // The cursor and the reading of the bytes it covers commit together, so a resumed attempt reads every byte once.
    checkpoint.recordPart(state.id, { part: number, bytes: answer.length, ...written }, offset, progress);
    state = { ...state, downloadOffset: offset, ...progress };
    progressed = true;
  }

  // The capture and the exported bytes must define the same tables the same way: a capture that no longer describes
  // the export is not a snapshot of anything. `sqlite_sequence` carries rows without a definition of its own.
  const disagreement = definitionsDisagree(state.captured, state.defined);
  if (disagreement !== null) return fail(state, checkpoint, ports, 'schema_disagrees', disagreement);
  const parts = checkpoint.parts(state.id);
  const completed = state.uploadId === null ? null : await ports.completeUpload(state.prefix, state.uploadId, parts);
  if (completed === null) {
    // An interrupted completion leaves the upload gone and the object present: only the recorded part digests decide.
    const reconciled = await reconcileStored(state, checkpoint, ports, limits, started);
    if (reconciled.pending) return { attempt: state.id, stage: 'download', progressed: true, nextInMs: 0, sourcePaused: false };
    if (!reconciled.ok) return fail(state, checkpoint, ports, 'staging_unreconciled', reconciled.facts ?? {});
    checkpoint.update(state.id, { reconciled: 1 });
  } else if (completed.bytes !== state.sqlBytes) {
    return fail(state, checkpoint, ports, 'staging_unreconciled', { staged: completed.bytes, expected: state.sqlBytes ?? 0 });
  }
  await checkpoint.setSignedUrl(state.id, null);
  checkpoint.update(state.id, { stage: 'downloaded', uploadId: null, error: null });
  return { attempt: state.id, stage: 'downloaded', progressed: true, nextInMs: null, sourcePaused: false };
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
export async function publishAttempt(ports: ProducerPorts, input: AttemptPublication, record: () => void): Promise<void> {
  await ports.writeStagingFile(input.prefix, STAGING_SCHEMA_FILE, input.schemaText);
  await ports.writeStagingFile(
    input.prefix, STAGING_MANIFEST_FILE, JSON.stringify(openStagingManifest({ ...input, bookmark: null }), null, 2),
  );
  record();
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

/** What an owner may see of an attempt: its progress, never a credential and never a claim of recoverability. */
export interface RecoveryProducerStatus {
  attempt: number | null;
  stage: AttemptStage | 'idle';
  /** This slice stages an export and stops, so no attempt it produces is a recoverable artifact. */
  recoverable: false;
  staged: { prefix: string; sqlBytes: number | null; downloadedBytes: number; parts: number } | null;
  export: { polls: number; bookmark: boolean; reExports: number } | null;
  error: ProducerRefusal | null;
  transientSpent: number;
  /** The schema capture this attempt staged, so a later read can tell whether the Deployment has moved on. */
  stagedSchema: { sha256: string; bytes: number } | null;
  /** Set once the Deployment's schema no longer matches that capture. */
  schemaDrifted?: boolean;
}

/** What admission hands the producer: the tables to export, the schema captured before any export, and its context. */
export interface RecoveryAdmission {
  tables: readonly string[];
  schema: string;
  /** The definitions that schema holds, which the exported bytes are later held to. */
  captured: TableDefinitions;
  configuration: Record<string, unknown>;
  credentialsRequired: readonly string[];
}

/** Starting and inspecting this Deployment's producer, as a target supplies it. The credential stays in the target. */
export interface RecoveryProducerPort {
  admit(admission: RecoveryAdmission): Promise<RecoveryProducerStatus>;
  status(): Promise<RecoveryProducerStatus>;
  /** Record that the Deployment's schema drifted from the staged capture, failing the attempt. */
  noteSchemaDrift(attempt: number): Promise<RecoveryProducerStatus>;
}

/** Where an attempt's staged export lives. */
export const stagedSqlKey = (prefix: string): string => stagingPath(prefix, STAGING_SQL_FILE);
