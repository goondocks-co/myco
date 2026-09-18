/**
 * The hosted recovery producer's checkpoint authority: one Durable Object holding every durable fact of one attempt
 * in its own SQLite storage, while the Deployment's database is unavailable to queries for as long as it exports.
 *
 * It holds no alarm. The Deployment's clock is the only alarm owner, and it calls `continue` before it reads
 * storage, so an attempt advances even while the source is paused and resumes after a reset. `continue` never opens
 * an attempt: admission reads the Deployment and belongs to the wake's ordinary jobs.
 *
 * Admission and continuation mutate one attempt, so both run one at a time through this object's own gate, and
 * overlapping continuations share the one step in flight rather than each starting an export of its own. An attempt
 * appears only once its schema and open manifest are staged, so no continuation can advance a half-prepared one.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  ADVANCING_STAGES_SQL, continueAttempt, failAttempt, freshScan, HoldRetired, PRODUCER_LIMITS, PRODUCER_STALL_MS, publishAttempt, reconcileUnconfirmed, settlementOf, stagedSqlKey,
  type AttemptCheckpoint, type AttemptObject, type AttemptPart, type AttemptState, type ContinuationReport, type HoldSettlement,
  type ProducerLimits, type RecoveryProducerStatus, type ScanProgress, type TableDefinitions,
} from '../../core/recovery-producer.js';
import { CHECKPOINT_STATEMENT_CHARS, newInventoryProgress, within, type SavedDigest } from '../../core/recovery-inventory.js';
import type { StatementScan } from '../../core/sql-statements.js';
import { serialGate } from '../../core/serial-gate.js';
import {
  admittedStarter, boundRecoveryConfiguration, cloudflareProducerPorts, R2_MINIMUM_PART_BYTES, recordedAdmission, STAGING_TARGET,
  type RecoveryAdmissionWire, type StagingBucket,
} from './recovery-export.js';
import type { CloudflareBindings } from './env.js';

/** Raised inside admission's transaction when another step already admitted an attempt carrying this token. */
class HoldCarried extends Error {}

/** The one producer a Deployment keeps. */
export const PRODUCER_NAME = 'recovery';

interface AttemptRow {
  id: number; stage: string; prefix: string; started_at: number; error: string | null; attempts: number;
  bookmark: string | null; polls: number; export_started_at: number | null; export_completed_at: number | null;
  re_exports: number; sql_bytes: number | null; sql_etag: string | null; upload_id: string | null;
  download_offset: number; reconcile_offset: number; reconciled: number; locator: string; tables: string;
  schema_sha256: string; schema_bytes: number; captured: string; defined: string; scan: string; scan_bytes: string;
  inventory_started_at: number | null; inventory_parts: number; inventory_bytes: number; inventory_scan: string;
  inventory_scan_bytes: string; inventory_digest: string | null; database_sha256: string | null;
  database_bytes: number | null; copy_started_at: number | null; completed_at: number | null; admission: string | null;
  hold_token: string | null; last_progress_at: number | null;
}

interface ObjectRow {
  key: string; source: string | null; bytes: number; sha256: string | null; staged_sha256: string | null; staged_bytes: number | null;
}

const objectOf = (row: ObjectRow): AttemptObject => ({
  // A row recorded before sources were recorded names an object stored under its key.
  key: row.key, source: row.source ?? row.key, bytes: row.bytes, sha256: row.sha256, stagedSha256: row.staged_sha256, stagedBytes: row.staged_bytes,
});

