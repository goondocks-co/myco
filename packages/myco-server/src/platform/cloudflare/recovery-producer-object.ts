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
  continueAttempt, freshScan, PRODUCER_LIMITS, publishAttempt, stagedSqlKey,
  type AttemptCheckpoint, type AttemptPart, type AttemptState, type ContinuationReport, type ProducerLimits,
  type RecoveryAdmission, type RecoveryProducerStatus, type ScanProgress, type TableDefinitions,
} from '../../core/recovery-producer.js';
import type { StatementScan } from '../../core/sql-statements.js';
import { serialGate } from '../../core/serial-gate.js';
import { cloudflareProducerPorts, R2_MINIMUM_PART_BYTES, STAGING_TARGET, type StagingBucket } from './recovery-export.js';
import type { CloudflareBindings } from './env.js';

/** The one producer a Deployment keeps. */
export const PRODUCER_NAME = 'recovery';

interface AttemptRow {
  id: number; stage: string; prefix: string; started_at: number; error: string | null; attempts: number;
  bookmark: string | null; polls: number; export_started_at: number | null; export_completed_at: number | null;
  re_exports: number; sql_bytes: number | null; sql_etag: string | null; upload_id: string | null;
  download_offset: number; reconcile_offset: number; reconciled: number; locator: string; tables: string;
  schema_sha256: string; schema_bytes: number; captured: string; defined: string; scan: string; scan_bytes: string;
}

const COLUMN: Record<keyof AttemptState, string> = {
  id: 'id', stage: 'stage', prefix: 'prefix', startedAt: 'started_at', error: 'error', attempts: 'attempts',
  bookmark: 'bookmark', polls: 'polls', exportStartedAt: 'export_started_at', exportCompletedAt: 'export_completed_at',
  reExports: 're_exports', sqlBytes: 'sql_bytes', sqlEtag: 'sql_etag', uploadId: 'upload_id',
  downloadOffset: 'download_offset', reconcileOffset: 'reconcile_offset', reconciled: 'reconciled',
  tables: 'tables', captured: 'captured', defined: 'defined', scan: 'scan', scanBytes: 'scan_bytes',
};

/** Columns holding a list or a record are written as JSON text, so one update path serves every field. */
const JSON_COLUMNS = new Set<keyof AttemptState>(['tables', 'captured', 'defined', 'scan']);

