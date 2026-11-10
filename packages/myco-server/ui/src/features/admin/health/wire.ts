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
export interface KpiMetadata {
  /** Complete UTC days before today, or null for all history through today. */
  windowDays: number | null;
  /** Inclusive lower time bound in epoch milliseconds; null for all history. */
  since: number | null;
  /** Start of the first UTC day in epoch milliseconds; null for all history. */
  windowStart: number | null;
  /** End of today in UTC, inclusive, in epoch milliseconds. */
  windowEnd: number;
  /** Observation instant in epoch milliseconds. */
  asOf: number;
  /** Schema step defining the meaning of these measures. */
  metricVersion: number;
}

export type KpiAnswer = KpiReport | (KpiMetadata & {
  state: 'building';
  progress: { completed: number; total: number };
});

export interface KpiReport extends KpiMetadata {
  /** All historical projection phases are complete. */
  state: 'ready';
  /** Prompts in the window named by a delivered spore receipt or plan nudge. */
  promptsServed: number;
  /** Spore receipts delivered in the window, split by placement on a live prompt; excludes plan nudges. */
  deliveries: { placed: number; unplaced: number };
  /** Prompts served context as a share of live prompts in the window. */
  servedShare: Measure;
  /** Live prompts delivered at least one spore as a share of live prompts in the window. */
  sporeServeRate: Measure;
  /** Sessions with a cortex block, delivered or not, as a share of sessions started in the window. */
  sessionStartPresent: Measure;
  /** Myco tool calls per live prompt across the Deployment. */
  callsPerPrompt: Measure;
  /** Per-harness calls and prompt samples, including harnesses with calls but no prompts. */
  callsPerPromptByHarness: HarnessMeasure[];
  /** Myco plan reads (list, get or absent op) per session started in the window. */
  planReadsPerSession: Measure;
  /** Median milliseconds from lineage start to its first context receipt, delivered or not. The window selects lineage starts; negative waits are excluded. */
  firstInjectionMs: Measure;
  /** Release recall score over its fixed evaluation cases; independent of the traffic window. */
  recallQuality: Measure;
  /** Per-harness prompt naming counts; sampleSize counts claimed live prompts in the window. */
  promptIdentity: PromptIdentityCounts[];
}

/** One agent's counts of transcript lines its parse kept without naming them the usual way. Counts only. */
export interface PromptIdentityCounts {
  /** Agent recorded by the session primary transcript, or the transcript agent for scheme counts. */
  harness: string;
  /** Live prompts carrying a claim in the window. */
  sampleSize: number;
  /** Claimed prompt records whose shape or opener class is unknown. */
  unrecognized: number;
  /** Claimed prompt records with no field naming who opened the turn. */
  unmarked: number;
  /** Claimed prompt records whose fields name two opener classes. */
  openerConflict: number;
  /** Claimed prompt records that contradict the registered transcript role. */
  contractViolation: number;
  /** Later submissions reusing a key an earlier submission owns. */
  reused: number;
  /** Refused attempts by a second source to name an existing prompt id. */
  identityConflicts: number;
  /** Unpinned transcripts of declared agents in the window. */
  schemeConflicts: number;
  /** Sessions of a declared agent with at least two schemes represented in the window. */
  mixedSchemeSessions: number;
  /** Retained context answers skipped for a prompt id already named by a receipt. */
  duplicatePromptSkips: number;
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
  /** What the last recorded check found: a recorded check says what it saw then, never what the store holds now. */
  verification: BackupVerification;
}

export interface BackupVerification {
  state: 'unverified' | 'verified' | 'failed';
  checkedAt: number | null;
  /** Why a failed check failed: the artifact was absent, its size differed, or its digest differed. */
  detail: 'absent' | 'size' | 'sha256' | null;
}

export type BackupPruneOutcome = (
  | { state: 'pruned'; pruned: number; deferred: number; remaining?: true }
  | { state: 'deferred'; reason: 'building' }
  | { state: 'changed'; reason: 'retention_changed' }
  | { state: 'failed'; errorClass: string }
) & { recordingErrorClass?: string };
export interface CreateBackupAnswer {
  backup: Omit<BackupRow, 'verification'>;
  retention: BackupPruneOutcome;
}
export interface BackupsAnswer {
  backups: BackupRow[];
  /** Where the next page starts, or null when this page is the last. */
  cursor: string | null;
  /** The last retention pass, and the most recent failure until a pass finishes the work. */
  retention: { at: number; outcome: BackupPruneOutcome; lastFailure?: { at: number; errorClass: string } } | null;
}

/** `POST /api/backups/{id}/restore-preview`: what a restore would add and whether this member may apply it. */
export interface RestorePreview {
  retiredNotice?: string;
  tables?: RestoreOutcome['tables'];
  header: { deploymentId: string; schemaVersion: number; createdAt: number; counts: Record<string, number> };
  /** The backup names another Deployment: restoring it lists that Deployment's people here without access. */
  foreignLineage: boolean;
  restore: { allowed: boolean; reason: string | null };
  /** For a foreign-lineage backup, the people and access it carries that land without authority, in words for the owner. */
  authorityExcluded: { tables: string[]; notice: string } | null;
}

/** `POST /api/backups/{id}/restore`: what each table took. */
export interface RestoreOutcome {
  retiredNotice?: string;
  tables: Record<string, { rows: number; inserted: number; skipped?: string }>;
}

/** Which of the store's routine checks. */
export type MaintenanceCheck = 'optimize' | 'integrity';

export type CheckSupport = { supported: true; label: string } | { supported: false; reason: string; reasonCode?: string };

export type Cadence =
  | { state: 'on'; intervalHours: number }
  | { state: 'off' }
  | { state: 'not_configured'; leaf: string }
  | { state: 'invalid'; leaf: string; reason: string };

export type StoreMeasurement =
  | { name: string; state: 'measured'; value: number; unit: 'bytes' }
  | { name: string; state: 'unavailable'; reason: string; reasonCode?: string };

/** The latest outcome of one check, as recorded. */
export interface MaintenanceOutcome {
  progress?: { completedTables: number; totalTables: number };
  runId: string;
  trigger: 'schedule' | 'owner';
  state: 'running' | 'healthy' | 'findings' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  errorClass: string | null;
  findingCodes?: string[];
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
  idleCode?: string | null;
  idleBecause: string | null;
}

/** `GET /api/recovery/exports`: what the producer is doing, or that this Deployment runs none. */
export type RecoveryStatus = RecoveryProducerStatus | RecoveryUnsupported;

/** `GET /api/recovery/exports` on a Deployment that runs a producer. */
export interface RecoveryProducerStatus {
  supported: true;
  attempt: number | null;
  stage: string;
  /** What this Deployment's producer produces, which decides what a complete attempt may be called. */
  form: 'staging' | 'artifact';
  /** Why the latest attempt failed, from the producer's closed set, or null. */
  error?: string | null;
  /** An export an attempt requested and never saw settle, and from when it may be forgotten. */
  unsettledExport?: { attempt: number; forgettableAt: number };
  /** The schedule, or that this Deployment's automatic backup settings could not be read. */
  schedule: RecoverySchedule | { unreadable: string };
}

/** `GET /api/recovery/exports` on a Deployment that runs no producer: said plainly, beside the schedule. */
export interface RecoveryUnsupported {
  supported: false;
  reason: string;
  schedule: RecoverySchedule | { unreadable: string };
}

/** `POST /api/recovery/exports/forget-unsettled`. */
export interface ForgetAnswer {
  forgotten: { attempt: number; requestedAt: number } | null;
}