const COLUMN: Record<keyof AttemptState, string> = {
  id: 'id', stage: 'stage', prefix: 'prefix', startedAt: 'started_at', error: 'error', attempts: 'attempts',
  bookmark: 'bookmark', polls: 'polls', exportStartedAt: 'export_started_at', exportCompletedAt: 'export_completed_at',
  reExports: 're_exports', sqlBytes: 'sql_bytes', sqlEtag: 'sql_etag', uploadId: 'upload_id',
  downloadOffset: 'download_offset', reconcileOffset: 'reconcile_offset', reconciled: 'reconciled',
  tables: 'tables', captured: 'captured', defined: 'defined', scan: 'scan', scanBytes: 'scan_bytes',
  inventoryStartedAt: 'inventory_started_at', inventoryParts: 'inventory_parts', inventoryBytes: 'inventory_bytes',
  inventoryScan: 'inventory_scan', inventoryScanBytes: 'inventory_scan_bytes', inventoryDigest: 'inventory_digest',
  databaseSha256: 'database_sha256', databaseBytes: 'database_bytes', copyStartedAt: 'copy_started_at',
  completedAt: 'completed_at', admission: 'admission',
};

/**
 * Columns an existing attempts table gains, as one idempotent step. A Deployment whose object already holds attempts
 * keeps every row: a settled export-only attempt stays exactly as it rests.
 */
const ADDED_COLUMNS: readonly [string, string][] = [
  ['inventory_started_at', 'INTEGER'],
  ['inventory_parts', 'INTEGER NOT NULL DEFAULT 0'],
  ['inventory_bytes', 'INTEGER NOT NULL DEFAULT 0'],
  ['inventory_scan', "TEXT NOT NULL DEFAULT ''"],
  ['inventory_scan_bytes', "TEXT NOT NULL DEFAULT ''"],
  ['inventory_digest', 'TEXT'],
  ['database_sha256', 'TEXT'],
  ['database_bytes', 'INTEGER'],
  ['copy_started_at', 'INTEGER'],
  ['completed_at', 'INTEGER'],
  ['admission', 'TEXT'],
  ['hold_token', 'TEXT'],
  ['last_progress_at', 'INTEGER'],
];

/** Columns holding a list or a record are written as JSON text, so one update path serves every field. */
const JSON_COLUMNS = new Set<keyof AttemptState>([
  'tables', 'captured', 'defined', 'scan', 'inventoryScan', 'inventoryDigest', 'admission',
]);

const stateOf = (row: AttemptRow): AttemptState => ({
  id: row.id, stage: row.stage as AttemptState['stage'], prefix: row.prefix, startedAt: row.started_at,
  error: row.error as AttemptState['error'], attempts: row.attempts, bookmark: row.bookmark, polls: row.polls,
  exportStartedAt: row.export_started_at, exportCompletedAt: row.export_completed_at, reExports: row.re_exports,
  sqlBytes: row.sql_bytes, sqlEtag: row.sql_etag, uploadId: row.upload_id,
  downloadOffset: row.download_offset, reconcileOffset: row.reconcile_offset, reconciled: row.reconciled,
  tables: JSON.parse(row.tables) as string[], captured: JSON.parse(row.captured) as TableDefinitions,
  defined: JSON.parse(row.defined) as TableDefinitions, scan: JSON.parse(row.scan) as StatementScan,
  scanBytes: row.scan_bytes,
  inventoryStartedAt: row.inventory_started_at, inventoryParts: row.inventory_parts,
  inventoryBytes: row.inventory_bytes,
  // A row an earlier attempts table wrote carries no inventory scan of its own, and reads as one not yet started.
  inventoryScan: row.inventory_scan === '' ? newInventoryProgress().scan : JSON.parse(row.inventory_scan) as StatementScan,
  inventoryScanBytes: row.inventory_scan_bytes,
  inventoryDigest: row.inventory_digest === null ? null : JSON.parse(row.inventory_digest) as SavedDigest,
  databaseSha256: row.database_sha256, databaseBytes: row.database_bytes, copyStartedAt: row.copy_started_at,
  completedAt: row.completed_at,
  // An attempt admitted before admissions were recorded carries none.
  admission: row.admission === null ? null : JSON.parse(row.admission) as AttemptState['admission'],
});