const stateOf = (row: AttemptRow): AttemptState => ({
  id: row.id, stage: row.stage as AttemptState['stage'], prefix: row.prefix, startedAt: row.started_at,
  error: row.error as AttemptState['error'], attempts: row.attempts, bookmark: row.bookmark, polls: row.polls,
  exportStartedAt: row.export_started_at, exportCompletedAt: row.export_completed_at, reExports: row.re_exports,
  sqlBytes: row.sql_bytes, sqlEtag: row.sql_etag, uploadId: row.upload_id,
  downloadOffset: row.download_offset, reconcileOffset: row.reconcile_offset, reconciled: row.reconciled,
  tables: JSON.parse(row.tables) as string[], captured: JSON.parse(row.captured) as TableDefinitions,
  defined: JSON.parse(row.defined) as TableDefinitions, scan: JSON.parse(row.scan) as StatementScan,
  scanBytes: row.scan_bytes,
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
  }

  private row(where: string, ...args: (string | number)[]): AttemptRow | null {
    return (this.ctx.storage.sql.exec(`SELECT * FROM attempts WHERE ${where} ORDER BY id DESC LIMIT 1`, ...args).toArray()[0] as unknown as AttemptRow) ?? null;
  }

  private checkpoint(): AttemptCheckpoint {
    const sql = this.ctx.storage.sql;
    const storage = this.ctx.storage;
    return {
      open: () => {
        const row = this.row("stage IN ('export', 'download')");
        return row === null ? null : stateOf(row);
      },
      update: (id, fields) => {
        const entries = Object.entries(fields) as Array<[keyof AttemptState, AttemptState[keyof AttemptState]]>;
        if (entries.length === 0) return;
        sql.exec(
          `UPDATE attempts SET ${entries.map(([key]) => `${COLUMN[key]} = ?`).join(', ')} WHERE id = ?`,
          ...entries.map(([key, value]) => (JSON_COLUMNS.has(key) ? JSON.stringify(value ?? []) : value as string | number | null)), id,
        );
      },
      parts: (id) => sql.exec('SELECT part, bytes, sha256, etag FROM parts WHERE attempt = ? ORDER BY part', id).toArray() as unknown as AttemptPart[],
      recordPart: (id, part, downloadOffset, progress) => {
        storage.transactionSync(() => {
          sql.exec('INSERT OR REPLACE INTO parts (attempt, part, bytes, sha256, etag) VALUES (?, ?, ?, ?, ?)', id, part.part, part.bytes, part.sha256, part.etag);
          sql.exec(
            'UPDATE attempts SET download_offset = ?, defined = ?, scan = ?, scan_bytes = ? WHERE id = ?',
            downloadOffset, JSON.stringify(progress.defined), JSON.stringify(progress.scan), progress.scanBytes, id,
          );
        });
      },
      clearParts: (id) => { sql.exec('DELETE FROM parts WHERE attempt = ?', id); },
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
  async admit(admission: RecoveryAdmission): Promise<RecoveryProducerStatus> {
    return this.gate.exclusive(() => this.publish(admission));
  }

  /**
   * Stages the capture, then records the attempt. The record is the publication: an interrupted or refused staging
   * write leaves nothing for a continuation to advance, and no attempt claims an export it never prepared for.
   */
  private async publish(admission: RecoveryAdmission): Promise<RecoveryProducerStatus> {
    if (this.row("stage IN ('export', 'download')") !== null) return this.status();
    const locator = this.locator();
    const target = this.target(admission.tables);
    const now = Date.now();
    const prefix = `staging/${now}`;
    const bytes = new TextEncoder().encode(admission.schema);
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    const schema = {
      sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      bytes: bytes.byteLength,
    };
    const ports = cloudflareProducerPorts(target, this.bucket(), { testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record' });
    const scan: ScanProgress = freshScan();
    await publishAttempt(ports, {
      prefix, target: STAGING_TARGET, locator, startedAt: now, schema, schemaText: admission.schema,
      configuration: admission.configuration, credentialsRequired: admission.credentialsRequired,
    }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO attempts (stage, prefix, locator, started_at, tables, schema_sha256, schema_bytes, captured, defined, scan, scan_bytes)
           VALUES ('export', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        prefix, locator, now, JSON.stringify([...admission.tables]), schema.sha256, schema.bytes,
        JSON.stringify(admission.captured), JSON.stringify(scan.defined), JSON.stringify(scan.scan), scan.scanBytes,
      );
    });
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
    // Every part but the last must clear the provider's floor, or the completion it accepts today is refused.
    const bounded: ProducerLimits = { ...limits, partBytes: Math.max(R2_MINIMUM_PART_BYTES, limits.partBytes) };
    const open = this.row("stage IN ('export', 'download')");
    if (open === null) return { attempt: null, stage: 'idle', progressed: false, nextInMs: null, sourcePaused: false };
    const target = this.target(JSON.parse(open.tables) as string[]);
    const ports = cloudflareProducerPorts(target, this.bucket(), { testRoutes: this.env.HARNESS_LAUNCH_MODE === 'record' });
    return continueAttempt(this.checkpoint(), ports, bounded);
  }

  /** The attempt's progress, with no credential, no signed download and no claim of recoverability. */
  async status(): Promise<RecoveryProducerStatus> {
    const row = this.row('1 = 1');
    if (row === null) {
      return { attempt: null, stage: 'idle', recoverable: false, staged: null, export: null, error: null, transientSpent: 0, stagedSchema: null };
    }
    const parts = this.ctx.storage.sql.exec('SELECT COUNT(*) AS held FROM parts WHERE attempt = ?', row.id).one().held as number;
    return {
      attempt: row.id,
      stage: row.stage as RecoveryProducerStatus['stage'],
      recoverable: false,
      staged: { prefix: row.prefix, sqlBytes: row.sql_bytes, downloadedBytes: row.download_offset, parts },
      export: { polls: row.polls, bookmark: row.bookmark !== null, reExports: row.re_exports },
      error: row.error as RecoveryProducerStatus['error'],
      transientSpent: row.attempts,
      stagedSchema: row.schema_sha256 === '' ? null : { sha256: row.schema_sha256, bytes: row.schema_bytes },
    };
  }

  /**
   * The Deployment's schema no longer matches the capture this attempt staged, so the staged export describes a
   * source that has moved: the attempt is failed, and nothing may read its staging as recoverable.
   */
  async noteSchemaDrift(attempt: number): Promise<RecoveryProducerStatus> {
    return this.gate.exclusive(async () => {
      const row = this.row('id = ?', attempt);
      if (row !== null && row.stage !== 'failed') {
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
