import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { diskBlobStore, sweepPartialObjects } from '@myco-server-worker/platform/bun/blobs.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { BACKUP_KEY_PREFIX } from '@myco-server-worker/core/backup.js';
import { BLOB_REFERENCES, kindFilter, referenceLabel } from '@myco-server-worker/core/blob-references.js';
import { BLOB_KEY_GRAMMAR } from '@myco-server-worker/ingest/kinds.js';
import { blobArtifactKey, snapshotBlobObject } from '@myco-server-worker/core/blob-objects.js';
import { RECOVERY_CREDENTIAL_NAMES, recordedFleet } from '@myco-server-worker/core/recovery-staging.js';
import { atomicWriteFileSync, syncDirectoryForDurability as syncDirectory } from '@myco/utils/atomic-write.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { refusedAccountCode, transientReadFailure } from './object-read.js';
import { fingerprintSchema, STAGING_FORMAT } from './recovery-contract.js';
import { quoteIdentifier } from './recovery-schema.js';

const MANIFEST_FILE = 'recovery.json';
const DATABASE_FILE = 'myco.sqlite';
const LOCK_FILE = '.recovery.lock';
const HOLD_FILE = '.recovery-hold.json';
const HOLD_BOUND_FILE = '.recovery-hold-bound.json';
const SNAPSHOT_DIRECTORY = '.snapshot';
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const DIGEST = BLOB_KEY_GRAMMAR;

/** `receipt` names the exact source snapshot an artifact came from, where its producer can name one. */
const sourceSchema = z.object({ target: z.enum(['local', 'cloudflare']), locator: z.string().min(1), receipt: z.string().regex(DIGEST).optional() });
const blobSchema = z.object({ key: z.string(), sha256: z.string().regex(DIGEST), bytes: z.number().int().nonnegative() });
const isBackupKey = (key: string): boolean => key.startsWith(BACKUP_KEY_PREFIX)
  && /^[A-Za-z0-9_-]+\.jsonl$/.test(key.slice(BACKUP_KEY_PREFIX.length));
const backupSchema = blobSchema.omit({ sha256: true }).extend({ key: z.string().refine(isBackupKey, 'invalid recovery backup key') });
/** A catalogued backup as its snapshot records it: the digest written with the row, or null for a row that carries none. */
const cataloguedBackupSchema = backupSchema.extend({ sha256: z.string().regex(DIGEST).nullable() });
const snapshotSchema = z.object({
  deploymentId: z.string().min(1), schemaVersion: z.number().int().positive(),
  database: fingerprintSchema, blobCount: z.number().int().nonnegative(), blobBytes: z.number().int().nonnegative(),
  configuration: z.record(z.string(), z.unknown()),
  credentialsRequired: z.array(z.string()), capturedAt: z.string().datetime(),
});
const manifestFields = {
  source: sourceSchema, startedAt: z.string().datetime(),
  status: z.enum(['snapshot', 'content', 'complete']), snapshot: snapshotSchema.optional(),
  completedAt: z.string().datetime().optional(),
};
const manifestSchema = z.discriminatedUnion('format', [
  z.object({ ...manifestFields, format: z.literal('myco-recovery/1') }),
  z.object({ ...manifestFields, format: z.literal('myco-recovery/2'), backupObjects: z.array(blobSchema) }),
]).superRefine((value, ctx) => {
  if (value.status !== 'snapshot' && value.snapshot === undefined) ctx.addIssue({ code: 'custom', message: 'recovery snapshot is missing' });
  if (value.status === 'complete' && value.completedAt === undefined) ctx.addIssue({ code: 'custom', message: 'recovery completion time is missing' });
});

export type RecoverySource = z.infer<typeof sourceSchema>;
export type RecoveryBlob = z.infer<typeof blobSchema>;
type RecoveryObject = RecoveryBlob | z.infer<typeof backupSchema>;
/** An object as a source adapter reads it: its artifact key, and the key its source store holds its bytes under. */
export type RecoverySourceObject = RecoveryObject & { source: string };
export type RecoverySnapshot = Pick<z.infer<typeof snapshotSchema>, 'configuration' | 'credentialsRequired'>;
export type RecoveryManifest = z.infer<typeof manifestSchema>;

type CataloguedBackup = z.infer<typeof cataloguedBackupSchema>;

/**
 * What a restore publishes for the fleet, and what it says about it, from the artifact's recorded configuration. A
 * recorded fleet is carried. An artifact that records none says nothing about the fleet its source ran with, and the
 * restored Deployment is published with no fleet, so dispatch applies no fleet bound. A recorded fleet that is not a
 * whole number of runtimes refuses the restore; verifying or copying the artifact reads it as it is.
 */
export function restoredFleet(configuration: Readonly<Record<string, unknown>>): { fleet: number | null; report: string } {
  const fleet = recordedFleet(configuration);
  if (fleet !== null) return { fleet, report: `Recorded fleet ${fleet} carried to the restored Deployment.` };
  return { fleet, report: 'The artifact records no fleet, so its source fleet is unknown; the restored Deployment is published without one, and dispatch applies no fleet bound.' };
}

/** The credential line an operator reads for an artifact: what it records, and what recovery needs beyond that. */
export function credentialsReport(recorded: readonly string[]): string {
  const needed = RECOVERY_CREDENTIAL_NAMES.filter((name) => !recorded.includes(name));
  if (recorded.length === 0) return `This artifact records no required credentials. Recovery needs these, kept separately: ${RECOVERY_CREDENTIAL_NAMES.join(', ')}`;
  const line = `Keep these credentials separately for recovery: ${recorded.join(', ')}`;
  return needed.length === 0 ? line : `${line}. Recovery also needs: ${needed.join(', ')}`;
}

/** Every catalogued backup in a snapshot, ordered by key. A snapshot whose schema predates the digest column answers null digests. */
function cataloguedBackups(db: Database): CataloguedBackup[] {
  const recorded = db.query("SELECT 1 FROM pragma_table_info('backups') WHERE name = 'sha256'").get() !== null;
  return db.query(`SELECT key, size_bytes AS bytes, ${recorded ? 'sha256' : 'NULL AS sha256'} FROM backups ORDER BY key`).all()
    .map((row) => cataloguedBackupSchema.parse(row));
}

/** The object a copy verifies: a backup with a recorded digest is checked against it, and one without is checked by size. */
function expectedBackupObject({ key, bytes, sha256 }: CataloguedBackup): RecoveryObject {
  return sha256 === null ? { key, bytes } : { key, bytes, sha256 };
}

/**
 * Every blob a snapshot registers, by its logical artifact key, with the key its source store holds the bytes under.
 * The source key comes from the snapshot's own row and generation (`core/blob-objects.ts`); a snapshot whose schema
 * predates generations names the key without one. A row outside the stored grammar refuses the snapshot.
 */
function* registeredObjects(db: Database): Generator<RecoveryBlob & { source: string }> {
  const generation = db.query("SELECT 1 FROM pragma_table_info('blobs') WHERE name = 'generation'").get() !== null ? 'generation' : 'NULL AS generation';
  const statement = db.prepare<{ project_id: unknown; key: unknown; generation: unknown; bytes: unknown }, []>(
    `SELECT project_id, key, ${generation}, size AS bytes FROM blobs ORDER BY project_id, key`);
  try {
    for (const row of statement.iterate()) {
      let object;
      try { object = snapshotBlobObject(row); } catch (error) {
        throw new Error(`recovery database holds an unreadable blob row: ${error instanceof Error ? error.message : String(error)}`);
      }
      yield { ...blobSchema.parse({ key: blobArtifactKey(object.projectId, object.key), sha256: object.key, bytes: row.bytes }), source: object.objectKey };
    }
  } finally { statement.finalize(); }
}