export class RecoveryProducer extends DurableObject<CloudflareBindings> {
  /** One mutation of this attempt at a time, and one continuation shared by the wakes that overlap it. */
  private readonly gate = serialGate();

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT NOT NULL, prefix TEXT NOT NULL, locator TEXT NOT NULL,
      started_at INTEGER NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      bookmark TEXT, polls INTEGER NOT NULL DEFAULT 0, export_started_at INTEGER, export_completed_at INTEGER,
      re_exports INTEGER NOT NULL DEFAULT 0, sql_bytes INTEGER, sql_etag TEXT, upload_id TEXT,
      download_offset INTEGER NOT NULL DEFAULT 0, reconcile_offset INTEGER NOT NULL DEFAULT 0,
      reconciled INTEGER NOT NULL DEFAULT 0, tables TEXT NOT NULL DEFAULT '[]',
      schema_sha256 TEXT NOT NULL DEFAULT '', schema_bytes INTEGER NOT NULL DEFAULT 0,
      captured TEXT NOT NULL DEFAULT '{}', defined TEXT NOT NULL DEFAULT '{}',
      scan TEXT NOT NULL, scan_bytes TEXT NOT NULL DEFAULT '')`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS parts (
      attempt INTEGER NOT NULL, part INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, etag TEXT NOT NULL,
      PRIMARY KEY (attempt, part))`);
    // One row per object, so no checkpoint value grows with the inventory the export names.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS objects (
      attempt INTEGER NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT,
      staged_sha256 TEXT, staged_bytes INTEGER, registered INTEGER NOT NULL,
      PRIMARY KEY (attempt, key))`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_objects_pending ON objects (attempt, staged_sha256, registered)');
    // A hold token no attempt carries, retired once: admission refuses it for ever after.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS retired_hold_tokens (token TEXT PRIMARY KEY, retired_at INTEGER NOT NULL)');
    const held = new Set((ctx.storage.sql.exec("SELECT name FROM pragma_table_info('attempts')").toArray() as unknown as { name: string }[]).map((column) => column.name));
    for (const [name, declaration] of ADDED_COLUMNS) {
      if (!held.has(name)) ctx.storage.sql.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${declaration}`);
    }
    // One attempt per hold token, ever: an admission replayed with a token some attempt already carries answers that
    // attempt. Attempts admitted before tokens existed carry none and are not constrained.
    ctx.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_hold_token ON attempts (hold_token) WHERE hold_token IS NOT NULL');
    if (ctx.storage.sql.exec("SELECT 1 FROM pragma_table_info('objects') WHERE name = 'source'").toArray().length === 0) {
      ctx.storage.sql.exec('ALTER TABLE objects ADD COLUMN source TEXT');
    }
  }

  private row(where: string, ...args: (string | number)[]): AttemptRow | null {
    return (this.ctx.storage.sql.exec(`SELECT * FROM attempts WHERE ${where} ORDER BY id DESC LIMIT 1`, ...args).toArray()[0] as unknown as AttemptRow) ?? null;
  }

  private checkpoint(): AttemptCheckpoint {
    const sql = this.ctx.storage.sql;
    const storage = this.ctx.storage;
    // A write to an attempt already terminal changes nothing: a step that outlived the attempt's terminalization cannot
    // bring it back. Every write that lands records progress.
    const writable = `stage IN (${ADVANCING_STAGES_SQL}, 'unconfirmed')`;
    const stillWritable = (id: number): boolean => sql.exec(`SELECT 1 FROM attempts WHERE id = ? AND ${writable}`, id).toArray().length > 0;
    return {
      open: () => {
        const row = this.row(`stage IN (${ADVANCING_STAGES_SQL})`);
        return row === null ? null : stateOf(row);
      },
      update: (id, fields) => {
        const entries = Object.entries(fields) as Array<[keyof AttemptState, AttemptState[keyof AttemptState]]>;
        if (entries.length === 0) return;
        sql.exec(
          `UPDATE attempts SET ${entries.map(([key]) => `${COLUMN[key]} = ?`).join(', ')}, last_progress_at = ? WHERE id = ? AND ${writable}`,
          ...entries.map(([key, value]) => (JSON_COLUMNS.has(key) ? (value === null || value === undefined ? null : JSON.stringify(value)) : value as string | number | null)), Date.now(), id,
        );
      },
      parts: (id) => sql.exec('SELECT part, bytes, sha256, etag FROM parts WHERE attempt = ? ORDER BY part', id).toArray() as unknown as AttemptPart[],
      recordPart: (id, part, downloadOffset, progress) => {
        storage.transactionSync(() => {
          if (!stillWritable(id)) return;
          sql.exec('INSERT OR REPLACE INTO parts (attempt, part, bytes, sha256, etag) VALUES (?, ?, ?, ?, ?)', id, part.part, part.bytes, part.sha256, part.etag);
          sql.exec(
            'UPDATE attempts SET download_offset = ?, defined = ?, scan = ?, scan_bytes = ?, last_progress_at = ? WHERE id = ?',
            downloadOffset, JSON.stringify(progress.defined), JSON.stringify(progress.scan), progress.scanBytes, Date.now(), id,
          );
        });
      },
      clearParts: (id) => { if (stillWritable(id)) sql.exec('DELETE FROM parts WHERE attempt = ?', id); },
      recordInventory: (id, progress, objects) => {
        // The cursor, the reading, the digest over the bytes read and the objects they name commit as one step.
        storage.transactionSync(() => {
          if (!stillWritable(id)) return;
          for (const object of objects) {
            sql.exec(
              `INSERT INTO objects (attempt, key, source, bytes, sha256, staged_sha256, staged_bytes, registered)
                 VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
                 ON CONFLICT (attempt, key) DO UPDATE SET source = excluded.source, bytes = excluded.bytes, sha256 = excluded.sha256`,
              id, object.key, object.source, object.bytes, object.sha256, progress.parts,
            );
          }
          sql.exec(
            `UPDATE attempts SET inventory_parts = ?, inventory_bytes = ?, inventory_scan = ?, inventory_scan_bytes = ?,
               inventory_digest = ?, last_progress_at = ? WHERE id = ?`,
            progress.parts, progress.bytes, JSON.stringify(progress.scan), progress.scanBytes,
            JSON.stringify(progress.digest), Date.now(), id,
          );
        });
      },
      pendingObjects: (id, limit) => (sql.exec(
        `SELECT key, source, bytes, sha256, staged_sha256, staged_bytes FROM objects
           WHERE attempt = ? AND staged_sha256 IS NULL ORDER BY registered, key LIMIT ?`, id, limit,
      ).toArray() as unknown as ObjectRow[]).map(objectOf),
      recordCopied: (id, key, staged) => {
        storage.transactionSync(() => {
          if (!stillWritable(id)) return;
          sql.exec('UPDATE objects SET staged_sha256 = ?, staged_bytes = ? WHERE attempt = ? AND key = ?', staged.sha256, staged.bytes, id, key);
          sql.exec('UPDATE attempts SET last_progress_at = ? WHERE id = ?', Date.now(), id);
        });
      },
      objects: (id) => (sql.exec(
        'SELECT key, source, bytes, sha256, staged_sha256, staged_bytes FROM objects WHERE attempt = ? ORDER BY key', id,
      ).toArray() as unknown as ObjectRow[]).map(objectOf),
      objectCounts: (id) => {
        const row = sql.exec(
          `SELECT COUNT(*) AS registered, COUNT(staged_sha256) AS staged FROM objects WHERE attempt = ?`, id,
        ).one() as unknown as { registered: number; staged: number };
        return { registered: row.registered, staged: row.staged };
      },
      signedUrl: (id) => storage.get<string>(`signed:${id}`).then((held) => held ?? null),
      setSignedUrl: async (id, url) => {
        if (url === null) await storage.delete(`signed:${id}`);
        else await storage.put(`signed:${id}`, url);
      },
    };
  }

  /**
   * The export target: the account and database this Deployment's own bindings name, the credential held only here,
   * and the tables the admitted attempt captured. No caller contributes any of them.
   */
  private target(tables: readonly string[]): { accountId: string; databaseId: string; tables: string[]; token: string; apiOrigin?: string } {
    const { MYCO_RECOVERY_ACCOUNT_ID: accountId, MYCO_RECOVERY_DATABASE_ID: databaseId, RECOVERY_EXPORT_TOKEN: token } = this.env;
    if (!accountId || !databaseId || !token) throw new Error('this Deployment carries no recovery export target');
    if (tables.length === 0) throw new Error('a recovery export names no tables');
    return { accountId, databaseId, tables: [...tables], token, apiOrigin: this.env.MYCO_RECOVERY_API_ORIGIN };
  }

  /** The Deployment this Worker's own bindings name. */
  private locator(): string {
    const { MYCO_RECOVERY_ACCOUNT_ID: accountId, MYCO_RECOVERY_DATABASE_ID: databaseId } = this.env;
    if (!accountId || !databaseId) throw new Error('this Deployment carries no recovery export target');
    return `${accountId}/${databaseId}`;
  }

  private bucket(): StagingBucket {
    const bucket = this.env.RECOVERY_BUCKET;
    if (bucket === undefined) throw new Error('this Deployment binds no recovery staging bucket');
    return bucket;
  }

  /** Opens one attempt from a schema captured before any export ran. Refuses while another attempt is open. */
  async admit(admission: RecoveryAdmissionWire, limits: Partial<ProducerLimits> = {}): Promise<RecoveryProducerStatus> {
    return this.gate.exclusive(() => this.publish(admission, { ...PRODUCER_LIMITS, ...limits }));
  }

  /**
   * Stages the capture, then records the attempt. The record is the publication: an interrupted or refused staging
   * write leaves nothing for a continuation to advance, and no attempt claims an export it never prepared for.
   */
  private async publish(admission: RecoveryAdmissionWire, limits: ProducerLimits): Promise<RecoveryProducerStatus> {
    // A token an attempt already carries is answered with that attempt, whatever its stage: an admission is never
    // staged twice for one hold.
    const carrying = this.row('hold_token = ?', admission.holdToken);
    if (carrying !== null) return this.statusOf(carrying);
    if (this.retired(admission.holdToken)) return { ...await this.status(), holdRetired: true };
    if (this.row(`stage IN (${ADVANCING_STAGES_SQL})`) !== null) return this.status();
    // An earlier attempt resting unconfirmed is read once more before a new attempt supersedes it,
    // so a manifest that landed late is recorded as the complete staging it is. A read that settles nothing leaves
    // that attempt resting as it was, and never holds the new admission back.
    const resting = this.row("stage = 'unconfirmed'");
    if (resting !== null) {
      const ports = cloudflareProducerPorts(this.target(JSON.parse(resting.tables) as string[]), this.bucket(), this.env.BUCKET, {
        testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record',
      });
      await within(() => reconcileUnconfirmed(stateOf(resting), this.checkpoint(), ports), limits.requestMs, Date.now).catch(() => undefined);
    }
    const locator = this.locator();
    const target = this.target(admission.tables);
    // What the staging records about this Deployment comes from its own bindings, read once by the one reader, whatever
    // configuration the wire carries. A new attempt from a Worker that could not record its configuration, or one this
    // object cannot record, stages nothing.
    if (admission.unrecordable !== undefined) throw new Error(admission.unrecordable);
    const bound = boundRecoveryConfiguration(this.env);
    if (!bound.ok) throw new Error(bound.reason);
    const { configuration, credentialsRequired } = recordedAdmission(bound.configuration, admittedStarter(admission));
    const now = Date.now();
    const prefix = `staging/${now}`;
    const bytes = new TextEncoder().encode(admission.schema);
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    const schema = {
      sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      bytes: bytes.byteLength,
    };
    const unbounded = cloudflareProducerPorts(target, this.bucket(), this.env.BUCKET, { testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record' });
    // Admission holds this object's gate, so every staging write it makes is bounded: a write that never settles fails
    // the admission and releases the gate, and one that lands later leaves files under a prefix no attempt names.
    const ports = {
      ...unbounded,
      writeStagingFile: (prefix: string, name: string, body: string) =>
        within((signal) => unbounded.writeStagingFile(prefix, name, body, signal), limits.requestMs, Date.now),
    };
    const scan: ScanProgress = freshScan();
    // The admission is recorded in the attempt's own row, so it is held to what a row takes before anything is staged.
    const recorded = JSON.stringify({ configuration, credentialsRequired });
    if (recorded.length > CHECKPOINT_STATEMENT_CHARS) throw new Error('a recovery admission is too large to record');
    try {
      await publishAttempt(ports, {
        prefix, target: STAGING_TARGET, locator, startedAt: now, schema, schemaText: admission.schema,
        configuration, credentialsRequired,
      }, (published) => {
        this.ctx.storage.transactionSync(() => {
          if (this.row('hold_token = ?', admission.holdToken) !== null) throw new HoldCarried();
          if (this.retired(admission.holdToken)) throw new HoldRetired();
          this.ctx.storage.sql.exec(
            `INSERT INTO attempts (stage, prefix, locator, started_at, tables, schema_sha256, schema_bytes, captured, defined, scan, scan_bytes, admission, hold_token, last_progress_at)
               VALUES ('export', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            prefix, locator, now, JSON.stringify([...admission.tables]), schema.sha256, schema.bytes,
            JSON.stringify(admission.captured), JSON.stringify(scan.defined), JSON.stringify(scan.scan), scan.scanBytes,
            JSON.stringify(published), admission.holdToken, Date.now(),
          );
        });
      });
    } catch (error) {
      if (error instanceof HoldRetired) return { ...await this.status(), holdRetired: true };
      if (error instanceof HoldCarried) return this.statusOf(this.row('hold_token = ?', admission.holdToken)!);
      throw error;
    }
    return this.status();
  }

  /**
   * Advances the open attempt, if any. Holds no alarm and opens nothing. Callers that overlap share the step already
   * in flight, so two wakes arriving together ask the provider for one export and not two.
   */
  async continue(limits: ProducerLimits = PRODUCER_LIMITS): Promise<ContinuationReport> {
    return this.gate.shared(() => this.step(limits));
  }

  private async step(limits: ProducerLimits): Promise<ContinuationReport> {
    // A caller's limits stand on the defaults, so a partial set bounds the step it names and nothing else. Every
    // part but the last must clear the provider's floor, or the completion it accepts today is refused.
    const asked = { ...PRODUCER_LIMITS, ...limits };
    const bounded: ProducerLimits = { ...asked, partBytes: Math.max(R2_MINIMUM_PART_BYTES, asked.partBytes) };
    await this.failStalled(Date.now(), bounded);
    const open = this.row(`stage IN (${ADVANCING_STAGES_SQL})`);
    if (open === null) return { attempt: null, stage: 'idle', progressed: false, nextInMs: null, sourcePaused: false };
    const target = this.target(JSON.parse(open.tables) as string[]);
    const ports = cloudflareProducerPorts(target, this.bucket(), this.env.BUCKET, {
      testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record', requestMs: bounded.requestMs,
    });
    return continueAttempt(this.checkpoint(), ports, bounded);
  }

  /**
   * Fails every advancing attempt that has committed no checkpoint for `PRODUCER_STALL_MS`, through the one failure
   * path every refusal takes: the terminal state is durable before anything else, then its upload is aborted, its
   * signed download cleared and the refusal announced, each clean-up step bounded by `requestMs`. Its checkpoint writers
   * refuse a terminal attempt, so a step still in flight cannot revive it.
   */
  private async failStalled(now: number, limits: ProducerLimits): Promise<void> {
    const stalled = this.ctx.storage.sql.exec(
      `SELECT * FROM attempts WHERE stage IN (${ADVANCING_STAGES_SQL}) AND COALESCE(last_progress_at, started_at) < ? ORDER BY id`,
      now - PRODUCER_STALL_MS,
    ).toArray() as unknown as AttemptRow[];
    for (const row of stalled) {
      const state = stateOf(row);
      const ports = cloudflareProducerPorts(this.target(state.tables), this.bucket(), this.env.BUCKET, {
        testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record', requestMs: limits.requestMs,
      });
      await failAttempt(state, this.checkpoint(), ports, 'producer_stalled', { idleMs: now - (row.last_progress_at ?? row.started_at) }, undefined, limits.requestMs);
    }
  }

  private retired(token: string): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM retired_hold_tokens WHERE token = ?', token).toArray().length > 0;
  }

  /**
   * Decides a recovery hold against the attempts, one at a time with admission: the attempt carrying the token answers
   * whether it still advances, and a token no attempt carries is retired in the same synchronous transaction, so no
   * later admission can carry it. See `HoldSettlement`.
   */
  async settleHold(token: string, limits: Partial<ProducerLimits> = {}): Promise<HoldSettlement> {
    return this.gate.exclusive(async () => {
      await this.failStalled(Date.now(), { ...PRODUCER_LIMITS, ...limits });
      return this.ctx.storage.transactionSync(() => this.settle(token));
    });
  }

  private settle(token: string): HoldSettlement {
    const row = this.row('hold_token = ?', token);
    const settlement = settlementOf(row === null ? null : { id: row.id, stage: row.stage as AttemptState['stage'] });
    if (settlement.state === 'retired') {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO retired_hold_tokens (token, retired_at) VALUES (?, ?)', token, Date.now());
    }
    return settlement;
  }

  /** The attempt's progress, with no credential, no signed download and no claim of recoverability. */
  async status(): Promise<RecoveryProducerStatus> {
    return this.statusOf(this.row('1 = 1'));
  }

  /** One attempt's progress, or idle where there is none. */
  private statusOf(row: AttemptRow | null): RecoveryProducerStatus {
    if (row === null) {
      return { attempt: null, stage: 'idle', startedAt: null, recoverable: false, staged: null, export: null, error: null, transientSpent: 0, stagedSchema: null };
    }
    const parts = this.ctx.storage.sql.exec('SELECT COUNT(*) AS held FROM parts WHERE attempt = ?', row.id).one().held as number;
    const objects = this.ctx.storage.sql.exec(
      'SELECT COUNT(*) AS registered, COUNT(staged_sha256) AS staged FROM objects WHERE attempt = ?', row.id,
    ).one() as unknown as { registered: number; staged: number };
    return {
      attempt: row.id,
      stage: row.stage as RecoveryProducerStatus['stage'],
      startedAt: row.started_at,
      recoverable: false,
      staged: {
        prefix: row.prefix, sqlBytes: row.sql_bytes, downloadedBytes: row.download_offset, parts,
        objects: { registered: objects.registered, staged: objects.staged },
      },
      export: { polls: row.polls, bookmark: row.bookmark !== null, reExports: row.re_exports },
      error: row.error as RecoveryProducerStatus['error'],
      transientSpent: row.attempts,
      stagedSchema: row.schema_sha256 === '' ? null : { sha256: row.schema_sha256, bytes: row.schema_bytes },
    };
  }

  /**
   * The Deployment's schema no longer matches the capture this attempt staged, so the staged export describes a
   * source that has moved: the attempt is failed, and nothing may read its staging as recoverable. A staging whose
   * completion is recorded is a snapshot whole as taken, and a later schema change leaves it as it is.
   */
  async noteSchemaDrift(attempt: number): Promise<RecoveryProducerStatus> {
    return this.gate.exclusive(async () => {
      const row = this.row('id = ?', attempt);
      if (row !== null && row.stage !== 'failed' && row.stage !== 'complete' && row.completed_at === null) {
        await this.ctx.storage.delete(`signed:${attempt}`);
        this.ctx.storage.sql.exec("UPDATE attempts SET stage = 'failed', error = 'schema_disagrees' WHERE id = ?", attempt);
      }
      return this.status();
    });
  }

  /** Where the staged export of one attempt lives, for an operator fetching it. */
  async stagedKey(attempt: number): Promise<string | null> {
    const row = this.row('id = ?', attempt);
    return row === null ? null : stagedSqlKey(row.prefix);
  }
}
