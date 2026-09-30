/**
 * The shapes Health reads of measures, backups, automatic recovery, store
 * maintenance and housekeeping, as the server sends them.
 *
 * Declared here with no imports, since the server's modules carry runtime
 * imports the dashboard's build does not; `tests/myco-server/health-wire.test.ts`
 * holds each to the server's own declaration under `typecheck:tests`.
 */

/** A measured value and the rows behind it. The two always travel together: a figure is never shown without its sample. */
export interface Measure {
  value: number | null;
  sampleSize: number;
}

/** One agent's rate, with the call count behind it so the split's parts account for the whole. */
export interface HarnessMeasure extends Measure {
  harness: string;
  calls: number;
}

/** `GET /api/kpis?window=`. */
export interface KpiReport {
  windowDays: number | null;
  since: number | null;
  contextPresent: Measure;
  sporeServeRate: Measure;
  callsPerPrompt: Measure;
  callsPerPromptByHarness: HarnessMeasure[];
  planReadsPerSession: Measure;
  firstInjectionMs: Measure;
  recallQuality: Measure;
}

/** `GET /api/backups`: one backup the index records. */
export interface BackupRow {
  id: string;
  key: string;
  created_at: number;
  size_bytes: number;
  counts_json: string;
  schema_version: number;
  producer: string;
  pinned: number;
  /** Whether the artifact is actually in the object store; an index row whose object vanished reads as missing. */
  present: boolean;
}

export interface BackupsAnswer {
  backups: BackupRow[];
}

/** `POST /api/backups/{id}/restore-preview`: what a restore would add, from the artifact's header alone. */
export interface RestorePreview {
  header: { deploymentId: string; schemaVersion: number; createdAt: number; counts: Record<string, number> };
  /** The backup names another Deployment: restoring it makes that Deployment's members live here. */
  foreignLineage: boolean;
}

/** `POST /api/backups/{id}/restore`: what each table took. */
export interface RestoreOutcome {
  tables: Record<string, { rows: number; inserted: number; skipped?: string }>;
}

/** Which of the store's routine checks. */
export type MaintenanceCheck = 'optimize' | 'integrity';

export type CheckSupport = { supported: true; label: string } | { supported: false; reason: string };

export type Cadence =
  | { state: 'on'; intervalHours: number }
  | { state: 'off' }
  | { state: 'not_configured'; leaf: string }
  | { state: 'invalid'; leaf: string; reason: string };

export type StoreMeasurement =
  | { name: string; state: 'measured'; value: number; unit: 'bytes' }
  | { name: string; state: 'unavailable'; reason: string };

/** The latest outcome of one check, as recorded. */
export interface MaintenanceOutcome {
  runId: string;
  trigger: 'schedule' | 'owner';
  state: 'running' | 'healthy' | 'findings' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  errorClass: string | null;
  findings: string[];
  findingsOmitted: number;
  measurements: StoreMeasurement[];
}

/** One check as an owner is told of it. */
export interface CheckStatus {
  check: MaintenanceCheck;
  support: CheckSupport;
  cadence: Cadence;
  dueAt: number | null;
  running: boolean;
  latest: MaintenanceOutcome | null;
}

/** `GET /api/maintenance`. */
export interface MaintenanceAnswer {
  checks: CheckStatus[];
}

/** One housekeeping job's outcome in a wake. */
export interface JobReport {
  name: string;
  changed: number;
  failed: string | null;
  more?: boolean;
}

/** `POST /api/wake`: what housekeeping did and when it wakes next. */
export interface TickReport {
  state: string;
  heldBy: string | null;
  idleMs: number | null;
  jobs: JobReport[];
  nextWakeMs: number | null;
}

/** What the last recovery attempt did. */
export interface LatestAttempt {
  attempt: number;
  stage: string;
  startedAt: number | null;
  /** The producer's own refusal classifier, where the attempt failed: a fixed word, not a message. */
  failure: string | null;
  /** Why an attempt at its export sends nothing now: an earlier attempt's export may still run, or its own request got no answer. */
  waiting?: 'earlier_export' | 'own_request' | null;
  /** The request instant of the export it waits on. */
  waitingSince?: number | null;
}

/**
 * What recovery data the Deployment holds. `staged` is not recoverable: a
 * staging becomes a recovery artifact only once an operator materializes and
 * verifies it.
 */
export type RecoveryAvailability =
  | { state: 'none' }
  | { state: 'incomplete'; attempt: number; stage: string }
  | { state: 'staged'; attempt: number; prefix: string; needs: string }
  | { state: 'artifact'; attempt: number; at: string; needs: string };

export interface RecoverySchedule {
  supported: boolean;
  configured: boolean;
  /** False when a binding or credential this Deployment's recovery needs is absent; `idleBecause` says which. */
  ready: boolean;
  intervalHours: number | null;
  dueAt: number | null;
  due: boolean;
  latest: LatestAttempt | null;
  available: RecoveryAvailability;
  idleBecause: string | null;
}

/** `GET /api/recovery/exports`. */
export interface RecoveryStatus {
  attempt: number | null;
  stage: string;
  /** What this Deployment's producer produces, which decides what a complete attempt may be called. */
  form: 'staging' | 'artifact';
  /** Why the latest attempt failed, from the producer's closed set, or null. */
  error?: string | null;
  /** An export an attempt requested and never saw settle, and from when it may be forgotten. */
  unsettledExport?: { attempt: number; forgettableAt: number };
  /** The schedule, or that this Deployment's settings could not be read while an export pauses its database. */
  schedule: RecoverySchedule | { unreadable: string };
}

/** `POST /api/recovery/exports/forget-unsettled`. */
export interface ForgetAnswer {
  forgotten: { attempt: number; requestedAt: number } | null;
}