/** The objects a snapshot registers, by artifact key: its blob rows, and its catalogued backups with their digests. */
export function snapshotObjectFacts(file: string): Map<string, { bytes: number; sha256: string | null }> {
  const db = openSnapshot(file);
  try {
    const facts = new Map<string, { bytes: number; sha256: string | null }>();
    for (const row of registeredObjects(db)) facts.set(row.key, { bytes: row.bytes, sha256: row.sha256 });
    for (const backup of cataloguedBackups(db)) facts.set(backup.key, { bytes: backup.bytes, sha256: backup.sha256 });
    return facts;
  } finally { db.close(); }
}

export interface RecoveryAdapter {
  source: RecoverySource;
  /**
   * Write a closed standalone database at databasePath, using workDir for intermediate files, captured under the
   * recovery hold `holdToken` names (null for a source that keeps none).
   */
  snapshot(databasePath: string, workDir: string, holdToken?: string | null): Promise<RecoverySnapshot>;
  /** Stream a registered blob or catalogued backup from this source, read at its `source` key, or throw on absence. */
  blob(object: RecoverySourceObject, workDir: string): Promise<ReadableStream>;
  /**
   * This source's recovery hold, where the source keeps one. A backup protects every object its snapshot names by
   * opening a hold before the snapshot and releasing it when the artifact completes: while it is open, the source
   * records the deletions it decides and journals none of them, so nothing this artifact still has to copy is removed.
   * A source with no hold (an artifact copied from another artifact) leaves it out, and its objects are already fixed.
   */
  hold?: RecoveryHoldOwner;
}

/**
 * The hold one backup takes on its source, by a token this destination records before the hold exists.
 *
 * Both answers are idempotent by token: acquiring a token already open answers `open`, and releasing a token already
 * released answers `released`. So a write whose answer was lost is settled by asking again with the same token, never
 * by taking a second hold.
 *
 * Every operation answers or throws inside a window of its own, and an owner whose transport can outlive the call
 * ends it rather than abandoning it: the hosted owner gives each D1 statement `D1_STATEMENT_TIMEOUT_MS` and ends the
 * command and every process it started at that point, and the native owner takes a non-blocking volume lease and a
 * bounded `busy_timeout`. Ending a command does not cancel a statement the provider already accepted, so a thrown or
 * timed-out operation is an unknown outcome — never an absent or released hold — and it leaves the same token to ask
 * about.
 */
export interface RecoveryHoldOwner {
  /** Opens `token`, or answers what the source already holds for it. */
  acquire(token: string): Promise<RecoveryHoldReading>;
  /** What the source holds for `token`, without changing it. */
  inspect(token: string): Promise<RecoveryHoldReading>;
  /** Releases `token`: `complete` when the artifact is whole, `abandoned` when the operator gives the attempt up. */
  release(token: string, reason: 'complete' | 'abandoned'): Promise<RecoveryHoldReading>;
  /** The operator hold open on this source, whichever destination took it, or null. */
  open(): Promise<{ token: string; acquiredAt: number } | null>;
  /** The source this hold belongs to, as the destination records it, so another Deployment's hold is never adopted. */
  locator: string;
}

/**
 * What a source says about one hold token.
 *
 * `source` is the Deployment that answered, read in the same statement as the hold, and `null` when the source named
 * none. A destination captures and releases only under a reading that identifies its source; a `null` one refuses.
 */
export interface RecoveryHoldReading {
  state: 'open' | 'released' | 'absent' | 'other-holder';
  source: RecoveryHoldSource | null;
}

/** The Deployment a hold reading answers for, as a destination records it. */
export type RecoveryHoldSource = z.infer<typeof holdSourceSchema>;

/** Size and digest from the same bounded-memory read of a regular file. */
export async function fingerprintFile(file: string): Promise<z.infer<typeof fingerprintSchema>> {
  if (!fs.lstatSync(file).isFile()) throw new Error(`recovery content is not a regular file: ${file}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

function sameFingerprint(actual: z.infer<typeof fingerprintSchema>, expected: z.infer<typeof fingerprintSchema>): boolean {
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
}

function blobPath(root: string, blob: RecoveryObject): string {
  const parts = blob.key.split('/');
  if (parts.length !== 2 || !parts[0] || parts[0] === '.' || parts[0] === '..'
    || parts[0].includes('\\') || parts[0].includes(':')
    || (!isBackupKey(blob.key) && (!('sha256' in blob) || parts[1] !== blob.sha256 || !DIGEST.test(blob.sha256)))) {
    throw new Error(`invalid recovery blob key: ${blob.key}`);
  }
  return path.join(root, 'blobs', ...parts);
}

/** Publish only after the referenced bytes and their directory entry have been flushed. */
function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function writeManifest(root: string, manifest: RecoveryManifest): void {
  atomicWriteFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', { mode: OWNER_FILE_MODE, durable: true });
}

function readManifest(root: string): RecoveryManifest | null {
  const file = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new Error('recovery manifest must be a regular file');
  const held: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof held === 'object' && held !== null && (held as { format?: unknown }).format === STAGING_FORMAT) {
    throw new Error(`${STAGING_FORMAT} is a staging, not a recovery artifact; materialize it first with \`myco server materialize --from <staging> --to <dir>\``);
  }
  return manifestSchema.parse(held);
}

/** Conservative snapshot acceptance boundary at the edge of the JSON safe-integer range. */
const SAFE_INTEGER_LIMIT = 9_007_199_254_740_992;

/**
 * Refuses a snapshot holding a number outside the contract Myco writes: an integer at or beyond the boundary in any
 * column, or a REAL in a column the snapshot's own schema declares with INTEGER affinity. Comparisons and counts run
 * inside SQLite, over schema-derived columns, without an absolute value.
 */
function refuseUnsafeNumbers(db: Database): void {
  const rows = <Row>(sql: string, parameter?: string): Row[] => {
    const statement = db.prepare(sql);
    try { return (parameter === undefined ? statement.all() : statement.all(parameter)) as Row[]; } finally { statement.finalize(); }
  };
  const tables = rows<{ name: string }>(
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT GLOB 'sqlite_stat*' ORDER BY name",
  );
  const findings: string[] = [];
  for (const { name } of tables) {
    const columns = rows<{ name: string; type: string }>('SELECT name, type FROM pragma_table_info(?)', name);
    if (columns.length === 0) continue;
    const counts = columns.map(({ name: column, type }) => {
      const held = quoteIdentifier(column);
      const unsafeInteger = `typeof(${held}) = 'integer' AND (${held} >= ${SAFE_INTEGER_LIMIT} OR ${held} <= -${SAFE_INTEGER_LIMIT})`;
      const storedReal = /INT/i.test(type) ? ` OR typeof(${held}) = 'real'` : '';
      return `COALESCE(SUM(CASE WHEN (${unsafeInteger})${storedReal} THEN 1 ELSE 0 END), 0) AS ${held}`;
    });
    const row = rows<Record<string, number>>(`SELECT ${counts.join(', ')} FROM ${quoteIdentifier(name)}`)[0]!;
    for (const { name: column } of columns) {
      const affected = row[column] ?? 0;
      if (affected > 0) findings.push(`${name}.${column} (${affected} row${affected === 1 ? '' : 's'})`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`recovery snapshot holds numbers Myco does not write and a provider export cannot carry: ${findings.join(', ')}`
      + '. Investigate and correct these values at their source deliberately; capturing the snapshot again leaves them unchanged.');
  }
}

function openSnapshot(file: string): Database {
  const db = new Database(file, { readonly: true, create: false });
  try {
    const integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('recovery database failed its integrity check');
    if (db.query('PRAGMA foreign_key_check').get() !== null) throw new Error('recovery database has broken foreign keys');
    refuseUnsafeNumbers(db);
    const schemaVersion = Number(db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value);
    for (const ref of BLOB_REFERENCES) {
      if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ref.table) === null) {
        if (schemaVersion >= 75) throw new Error(`recovery database is missing reference table ${ref.table}`);
        continue;
      }
      if (db.query(`SELECT 1 FROM ${ref.table} r WHERE r.${ref.column} IS NOT NULL${kindFilter(ref)}
        AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = r.project_id AND b.key = r.${ref.column}) LIMIT 1`).get() !== null) {
        throw new Error(`recovery database is missing a blob referenced by ${referenceLabel(ref)}`);
      }
    }
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_content_refs'").get() !== null) {
      if (db.query(`SELECT 1 FROM events e WHERE e.payload_format = 'archived'
        AND NOT EXISTS (SELECT 1 FROM event_content_refs r
          WHERE r.project_id = e.project_id AND r.event_id = e.event_id) LIMIT 1`).get() !== null) {
        throw new Error('recovery database has an archived event without its content reference');
      }
      if (db.query(`SELECT 1 FROM event_content_refs r LEFT JOIN events e
          ON e.project_id = r.project_id AND e.event_id = r.event_id
        WHERE e.event_id IS NULL OR e.payload_format <> 'archived' OR e.payload <> '{}'
          OR e.session_id IS NOT r.session_id OR e.envelope_hash IS NOT r.source_envelope_hash
          OR r.version <> 1 OR r.digest IS NOT r.archive_key LIMIT 1`).get() !== null) {
        throw new Error('recovery database has an event content reference inconsistent with its event');
      }
      if (db.query(`SELECT 1 FROM registered_content_proofs p LEFT JOIN blobs b
          ON b.project_id = p.project_id AND b.key = p.key
        WHERE b.key IS NULL OR b.generation IS NOT p.generation
          OR b.key IS NOT p.digest OR b.size IS NOT p.size OR p.durable <> 1 LIMIT 1`).get() !== null) {
        throw new Error('recovery database has a content proof inconsistent with its registered object');
      }
      if (db.query(`SELECT 1 FROM event_content_refs r WHERE
        NOT EXISTS (SELECT 1 FROM registered_content_proofs p
          WHERE p.project_id = r.project_id AND p.key = r.archive_key
            AND p.event_id = r.event_id AND p.envelope_hash = r.source_envelope_hash
            AND p.session_id = r.session_id AND p.digest = r.digest AND p.size = r.size
            AND p.source_kind = 'event' AND p.source_id = r.event_id)
        OR NOT EXISTS (SELECT 1 FROM registered_content_proofs p
          WHERE p.project_id = r.project_id AND p.key = r.receipt_key
            AND p.event_id = r.event_id AND p.envelope_hash = r.source_envelope_hash
            AND p.session_id = r.session_id AND p.source_kind = 'receipt'
            AND p.source_id = 'event:' || r.event_id) LIMIT 1`).get() !== null) {
        throw new Error('recovery database has an event content reference without verified body and receipt');
      }
      if (db.query(`SELECT 1 FROM raw_archive_refs r WHERE r.disposition = 'archived'
        AND (r.archive_key IS NULL OR r.receipt_key IS NULL OR r.digest IS NOT r.archive_key
          OR NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = r.project_id AND b.key = r.archive_key)
          OR NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = r.project_id AND b.key = r.receipt_key)
          OR NOT EXISTS (SELECT 1 FROM registered_content_proofs p WHERE p.project_id = r.project_id
            AND p.key = r.archive_key AND p.source_kind = r.source_kind AND p.source_id = r.source_id
            AND p.session_id = r.session_id AND p.digest = r.archive_key AND p.size = r.size AND p.durable = 1)
          OR NOT EXISTS (SELECT 1 FROM registered_content_proofs p WHERE p.project_id = r.project_id
            AND p.key = r.receipt_key AND p.source_kind = 'receipt'
            AND p.source_id = r.source_kind || ':' || r.source_id
            AND p.session_id = r.session_id AND p.digest = r.receipt_key AND p.durable = 1)) LIMIT 1`).get() !== null) {
        throw new Error('recovery database has a raw archive without verified body and receipt');
      }
      if (db.query(`SELECT 1 FROM tool_calls t LEFT JOIN events e
          ON e.project_id = t.project_id AND e.event_id = t.event_id
        LEFT JOIN processed_resources pr ON pr.project_id = t.project_id AND pr.kind = 'tool-input'
          AND pr.resource_id = t.tool_call_id AND pr.blob_key = t.input_blob_key
        LEFT JOIN events ie ON ie.project_id = pr.project_id AND ie.event_id = pr.event_id
        WHERE t.input_blob_key IS NOT NULL AND t.input IS NOT NULL AND t.input_bytes > 2048
          AND (e.event_id IS NULL OR e.session_id IS NOT t.session_id
            OR t.input IS NULL OR length(CAST(t.input AS BLOB)) > 2048
            OR pr.resource_id IS NULL OR pr.classification IS NOT 'processed'
            OR ie.event_id IS NULL OR ie.session_id IS NOT t.session_id
            OR pr.source_token_id IS NOT ie.token_id
            OR NOT EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
              ON b.project_id = p.project_id AND b.key = p.key AND b.generation IS p.generation
              WHERE p.project_id = t.project_id AND p.key = t.input_blob_key
                AND p.source_kind = 'tool-input' AND p.source_id = t.tool_call_id
                AND p.event_id = ie.event_id AND p.envelope_hash = ie.envelope_hash
                AND p.session_id = t.session_id AND p.digest = p.key
                AND p.size = t.input_bytes AND b.size = p.size AND p.durable = 1)) LIMIT 1`).get() !== null) {
        throw new Error('recovery database has a displayed tool input without its full body proof');
      }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function snapshotFacts(db: Database) {
  const deploymentId = db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'deployment_id'").get()?.value;
  const schemaVersion = Number(db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value);
  if (!deploymentId || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SERVER_SCHEMA_VERSION) {
    throw new Error('recovery database has no supported Deployment identity and schema');
  }
  const counts = db.query<{ blobCount: number; blobBytes: number }, []>('SELECT COUNT(*) AS blobCount, COALESCE(SUM(size), 0) AS blobBytes FROM blobs').get()!;
  return { deploymentId, schemaVersion, ...counts };
}

function assertOwnedDirectory(root: string): void {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    syncDirectory(path.dirname(root));
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error('recovery destination must be a directory, not a symlink');
  const lock = path.join(root, LOCK_FILE);
  if (fs.existsSync(lock) && !fs.lstatSync(lock).isFile()) throw new Error('recovery lock must be a regular file');
  const holdRecords = [HOLD_FILE, HOLD_BOUND_FILE, `${HOLD_BOUND_FILE}.staging`];
  for (const name of holdRecords) {
    const record = path.join(root, name);
    if (fs.existsSync(record) && !fs.lstatSync(record).isFile()) throw new Error('recovery hold record must be a regular file');
  }
  if (!fs.existsSync(path.join(root, MANIFEST_FILE)) && fs.readdirSync(root).some((name) => name !== LOCK_FILE && !holdRecords.includes(name))) {
    throw new Error('recovery destination holds unrelated files; choose an empty directory');
  }
}

function ensureContentDirectory(directory: string, complete = false): void {
  if (!fs.existsSync(directory)) {
    if (complete) throw new Error(`completed recovery artifact is missing directory ${directory}`);
    fs.mkdirSync(directory, { mode: OWNER_DIRECTORY_MODE });
    syncDirectory(path.dirname(directory));
  }
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`recovery content directory must not be a symlink: ${directory}`);
}

/**
 * What a destination records about the hold it took on its source.
 *
 * Two files, and neither is ever unlinked while it is the only record of a live hold:
 * - the intent, written once before the hold exists, carrying the token this destination will ever use. A crash right
 *   after it leaves a token that can be asked about; a crash right before it leaves no hold to lose.
 * - the bound receipt, written atomically once the source answered that this token is open, carrying the identity the
 *   source answered with. No snapshot is taken before it exists, so a resume always has something to compare.
 */
const holdIntentSchema = z.object({ token: z.string().uuid(), locator: z.string().min(1), createdAt: z.string().datetime() });
const holdSourceSchema = z.object({ deploymentId: z.string().min(1), schemaVersion: z.number().int().min(1) });
const holdBoundSchema = z.object({ token: z.string().uuid(), source: holdSourceSchema, boundAt: z.string().datetime() });
type RecoveryHoldIntent = z.infer<typeof holdIntentSchema>;
type RecoveryHoldBound = z.infer<typeof holdBoundSchema>;

/** Writes one new file so it survives a crash: exclusive, its bytes fsynced, then its directory. */
function durableFile(file: string, text: string): void {
  const fd = fs.openSync(file, 'wx', OWNER_FILE_MODE);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

/** Replaces a file in one step: a crash leaves the previous contents or the replacement in full, never a partial file. */
function durableReplace(file: string, text: string): void {
  const staged = `${file}.staging`;
  fs.rmSync(staged, { force: true });
  const fd = fs.openSync(staged, 'wx', OWNER_FILE_MODE);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(staged, file);
  syncDirectory(path.dirname(file));
}

function readHoldFile<T>(root: string, name: string, schema: { parse(value: unknown): T }): T | null {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new Error(`recovery hold record must be a regular file: ${name}`);
  return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
const readHoldIntent = (root: string): RecoveryHoldIntent | null => readHoldFile(root, HOLD_FILE, holdIntentSchema);
const readHoldBound = (root: string): RecoveryHoldBound | null => readHoldFile(root, HOLD_BOUND_FILE, holdBoundSchema);

/** How many times one step is tried, and how long to wait before each retry: `backoffMs[n]` precedes attempt n + 2. */
export interface RetryBound { attempts: number; backoffMs: readonly number[] }

/**
 * What a backup retries before it gives up.
 *
 * - `objectReads`: one object's read and store, retried only on a transient failure (`transientReadFailure`): a
 *   timeout, a reset or refused connection, or an HTTP 5xx or 429. Cloudflare pre-header connection failures and
 *   response timeouts use one elapsed network budget across this object's attempts; its exhaustion is terminal here.
 *   A missing object, a refused credential, a size or digest mismatch and a local disk error fail at once. The waits
 *   between this loop's attempts add up to a little under two minutes.
 * - `holdReads`: the reads that settle one hold question by its token, with a wait before each read after the first.
 * - `holdRounds`: how many times a hold question is asked again after its reads all went unanswered, or after the
 *   source answered a token this backup is opening absent. An opening round writes the same token again, which the
 *   source opens at most once, so a retry never takes a second hold; a resume's round only reads.
 * - `snapshots`: the whole database snapshot, captured again from an emptied work directory, only on a transient
 *   failure (`transientReadFailure`). Within one run, one count spans every step of the capture, and capturing again
 *   does not reset it; a later run starts its own count. The waits add up to a little over three minutes, so a provider
 *   API outage of a few minutes is ridden out inside one run.
 */
export interface RecoveryRetryPolicy { objectReads: RetryBound; holdReads: RetryBound; holdRounds: RetryBound; snapshots: RetryBound }
export const RECOVERY_RETRY: RecoveryRetryPolicy = {
  objectReads: { attempts: 6, backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000] },
  holdReads: { attempts: 3, backoffMs: [2_000, 5_000] },
  holdRounds: { attempts: 3, backoffMs: [5_000, 15_000] },
  snapshots: { attempts: 4, backoffMs: [15_000, 60_000, 120_000] },
};

const backoff = (bound: RetryBound, attempt: number): number => bound.backoffMs[Math.min(attempt - 1, bound.backoffMs.length - 1)] ?? 0;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** A failure's message on one line, short enough for a progress report: its start, and its end, where a cause is said. */
const briefly = (error: unknown): string => {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 80)} ... ${text.slice(-155)}` : text;
};
const described = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** What a refusal adds when the source refused the account or its credential on the last attempt, or nothing. */
const accountRefusal = (error: unknown): string => {
  const code = refusedAccountCode(error);
  return code === null ? '' : `; the source refused this account (code ${code}), so the credential or the account may be wrong`;
};

/**
 * How long the reads of one round may take together.
 *
 * Every owner operation answers or throws inside a window of its own — the hosted one kills its Wrangler child at
 * `D1_STATEMENT_TIMEOUT_MS`, the native one holds a bounded local read — so this bounds the sequence, not the awaits
 * inside it. Nothing here races an await it cannot stop: a mutation left running would keep opening or releasing a
 * hold no caller is waiting on.
 */
const HOLD_RECONCILE_MS = 180_000;

/** A hold question the source did not answer in any read of a round. */
class HoldUnanswered extends Error {}

/**
 * Asks the source about `token` until it answers, and answers what it says. A write whose answer was lost is exactly
 * this case: the statement may well have landed, so the token is asked about rather than replaced.
 */
async function reconcile(owner: RecoveryHoldOwner, token: string, report: (line: string) => void, reads: RetryBound): Promise<RecoveryHoldReading> {
  const deadline = Date.now() + HOLD_RECONCILE_MS;
  let last: unknown = new Error(`no attempt to read this backup's recovery hold was left inside ${Math.round(HOLD_RECONCILE_MS / 1000)} s`);
  for (let attempt = 1; attempt <= reads.attempts && Date.now() < deadline; attempt += 1) {
    if (attempt > 1) await pause(backoff(reads, attempt - 1));
    try {
      return await owner.inspect(token);
    } catch (error) {
      last = error;
      report(`The source did not answer about this backup's recovery hold (read ${attempt} of ${reads.attempts}): ${briefly(error)}`);
    }
  }
  throw new HoldUnanswered(`the source did not answer about this backup's recovery hold: ${described(last)}`, { cause: last });
}

/** The refusal for a hold question no round answered, naming how many rounds were asked. */
const unanswered = (error: unknown, rounds: number): Error => {
  const refused = accountRefusal(error);
  if (rounds === 1 && refused === '') return error as Error;
  const tries = rounds === 1 ? '' : ` after ${rounds} attempts`;
  return new Error(`the source did not answer about this backup's recovery hold${tries}: ${described((error as Error).cause ?? error)}${refused}`, { cause: error });
};

/** What the source holds for `token`, read again in later rounds while no read of a round is answered. */
async function readHold(owner: RecoveryHoldOwner, token: string, report: (line: string) => void, retry: RecoveryRetryPolicy): Promise<RecoveryHoldReading> {
  for (let round = 1; ; round += 1) {
    try {
      return await reconcile(owner, token, report, retry.holdReads);
    } catch (error) {
      if (!(error instanceof HoldUnanswered)) throw error;
      if (round >= retry.holdRounds.attempts) throw unanswered(error, round);
      const wait = backoff(retry.holdRounds, round);
      report(`Asking about this backup's recovery hold again in ${Math.round(wait / 1000)} s (attempt ${round + 1} of ${retry.holdRounds.attempts})`);
      await pause(wait);
    }
  }
}

/** The operator hold a source holds under another token, which keeps this one from opening, or null. */
async function conflictingHold(owner: RecoveryHoldOwner, token: string): Promise<{ token: string; acquiredAt: number } | null> {
  const open = await owner.open().catch(() => null);
  return open !== null && open.token !== token ? open : null;
}

/**
 * Opens `token` and answers what the source holds for it, whether or not the write itself answered.
 *
 * A write that failed or answered nothing is read back by the same token. A round whose reads all went unanswered, or
 * that the source answered absent, writes the same token again, up to `holdRounds` writes: the write may not have
 * reached the source, or may land after the read, and asking for the same token again opens it at most once. An
 * absent token while another operator hold is open refuses at once and names that hold, since a source holds one at a
 * time. Any other answer is returned at once.
 */
async function openAndReconcile(
  owner: RecoveryHoldOwner, token: string, report: (line: string) => void, retry: RecoveryRetryPolicy, target: RecoverySource['target'],
): Promise<RecoveryHoldReading & { attempts: number }> {
  const bound = retry.holdRounds;
  for (let attempt = 1; ; attempt += 1) {
    let answered: RecoveryHoldReading | null = null;
    try {
      answered = await owner.acquire(token);
    } catch (error) {
      report(`The recovery hold write did not answer (${briefly(error)}); reading the same token back rather than taking another hold`);
    }
    let reading: RecoveryHoldReading;
    try {
      reading = answered !== null && answered.state === 'open' ? answered : await reconcile(owner, token, report, retry.holdReads);
    } catch (error) {
      if (!(error instanceof HoldUnanswered)) throw error;
      if (attempt >= bound.attempts) throw unanswered(error, attempt);
      const wait = backoff(bound, attempt);
      report(`Asking the source to open this backup's recovery hold again, by the same token, in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${bound.attempts})`);
      await pause(wait);
      continue;
    }
    if (reading.state === 'absent') {
      const other = await conflictingHold(owner, token);
      if (other !== null) {
        throw new Error(`another backup's recovery hold ${other.token} has been open on the source since ${new Date(other.acquiredAt).toISOString()}, `
          + 'and a source holds one at a time; nothing was captured. Run that backup again to complete it, or give it up with '
          + `\`myco server recovery-hold --token ${other.token} --abandon --target ${target}\``);
      }
    }
    if (reading.state !== 'absent' || attempt >= bound.attempts) return { ...reading, attempts: attempt };
    const wait = backoff(bound, attempt);
    report(`The source answers this backup's recovery hold absent; asking for the same token again in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${bound.attempts})`);
    await pause(wait);
  }
}

/** The refusal for a hold the source would not open, naming how many writes were sent. */
function notOpened(reading: RecoveryHoldReading & { attempts: number }): Error {
  const tries = reading.attempts === 1 ? '' : ` after ${reading.attempts} attempts`;
  return new Error(`recovery hold was not opened on the source (${reading.state})${tries}; nothing was captured`);
}

/**
 * The Deployment a reading names, or a refusal.
 *
 * The one validator for every identity this file acts on: a source that answers nothing, or answers a shape this code
 * cannot read, is refused in every branch.
 */
function answeredSource(reading: RecoveryHoldReading): RecoveryHoldSource {
  const named = holdSourceSchema.safeParse(reading.source);
  if (!named.success) throw new Error('the source did not identify the Deployment its recovery hold belongs to; capture into a new directory');
  return named.data;
}

/** Binds this destination to the identity the source answered with, once, before anything is captured under it. */
function bindHold(root: string, token: string, reading: RecoveryHoldReading): RecoveryHoldBound {
  const bound: RecoveryHoldBound = { token, source: answeredSource(reading), boundAt: new Date().toISOString() };
  durableReplace(path.join(root, HOLD_BOUND_FILE), `${JSON.stringify(bound, null, 2)}\n`);
  return bound;
}

/** The identity a source answers with now, held to the one this destination bound. */
function assertBoundIdentity(bound: RecoveryHoldBound, reading: RecoveryHoldReading): void {
  const answered = answeredSource(reading);
  if (answered.deploymentId !== bound.source.deploymentId || answered.schemaVersion !== bound.source.schemaVersion) {
    throw new Error('the source is no longer the Deployment this backup was bound to; capture into a new directory');
  }
}

/**
 * The captured database is the Deployment this destination was admitted to hold, and carries this backup's hold.
 *
 * The snapshot's own hold row decides: exactly this destination's token, `holder = 'operator'`, `released_at IS NULL`,
 * alongside the Deployment and schema version the receipt bound. The row is frozen in the copy, so the same check
 * holds for the initial capture, every resume and the completed artifact. A live reading admits the hold before
 * anything is captured; it says nothing about bytes already taken.
 */
function assertSnapshotHold(db: Database, facts: { deploymentId: string; schemaVersion: number }, held: { token: string; bound: RecoveryHoldBound } | null): void {
  if (held === null) return;
  if (facts.deploymentId !== held.bound.source.deploymentId || facts.schemaVersion !== held.bound.source.schemaVersion) {
    throw new Error('this snapshot is not of the Deployment its recovery hold was bound to; capture into a new directory');
  }
  const row = db.query<{ holder: string | null; released_at: number | null }, [string]>(
    'SELECT holder, released_at FROM recovery_holds WHERE token = ?').get(held.token) ?? null;
  if (row === null) throw new Error("this snapshot carries no recovery hold of this backup's own token; capture into a new directory");
  if (row.holder !== 'operator') throw new Error("this snapshot's own recovery hold is not an operator hold; capture into a new directory");
  if (row.released_at !== null) throw new Error("this snapshot was taken after its own recovery hold was released; capture into a new directory");
}

/**
 * The hold that protects this destination's snapshot, in whatever state the destination is in:
 * - no record and no snapshot: record the intent, open the hold, read it back, and bind the identity it answered with;
 * - a record and an open hold: adopt it, once the source still answers the identity this destination bound. A hold
 *   adopted with no bound identity yet binds one now, and only while no snapshot exists;
 * - a record whose hold is absent and no snapshot yet: open the same token again, which is why the record comes first;
 * - a record whose hold is gone, released, or another holder's, with a snapshot already taken: refuse. Deletions may
 *   have run, so this snapshot cannot be completed, and a new directory is the answer. A hold is never reopened over a
 *   saved snapshot, and an identity is never bound after one;
 * - a completed artifact: nothing is captured, and the hold is only read, so the artifact can be verified as it stands.
 *
 * A receipt this destination already wrote decides before anything is opened or captured, and again on the answer the
 * source gives: whatever state the hold is in, a source that does not answer the bound identity is a different
 * Deployment, and the receipt is never rewritten to make one fit. What the capture itself is held to is the hold row
 * the snapshot carries, which is checked where the snapshot is read.
 */
async function heldForSnapshot(
  root: string, owner: RecoveryHoldOwner, snapshotTaken: boolean, complete: boolean, report: (line: string) => void,
  retry: RecoveryRetryPolicy, target: RecoverySource['target'],
): Promise<{ token: string; bound: RecoveryHoldBound } | null> {
  const recorded = readHoldIntent(root);
  if (recorded !== null && recorded.locator !== owner.locator) throw new Error('recovery destination holds a recovery hold of another Deployment');
  const bound = readHoldBound(root);
  if (bound !== null && recorded !== null && bound.token !== recorded.token) throw new Error("recovery destination's recovery hold records disagree; capture into a new directory");
  if (complete) return recorded === null || bound === null ? null : { token: recorded.token, bound };
  if (recorded === null) {
    if (snapshotTaken) throw new Error('recovery destination holds a snapshot taken with no recovery hold; capture into a new directory');
    const token = crypto.randomUUID();
    durableFile(path.join(root, HOLD_FILE), `${JSON.stringify({ token, locator: owner.locator, createdAt: new Date().toISOString() } satisfies RecoveryHoldIntent, null, 2)}\n`);
    const reading = await openAndReconcile(owner, token, report, retry, target);
    if (reading.state !== 'open') throw notOpened(reading);
    report('Holding every object this snapshot names on the source until the artifact completes');
    return { token, bound: bindHold(root, token, reading) };
  }
  const reading = await readHold(owner, recorded.token, report, retry);
  if (bound !== null) assertBoundIdentity(bound, reading);
  if (reading.state === 'open') {
    if (bound !== null) {
      report('Resuming under the recovery hold this destination already took');
      return { token: recorded.token, bound };
    }
    // The hold exists but its identity was never bound: a write whose answer was lost. Binding is only safe before a
    // snapshot, because a snapshot taken under an unbound hold cannot be held to any identity afterwards.
    if (snapshotTaken) throw new Error('this destination holds a snapshot taken before its recovery hold was bound to a source; capture into a new directory');
    return { token: recorded.token, bound: bindHold(root, recorded.token, reading) };
  }
  if (snapshotTaken) throw new Error(`the recovery hold protecting this snapshot is ${reading.state}; capture into a new directory`);
  if (reading.state !== 'absent') throw new Error(`this destination's recovery hold is ${reading.state}; capture into a new directory`);
  const reopened = await openAndReconcile(owner, recorded.token, report, retry, target);
  if (reopened.state !== 'open') throw notOpened(reopened);
  if (bound !== null) {
    assertBoundIdentity(bound, reopened);
    return { token: recorded.token, bound };
  }
  return { token: recorded.token, bound: bindHold(root, recorded.token, reopened) };
}

/** What became of the hold a completed artifact no longer needs. */
export type RecoveryHoldOutcome = { released: true } | { released: false; state: RecoveryHoldReading['state'] | 'unanswered'; reason: string };

/**
 * Releases the hold a completed artifact no longer needs. The artifact is already whole and verified by the time this
 * runs, so an unresolved release never unmakes it: it is reported as unresolved, and running the same command again, or
 * `myco server recovery-hold`, reconciles the same token.
 */
async function releaseHeld(
  owner: RecoveryHoldOwner, held: { token: string; bound: RecoveryHoldBound }, report: (line: string) => void, retry: RecoveryRetryPolicy,
): Promise<RecoveryHoldOutcome> {
  const before = await reconcile(owner, held.token, report, retry.holdReads).catch((error: unknown) => error as Error);
  if (before instanceof Error) return { released: false, state: 'unanswered', reason: before.message };
  if (before.state === 'released') return { released: true };
  if (before.state !== 'open') return { released: false, state: before.state, reason: `the source answered ${before.state} for this backup's recovery hold` };
  try {
    assertBoundIdentity(held.bound, before);
  } catch (error) {
    return { released: false, state: before.state, reason: (error as Error).message };
  }
  let answered: RecoveryHoldReading | null = null;
  try {
    answered = await owner.release(held.token, 'complete');
  } catch {
    report('The recovery hold release did not answer; reading the same token back');
  }
  const after = answered !== null && answered.state === 'released' ? answered : await reconcile(owner, held.token, report, retry.holdReads).catch((error: unknown) => error as Error);
  if (after instanceof Error) return { released: false, state: 'unanswered', reason: after.message };
  if (after.state === 'released') return { released: true };
  return { released: false, state: after.state, reason: `the source still answers ${after.state} for this backup's recovery hold` };
}

/** What the backup in `destination` holds on its source, read without changing either. */
export async function recoveryHoldOfDestination(destination: string, owner: RecoveryHoldOwner): Promise<{ token: string; state: RecoveryHoldReading['state']; bound: boolean; sourceMatchesBinding: boolean }> {
  const root = path.resolve(destination);
  const recorded = readHoldIntent(root);
  if (recorded === null) throw new Error('this recovery destination recorded no recovery hold');
  if (recorded.locator !== owner.locator) throw new Error('this recovery destination recorded a recovery hold of another Deployment');
  const bound = readHoldBound(root);
  const reading = await owner.inspect(recorded.token);
  return {
    token: recorded.token,
    state: reading.state,
    bound: bound !== null,
    sourceMatchesBinding: bound === null ? false
      : reading.source?.deploymentId === bound.source.deploymentId && reading.source.schemaVersion === bound.source.schemaVersion,
  };
}

/**
 * Gives up the hold a destination took, releasing exactly the token it recorded. A producer's hold is never released
 * here: the source refuses it, and so does this. An unanswered release is reconciled by reading the same token back.
 */
export async function abandonRecoveryHold(destination: string, owner: RecoveryHoldOwner, report: (line: string) => void = () => {}): Promise<{ token: string; state: RecoveryHoldReading['state'] }> {
  const root = path.resolve(destination);
  const recorded = readHoldIntent(root);
  if (recorded === null) throw new Error('this recovery destination recorded no recovery hold');
  if (recorded.locator !== owner.locator) throw new Error('this recovery destination recorded a recovery hold of another Deployment');
  let answered: RecoveryHoldReading | null = null;
  try {
    answered = await owner.release(recorded.token, 'abandoned');
  } catch {
    report('The recovery hold release did not answer; reading the same token back');
  }
  const after = answered !== null && answered.state === 'released' ? answered : await reconcile(owner, recorded.token, report, RECOVERY_RETRY.holdReads);
  return { token: recorded.token, state: after.state };
}

/**
 * `body`, read through a reader the copy loop keeps, so a store that fails while it holds the stream it was given can
 * still have the source's read ended: the source's request is released as soon as its bytes can no longer land.
 */
function readerKept(body: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; end(reason: unknown): Promise<void> } {
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
  return { stream, end: (reason) => reader.cancel(reason).catch(() => {}) };
}

/**
 * The database snapshot, captured into `incoming` inside a work directory emptied before every attempt, so no attempt
 * reads a file an earlier one left behind. An attempt is the adapter's whole capture, so whatever it compares is read
 * inside that one attempt. A transient failure is captured again after `bound`'s wait, up to its attempts; any other
 * failure ends the capture at once.
 */
async function captureSnapshot(
  adapter: RecoveryAdapter, incoming: string, workDir: string, report: (line: string) => void, bound: RetryBound, holdToken: string | null,
): Promise<RecoverySnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { mode: OWNER_DIRECTORY_MODE });
    try {
      return await adapter.snapshot(incoming, workDir, holdToken);
    } catch (error) {
      if (!transientReadFailure(error) || attempt >= bound.attempts) {
        if (attempt === 1 && accountRefusal(error) === '') throw error;
        const tries = attempt === 1 ? '' : ` after ${attempt} attempts`;
        throw new Error(`the database snapshot was not captured${tries}: ${described(error)}${accountRefusal(error)}`, { cause: error });
      }
      const wait = backoff(bound, attempt);
      report(`Capturing the database snapshot failed (${briefly(error)}); starting it again in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${bound.attempts})`);
      await pause(wait);
    }
  }
}

/**
 * A capture refused before it read anything, so the hold opened for it protects nothing yet: its source said no
 * snapshot may be taken now (another export holds the database, say). The hold is released as abandoned rather than
 * left open, where it would defer the source's own backups and its deletions for nothing.
 */
export class CaptureRefusedBeforeSnapshot extends Error {}

/** Whether `error`, or a failure it carries, is a capture refused before it read anything. */
function refusedBeforeSnapshot(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth <= 3 && current instanceof Error; current = current.cause, depth += 1) {
    if (current instanceof CaptureRefusedBeforeSnapshot) return true;
  }
  return false;
}

/**
 * Give up the hold of a capture refused before its snapshot, and say so on the refusal. Released, the destination's
 * hold records go too, so the next run opens a hold of its own; unreleased, the refusal names the command that gives
 * the hold up.
 */
async function releaseRefusedHold(root: string, owner: RecoveryHoldOwner, report: (line: string) => void, target: RecoverySource['target'], error: Error): Promise<Error> {
  const token = readHoldIntent(root)?.token ?? null;
  const released = await abandonRecoveryHold(root, owner, report).then((answered) => answered.state === 'released', () => false);
  if (released) {
    for (const name of [HOLD_FILE, HOLD_BOUND_FILE, `${HOLD_BOUND_FILE}.staging`]) fs.rmSync(path.join(root, name), { force: true });
    syncDirectory(root);
    return new Error(`${error.message}; this backup's recovery hold was released, since it protected nothing yet`, { cause: error });
  }
  return new Error(`${error.message}; this backup's recovery hold${token === null ? '' : ` ${token}`} is still open, and defers the source's own backups while it is: `
    + `give it up with \`myco server recovery-hold${token === null ? '' : ` --token ${token}`} --abandon --target ${target}\``, { cause: error });
}

/** One writer owns snapshot publication, content verification and the final completion manifest on both targets. */
async function writeRecoveryBundle(
  destination: string, adapter: RecoveryAdapter, report: (line: string) => void, seed?: RecoveryManifest, retry: RecoveryRetryPolicy = RECOVERY_RETRY,
): Promise<RecoveryManifest> {
  const root = path.resolve(destination);
  assertOwnedDirectory(root);
  const held = LifecycleLock.acquire(path.join(root, LOCK_FILE), { command: 'myco server backup' });
  if (!held.acquired) throw new Error('another backup owns this recovery destination');
  try {
    assertOwnedDirectory(root);
    fs.chmodSync(root, OWNER_DIRECTORY_MODE);
    let manifest = readManifest(root);
    if (manifest !== null && (manifest.source.target !== adapter.source.target || manifest.source.locator !== adapter.source.locator)) {
      throw new Error('recovery destination belongs to another Deployment');
    }
    if (manifest !== null && manifest.source.receipt !== adapter.source.receipt) {
      throw new Error('recovery destination holds a different snapshot of this Deployment');
    }
    if (seed !== undefined && manifest?.snapshot !== undefined
      && (JSON.stringify(manifest.snapshot) !== JSON.stringify(seed.snapshot)
        || JSON.stringify(manifest.format === 'myco-recovery/2' ? manifest.backupObjects : [])
          !== JSON.stringify(seed.format === 'myco-recovery/2' ? seed.backupObjects : []))) {
      throw new Error('recovery copy belongs to a different source snapshot');
    }
    if (manifest === null) {
      manifest = { format: 'myco-recovery/2', source: sourceSchema.parse(adapter.source), startedAt: new Date().toISOString(), status: 'snapshot',
        backupObjects: seed?.format === 'myco-recovery/2' ? [...seed.backupObjects] : [],
        ...(seed === undefined ? {} : { snapshot: seed.snapshot }) };
      writeManifest(root, manifest);
    }
    const databasePath = path.join(root, DATABASE_FILE);
    const workDir = path.join(root, SNAPSHOT_DIRECTORY);
    // The source's hold comes before the snapshot: every object the snapshot names is protected from deletion until
    // this artifact holds its own copy. A destination whose hold is gone with a snapshot already taken refuses here.
    const held = adapter.hold === undefined
      ? null
      : await heldForSnapshot(root, adapter.hold, manifest.status !== 'snapshot', manifest.status === 'complete', report, retry, adapter.source.target);
    if (manifest.status === 'snapshot') {
      report('Capturing the database snapshot');
      const incoming = path.join(workDir, DATABASE_FILE);
      let captured: RecoverySnapshot;
      try {
        captured = await captureSnapshot(adapter, incoming, workDir, report, retry.snapshots, held?.token ?? null);
      } catch (error) {
        if (held !== null && adapter.hold !== undefined && error instanceof Error && refusedBeforeSnapshot(error)) {
          throw await releaseRefusedHold(root, adapter.hold, report, adapter.source.target, error);
        }
        throw error;
      }
      const db = openSnapshot(incoming);
      let facts;
      try {
        facts = snapshotFacts(db);
        assertSnapshotHold(db, facts, held);
      } finally { db.close(); }
      const snapshot = snapshotSchema.parse({ ...captured, ...facts, database: await fingerprintFile(incoming), capturedAt: seed?.snapshot?.capturedAt ?? new Date().toISOString() });
      fs.chmodSync(incoming, OWNER_FILE_MODE);
      syncFile(incoming);
      fs.renameSync(incoming, databasePath);
      syncFile(databasePath);
      manifest = { ...manifest, status: 'content', snapshot };
      writeManifest(root, manifest);
    }
    const snapshot = manifest.snapshot!;
    if (!sameFingerprint(await fingerprintFile(databasePath), snapshot.database)) throw new Error('recovery database no longer matches its manifest');
    const store = diskBlobStore(path.join(root, 'blobs'));
    ensureContentDirectory(workDir);
    ensureContentDirectory(path.join(root, 'blobs'), manifest.status === 'complete');
    const db = openSnapshot(databasePath);
    try {
      const facts = snapshotFacts(db);
      if (facts.deploymentId !== snapshot.deploymentId || facts.schemaVersion !== snapshot.schemaVersion
        || facts.blobCount !== snapshot.blobCount || facts.blobBytes !== snapshot.blobBytes) throw new Error('recovery manifest does not describe its database');
      assertSnapshotHold(db, facts, held);
      const complete = manifest.status === 'complete';
      /**
       * One object read from the source and stored, retried on a transient failure. The store publishes an object under
       * its key only once every byte arrived and its digest holds, so a failed attempt leaves nothing a retry or a later
       * resume would accept.
       */
      const readAndStore = async (blob: RecoverySourceObject): Promise<{ size: number }> => {
        const bound = retry.objectReads;
        for (let attempt = 1; ; attempt += 1) {
          let body: ReturnType<typeof readerKept> | undefined;
          try {
            body = readerKept(await adapter.blob(blob, workDir));
            return await store.put(blob.key, body.stream, 'sha256' in blob ? { sha256: blob.sha256 } : undefined);
          } catch (error) {
            await body?.end(error);
            if (!transientReadFailure(error) || attempt >= bound.attempts) {
              const tries = attempt === 1 ? '' : ` after ${attempt} attempts`;
              throw new Error(`recovery object ${blob.key} was not stored${tries}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            const wait = backoff(bound, attempt);
            report(`Reading ${blob.key} failed (${briefly(error)}); trying again in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${bound.attempts})`);
            await pause(wait);
          }
        }
      };
      const copyObject = async (blob: RecoverySourceObject, progress: string): Promise<RecoveryBlob> => {
        const file = blobPath(root, blob);
        ensureContentDirectory(path.dirname(file), complete);
        if (fs.existsSync(file)) {
          const held = await fingerprintFile(file);
          if ('sha256' in blob && sameFingerprint(held, blob)) return { key: blob.key, ...held };
          if (complete) throw new Error(`completed recovery blob no longer matches its manifest: ${blob.key}`);
          await store.delete(blob.key);
        }
        if (complete) throw new Error(`completed recovery artifact is missing blob ${blob.key}`);
        report(progress);
        const stored = await readAndStore(blob);
        if (stored.size !== blob.bytes) { await store.delete(blob.key); throw new Error(`recovery blob has an unexpected size: ${blob.key}`); }
        fs.chmodSync(file, OWNER_FILE_MODE);
        syncFile(file);
        return { key: blob.key, ...('sha256' in blob ? { sha256: blob.sha256, bytes: blob.bytes } : await fingerprintFile(file)) };
      };
      const backups = cataloguedBackups(db);
      const expected = new Map(backups.map((backup) => [backup.key, backup]));
      if (expected.size !== backups.length) throw new Error('recovery backup coverage has duplicate catalogued keys');
      if (manifest.format === 'myco-recovery/2') {
        const receipts = manifest.backupObjects;
        const matchesCatalogue = (receipt: RecoveryBlob): boolean => {
          const catalogued = expected.get(receipt.key);
          return catalogued !== undefined && catalogued.bytes === receipt.bytes
            && (catalogued.sha256 === null || catalogued.sha256 === receipt.sha256);
        };
        if (new Set(receipts.map((receipt) => receipt.key)).size !== receipts.length
          || !receipts.every(matchesCatalogue)
          || (manifest.status === 'complete' && receipts.length !== backups.length)) {
          throw new Error('recovery backup coverage does not match its database');
        }
        const undigested = backups.filter((backup) => backup.sha256 === null).length;
        if (undigested > 0) {
          report(`${undigested} catalogued backup object${undigested === 1 ? ' has' : 's have'} no digest recorded at creation; ${undigested === 1 ? 'its copy is' : 'their copies are'} checked by size only`);
        }
      } else if (backups.length > 0) {
        report(`${backups.length} catalogued backup object${backups.length === 1 ? ' is' : 's are'} outside this legacy artifact; create a new artifact for complete object coverage`);
      }
      let index = 0;
      for (const row of registeredObjects(db)) {
        await copyObject(row, `Copying blob ${++index} of ${snapshot.blobCount}`);
      }
      if (manifest.format === 'myco-recovery/2') {
        for (const [index, backup] of backups.entries()) {
          const receipt = manifest.backupObjects.find((held) => held.key === backup.key);
          const object = receipt ?? expectedBackupObject(backup);
          const copied = await copyObject({ ...object, source: object.key }, `Copying catalogued backup ${index + 1} of ${backups.length}`);
          if (receipt === undefined) {
            manifest.backupObjects.push(copied);
            writeManifest(root, manifest);
          }
        }
      }
    } finally { db.close(); }
    fs.rmSync(workDir, { recursive: true, force: true });
    await sweepPartialObjects(path.join(root, 'blobs'));
    if (manifest.status !== 'complete') {
      manifest = { ...manifest, status: 'complete', completedAt: new Date().toISOString() };
      writeManifest(root, manifest);
    }
    // The artifact is whole, so the source's objects are no longer this copy's concern. A release whose answer is lost
    // is settled by running this command again on the completed directory, or by the abandon command.
    if (adapter.hold !== undefined && held !== null) {
      const outcome = await releaseHeld(adapter.hold, held, report, retry);
      if (outcome.released) report('Released the recovery hold: every object this artifact holds is now its own copy');
      else {
        report(`This artifact is complete and verified, but its recovery hold is unresolved: ${outcome.reason}.`);
        report('Deletions on the source stay deferred until it is released; run this command again, or `myco server recovery-hold`, to reconcile it.');
      }
    }
    return manifest;
  } finally { held.lock.release(); }
}

export async function createRecoveryBundle(
  destination: string, adapter: RecoveryAdapter, report: (line: string) => void = () => {}, retry: RecoveryRetryPolicy = RECOVERY_RETRY,
): Promise<RecoveryManifest> {
  return writeRecoveryBundle(destination, adapter, report, undefined, retry);
}

/** Verify a completed artifact using its own source identity, without consulting the source Deployment. */
export async function verifyRecoveryBundle(directory: string, report: (line: string) => void = () => {}): Promise<RecoveryManifest> {
  const root = path.resolve(directory);
  const manifest = readManifest(root);
  if (manifest?.status !== 'complete') throw new Error('recovery requires a completed artifact');
  const unavailable = async (): Promise<never> => { throw new Error('completed recovery artifact requires unavailable source content'); };
  return createRecoveryBundle(root, { source: manifest.source, snapshot: unavailable, blob: unavailable }, report);
}

/** Copy or resume a verified snapshot through the same owner that captures Deployment artifacts. */
async function completeRecoverySource(source: string, report: (line: string) => void): Promise<RecoveryManifest> {
  const manifest = await verifyRecoveryBundle(source, report);
  const database = path.join(source, DATABASE_FILE);
  const db = openSnapshot(database);
  try {
    if (manifest.format === 'myco-recovery/1' && db.query('SELECT 1 FROM backups LIMIT 1').get() !== null) {
      throw new Error('legacy artifact lacks catalogued backup coverage; capture a new recovery artifact');
    }
  } finally { db.close(); }
  return manifest;
}

/** Copy or resume a verified snapshot through the same owner that captures Deployment artifacts. */
export async function copyRecoveryBundle(source: string, destination: string, report: (line: string) => void = () => {}): Promise<RecoveryManifest> {
  const manifest = await completeRecoverySource(source, report);
  const database = path.join(source, DATABASE_FILE);
  const blobs = diskBlobStore(path.join(source, 'blobs'));
  return writeRecoveryBundle(destination, {
    source: manifest.source,
    snapshot: async (file) => {
      fs.copyFileSync(database, file, fs.constants.COPYFILE_EXCL);
      if (!sameFingerprint(await fingerprintFile(file), manifest.snapshot!.database)) throw new Error('source recovery database changed during copy');
      return manifest.snapshot!;
    },
    blob: async (object) => {
      const held = await blobs.get(object.key);
      if (held === null) throw new Error(`source recovery artifact is missing object ${object.key}`);
      return held.body;
    },
  }, report, manifest);
}

export interface RecoveryObjectDestination {
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, body: () => Blob): Promise<void>;
}

/**
 * The stored-object key each blob of a prepared restore database registers, by logical artifact key. The prepared
 * copy decides where the destination holds each blob; a row outside the stored grammar refuses.
 */
export function preparedObjectKeys(file: string): Map<string, { objectKey: string; bytes: number }> {
  const db = new Database(file, { readonly: true, create: false });
  try {
    const keys = new Map<string, { objectKey: string; bytes: number }>();
    for (const row of registeredObjects(db)) keys.set(row.key, { objectKey: row.source, bytes: row.bytes });
    return keys;
  } finally { db.close(); }
}

/**
 * Copy missing objects and verify persisted bytes; existing different content is never overwritten. Each registered
 * blob is written under the key `objectKeys` names for it, which the prepared destination database registers; an
 * artifact blob the prepared database does not register identically refuses before any byte is written.
 */
export async function copyRecoveryObjects(
  source: string, destination: RecoveryObjectDestination, objectKeys: ReadonlyMap<string, { objectKey: string; bytes: number }>,
  report: (line: string) => void = () => {},
): Promise<{ copied: number; reused: number }> {
  const manifest = await completeRecoverySource(source, report);
  const result = { copied: 0, reused: 0 };
  const matches = async (body: ReadableStream<Uint8Array>, object: RecoveryBlob): Promise<boolean> => {
    const hash = createHash('sha256');
    let bytes = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > object.bytes) { await reader.cancel(); return false; }
        hash.update(chunk.value);
      }
      return sameFingerprint({ bytes, sha256: hash.digest('hex') }, object);
    } catch (error) {
      await reader.cancel(error);
      throw error;
    } finally { reader.releaseLock(); }
  };
  const copy = async (object: RecoveryBlob, target: string) => {
    const existing = await destination.get(target);
    if (existing !== null) {
      if (!await matches(existing, object)) throw new Error(`recovery destination holds different bytes for ${object.key}`);
      result.reused++;
    } else {
      const file = blobPath(source, object);
      if (!sameFingerprint(await fingerprintFile(file), object)) throw new Error('source recovery object changed during transfer');
      await destination.put(target, () => Bun.file(file));
      const persisted = await destination.get(target);
      if (persisted === null || !await matches(persisted, object)) throw new Error(`recovery object failed persisted verification: ${object.key}`);
      result.copied++;
    }
    report(`Verified recovery object ${result.copied + result.reused}`);
  };
  const db = openSnapshot(path.join(source, DATABASE_FILE));
  try {
    const registered = [...registeredObjects(db)];
    const unmatched = registered.filter((row) => objectKeys.get(row.key)?.bytes !== row.bytes).length;
    if (unmatched > 0 || objectKeys.size !== registered.length) {
      throw new Error('prepared recovery database does not register the artifact\'s blobs; no object was written');
    }
    for (const { source: _source, ...row } of registered) await copy(row, objectKeys.get(row.key)!.objectKey);
    if (manifest.format === 'myco-recovery/2') for (const object of manifest.backupObjects) await copy(object, object.key);
  } finally { db.close(); }
  if (!sameFingerprint(await fingerprintFile(path.join(source, DATABASE_FILE)), manifest.snapshot!.database)) {
    throw new Error('source recovery database changed during object transfer');
  }
  return result;
}
