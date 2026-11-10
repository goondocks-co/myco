import { classify, emit } from '../telemetry.js';
import { pinBackup } from '../db/storage/backup-pin.js';
import { readBackupRow, type BackupVerification, type BackupVerificationDetail } from '../db/storage/backup-list.js';
import { recordBackupVerification } from '../db/storage/backup-verification.js';
import { reservedRestoreOffset } from '../db/raw/restore-revisions.js';
import { resetProjectionCatchup } from '../db/projections/catchup.js';
import { restoreRunBodyStatement } from '../db/runs/body-restore.js';
import {
  clearArchivedTranscriptRanges,
  restoreTranscriptSegmentStatement,
} from '../db/documents/ranges.js';
import { excludeDeletedRestoreRows, excludeDeletedSnapshotRows, excludeRetiredRuns, restoreBlobReferences } from './restore-rows.js';
import { contentAssertion } from './registered-content.js';
import { eventReferenceStatement } from '../db/event-references.js';
import { archivedEventMetadata } from '../db/document-tables.js';
import { estimateInvalidationStatements } from '../db/meta/budget-estimates.js';
import { storedDeploymentId, storedSchemaVersion } from '../db/meta/deployment.js';
import { restoreAttemptStatement,restoreAgentStateStatement,attemptRestoreComparison,portableAttemptRow } from './attempt-accounting.js';
import { LAST_RELEASE_RESTORING_RETIRED_FORMAT } from './retired-format-release.js';
import { DOCUMENT_SESSION_TABLES, DOCUMENT_ARTIFACT_TABLES } from '../db/document-tables.js';
import { DROPPED_CONTENT_TABLES } from '../db/schema-v265.js';
import { RETIRED_BACKUP_TABLES, retiredBackupNotice, retiredBackupTable } from '@goondocks/myco-shared/backup-words';
import { expireCarriedDeviceRequest } from '../auth/device.js';
import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID } from '../constants.js';
import { restoreAuthorityAuditStatement, restoreMembershipBatch } from './ownership.js';
import { restoreOwnership } from '../db/identity/ownership.js';
import { restoreTableKey } from '../db/recovery/restore-keys.js';
import { effectiveRawOwnerSql, reserveRawRestore } from './raw-claims.js';
/**
 * Deployment backup and restore.
 *
 * A backup is one text artifact in the object store: a header line naming the
 * Deployment, the stamped schema version, and per-table row counts, then one
 * JSON line per row. Restore rebuilds parameterized `INSERT OR IGNORE`
 * statements from each line's own keys and applies them in bounded batches —
 * additive, never overwriting, idempotent under a re-run. The store's rows are
 * the whole artifact; object-store bytes (attachments, transcript segments)
 * live in the bucket already and are not duplicated into it.
 */
import type { BlobStore, PreparedStatement, RelationalStore } from './adapters.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { readStoredObject } from './stored-object.js';
import {
  publishBackupObject,
  referencedBlobsOf,
  releaseBlobs,
} from './object-release.js';
import {
  registeredBlobsGuard,
  unregisteredAmong,
  recordBlobCandidates,
} from '../db/storage/release-queue.js';
import { BUNDLE_REFERENCES } from './blob-references.js';
import { bundleHeld } from '../db/storage/blob-held.js';
import { assertArchivedContentClosure, assertBundleObjectClosure, assertCaptureClosure, relationalSnapshot, RelationalSnapshotTooLargeError } from './relational-snapshot.js';
import { verifyBundleArtifact, type BundleEntryIdentity } from './archive-bundle.js';
import { restoreArchivedEvent } from './event-content-restore.js';
import { clearDeletedParentsStatement } from '../db/sessions/tombstones.js';
import { restoreExtractionAckStatement } from './extraction-acks.js';
import { admitRestoredArtifacts, ArtifactRestoreRefused, restoreSessionArtifactStatement } from './session-artifacts.js';
import { restoredPin, restoreSchemeDecisions, restoreRecordSchemeDecisions } from '../db/documents/restore-pins.js';
import type { PromptIdScheme } from '@goondocks/myco-shared/prompt-identity';
import { authorizeRestore, RestoreAuthorizationError, type RestoreAuthorization } from './restore-authorization.js';

export const BACKUP_FORMAT = 'myco-backup/1';
export const BACKUP_KEY_PREFIX = 'backups/';
/** The largest artifact the create path assembles; past this, a backup is refused loudly, never truncated. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
/** The largest request body the upload-restore route admits; sized past the artifact bound so a JSON-escaped artifact still fits. */
export const MAX_UPLOAD_BODY_BYTES = 80 * 1024 * 1024;
/** The only shape a restored column name may take; anything else in an artifact is refused before it reaches a statement. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Rows per applied batch on restore; one statement per row keeps every statement under the bind-count bound. */
const RESTORE_CHUNK_ROWS = 20;

/**
 * Every data table, in an order that satisfies the schema's foreign keys:
 * parents before children.
 */
export const BACKUP_TABLES: readonly string[] = [
  'projects', 'project_remotes', 'members', 'runners', 'device_decision_audit', 'device_requests', 'machine_claims', 'uncaptured_roots', 'enrollment_authorities', 'identity_link_authorities',
  'member_credentials', 'runner_credentials', 'runner_audit', 'runner_metadata_audit', 'runner_signin_audit', 'legacy_worker_audit', 'runner_update_audit', 'deployment_ownership', 'deployment_ownership_audit', 'member_role_audit', 'raw_provenance_state', 'raw_provenance_backfill', 'raw_claims', 'raw_credentials', 'agents',
  'sessions', 'session_tombstones', 'blobs', 'archive_bundles', 'registered_content_proofs', 'prepared_archive_bundles', 'events', 'event_refs', 'processed_resources', 'plans',
  'attachments', 'transcripts', 'transcript_segments', 'raw_resources', 'raw_archive_refs', 'tags',
  'spore_curation_work', 'spore_curation_receipts', 'spore_curation_owners',
  'agent_tasks', 'agent_runs', 'run_served_material', 'extraction_acks', 'agent_run_attempts', 'agent_run_steps', 'run_reads', 'agent_state', 'spores', 'resolution_events', 'spore_injections', 'session_injections', 'prompt_context_answers', 'prompt_identity_conflicts',
  'injection_served_items', 'canopy_maps', 'knowledge_release_state', 'release_state_unresolved', 'external_grants',
  'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports', 'run_bodies',
  'knowledge_git_provenance', 'session_artifacts', 'turn_cards', ...DOCUMENT_ARTIFACT_TABLES,
];

/** The content tables of the format before session documents; an artifact holding any of their rows is refused as retired. */
const RETIRED_FORMAT_TABLES: readonly string[] = ['prompt_batches', 'responses', 'tool_calls', 'fact_classes', 'transcript_parser_state_chunks', 'prompt_key_owners'];

/** Artifact names of the content storage schema steps 265 to 464 dropped; their rows are skipped unless they are legacy document input. */
export const RETIRED_INPUT_TABLES: ReadonlySet<string> = new Set([
  ...DROPPED_CONTENT_TABLES,
  ...DROPPED_CONTENT_TABLES.filter(table => table.endsWith('_fts')).flatMap(table => ['_data', '_idx', '_docsize', '_config'].map(suffix => table + suffix)),
]);

/** Artifact tables whose data class is retired by a numbered schema step. */
export const RETIRED_TABLES: ReadonlyMap<string, number> = new Map(
  [...RETIRED_BACKUP_TABLES].map(([table, kind]) => [table, kind.version]),
);

/**
 * Append-only tables whose integer id IS the insertion order. Their ids are
 * per-database, so an additive merge into a populated table would drop rows
 * that collide on id while looking idempotent. A restore claims an empty
 * table and resumes only the same artifact; unclaimed history is skipped.
 */
export const EMPTY_ONLY_TABLES: ReadonlySet<string> = new Set([
  'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports',
  'knowledge_git_provenance',
]);

/**
 * Tables an artifact never carries, each for a stated reason: migration-owned
 * state, transient upload-reservation state, the credential-store table nothing else may
 * touch, the backup index itself, the migration guard and holding tables, operator
 * configuration, and current machine and worker reports, which attached machines send again. Settings (the Deployment's and each machine's), capability
 * admissions, repository connections, release provenance settings and sealed secrets require their validated writers and a recorded actor.
 * Operators re-enter configuration on the dashboard after a restore. Embedding state is rebuilt from the sources an
 * artifact carries, calibration members and their stored vector pages among it; the sources embedding passes over are found again, and an embedding model switch is not carried, so a restored Deployment
 * spends on another model only once an admin there starts the switch again. The search index, its stored plan-body work and
 * its stored rankings are rebuilt from the records an artifact carries.
 */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'document_rebuild_receipts', 'document_rebuild_totals',
  'document_transcript_pins', 'document_group_pins', 'document_pin_totals',
  'document_owners', 'document_continuations', 'document_plan_keys', 'document_metadata_ready','document_metadata_progress',
  'document_failure_contributions', 'document_failure_totals', 'document_failure_head', 'publication_dependency_totals', 'document_locator_repair',
  'document_publication_ready', 'document_publication_contributions', 'document_publication_totals',
  'setting_revisions', 'embedding_passed_over', 'change_marks', 'member_naming_failures', 'embedding_source_state', 'embedding_model_totals', 'embedding_attempt_clock', 'embedding_resets', 'embedding_eligible_sources', 'embedding_work_attention', 'embedding_work_audit',
  'credential_lineages', 'storage_usage', 'kpi_fact', 'kpi_daily', 'kpi_lineage', 'projection_catchup', 'work_run_contribution', 'work_daily', 'run_output_membership', 'work_window_sessions', 'work_window_totals', 'run_head', 'attempt_head', 'run_body_failures', 'run_retirements', 'spore_count_facts', 'spore_counts', 'spore_session_counts', 'spore_daily', 'plan_count_facts', 'plan_counts', 'session_title_work', 'session_title_work_counts', 'search_revisions', 'attempt_spend', 'budget_totals', 'admission_contribution', 'run_live', 'task_runtime', 'task_due', 'legacy_contact_exports',
  'spore_resolution_edges', 'learning_project_counts', 'learning_ready_projects', 'learning_quiet_policy', 'project_settings', 'spore_curation_candidates', 'spore_curation_changes', 'spore_curation_cursor', 'spore_curation_clock',
  'learning_sessions',
  ...DOCUMENT_SESSION_TABLES.filter(table=>!(DOCUMENT_ARTIFACT_TABLES as readonly string[]).includes(table)),
  'search_blob_queue', 'search_blob_chunks', 'plans_search_terms','blob_search_terms',
  'search_documents', 'search_blob_refs', 'search_blobs', 'search_index_status', 'search_result_windows',
  'session_read_facts', 'session_served_items', 'project_session_counts', 'session_statistics', 'session_attachment_counts', 'project_session_days', 'context_placements', 'context_placement_days', 'machine_capture_heads',
  'embedding_retirement_queue','embedding_models','embedding_due','embedding_hubness_commits','embedding_hubness_revision','embedding_calibration_state','embedding_calibration_population','embedding_vector_pages','embedding_provider_holds',
  'document_due','document_status_totals','document_difference_totals','document_publication_facts',
  'embedding_work_state', 'embedding_versions', 'embedding_receipts', 'embedding_cursors', 'embedding_hubness_members', 'embedding_switches', 'embedding_source_failures', 'local_vectors',
  ...[...['spores', 'plans', 'sessions', 'search_blob_chunks', 'turn_cards', 'search_documents'].map(table => `${table}_fts`)]
    .flatMap(table => ['', '_data', '_idx', '_docsize', '_config'].map(suffix => table + suffix)),
  'raw_restore_revisions', 'schema_meta', 'member_tokens', 'blob_reservations', 'step_up_authorities', 'identity_link_redemptions', 'active_project_count',
  'backup_week_heads', 'backup_retention_state', 'deployment_settings', 'deployment_setting_resets', 'retired_deployment_settings', 'machine_settings', 'project_capabilities', 'project_repositories', 'project_release_provenance', 'deployment_secrets', 'backups',
  'backup_restore_progress', 'restore_jobs', 'backup_publications', 'recovery_forget_commands', 'session_deletion_jobs', 'transcript_reread_jobs',
  'storage_cleanup_state', 'storage_cleanup_queue', 'storage_cleanup_omissions', 'content_scan_checkpoints', 'raw_archive_state', 'raw_event_archive_state', 'orphan_sweep_state', 'storage_content_guard',
  'object_settlement_intents', 'object_reconciliation_cursor', 'object_store_reconciliation', 'object_releases', 'blob_release_candidates', 'backup_release_candidates', 'recovery_holds', 'restore_reference_guard',
  'worker_contacts', 'worker_model_catalogs', 'runner_contacts', 'runner_observations', 'runner_model_catalogs', 'runner_update_requests', 'runner_update_reports', 'machine_harness_reports', 'machine_settings_snapshots', 'machine_head', 'runner_head', 'release_check_due', 'release_work_due', 'release_propagation_due',
  '_v2_guard_project_id_grammar', '_v2_guard_session_machine_id',
  '_v68_guard_retired_settings',
  '_v5_guard_credential_backfillable', '_v5_guard_backfill_complete',
  '_v48_credential_rows', '_v48_guard_rows_kept',
]);

/**
 * Carried tables whose rows let someone act here: a bearer secret's hash, which presenting the secret proves, or a
 * member's linked GitHub account, which a dashboard sign-in proves. An artifact from another Deployment inserts every
 * row of these already revoked, by `FOREIGN_LINEAGE_REVOKER`, so the rows keep the attribution its history names and
 * none of them authenticates here. A member row so held stays listed until the owner re-admits it by assigning a
 * role; a credential, key or grant so revoked never authenticates again. The Deployment's own runtime member, and
 * every row the destination already holds, are untouched. A same-lineage restore inserts them as they are.
 */
export const FOREIGN_AUTHORITY_TABLES: readonly string[] = ['members', 'enrollment_authorities', 'identity_link_authorities', 'member_credentials', 'runner_credentials', 'external_grants'];
/** What a foreign-lineage preview tells the owner about the people and access the artifact carries. */
export const FOREIGN_AUTHORITY_NOTICE = 'People from the other server are listed here but cannot sign in until the owner re-admits them on the People page. Its machine sign-ins, runner credentials, enrollment and account-link keys, and external agent grants arrive revoked and cannot be used here: enroll machines, register runners and issue agent grants again on this server. This server keeps its own owner.';

interface ForeignAuthorityExclusion {
  /** The `FOREIGN_AUTHORITY_TABLES` this artifact holds rows for. */
  tables: string[];
  notice: string;
}

export interface BackupHeader {
  format: string;
  deploymentId: string;
  schemaVersion: number;
  createdAt: number;
  producer: string;
  counts: Record<string, number>;
}

export interface BackupIndexRow {
  id: string;
  key: string;
  created_at: number;
  size_bytes: number;
  counts_json: string;
  schema_version: number;
  producer: string;
  pinned: number;
  /** SHA-256 of the stored artifact bytes, recorded with the row by the backup writer; null for a row that carries no recorded digest. */
  sha256: string | null;
}

/** The index columns every read of a backup row selects. */
const INDEX_COLUMNS = 'id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256';

export class BackupApplyError extends Error {
  /** `cause` is the store error a write met, when the refusal wraps one rather than naming a rule of the restore. */
  constructor(readonly table: string, detail: string, cause?: unknown) {
    super(`the artifact could not be applied at ${table}: ${detail}; committed chunks are preserved; retry the same artifact after resolving the error`, cause === undefined ? undefined : { cause });
    this.name = 'BackupApplyError';
  }
}
/**
 * A backup holding content in the format before session documents. Nothing is restored from it: a backup taken after
 * the format change restores, or a complete recovery artifact, which carries the stored bytes.
 */
export class BackupFormatRetiredError extends Error {
  readonly code = 'artifact_format_retired';
  /** The release that still restores this backup, or null while no release has shipped without it. */
  readonly restoresOn = LAST_RELEASE_RESTORING_RETIRED_FORMAT;
  constructor(readonly counts: Readonly<Record<string, number>>) {
    const held = Object.entries(counts).map(([table, rows]) => `${rows} ${table}`).join(', ');
    super(`artifact_format_retired: this backup holds content in the format before session documents (${held} rows), which this release does not restore, so nothing was restored from it. Restore a backup taken after the format change, or recover the Deployment from a complete recovery artifact with \`myco server restore --from <directory>\`, which carries the stored bytes`);
    this.name = 'BackupFormatRetiredError';
  }
}
/**
 * An additive restore whose rows need blobs this Deployment does not register. The artifact carries rows alone, never
 * object bytes, so a row naming an absent blob would register or reference bytes that do not exist.
 */
export class BackupObjectsMissingError extends Error {
  constructor(readonly missing: number) {
    super(`the backup needs ${missing} stored blob${missing === 1 ? '' : 's'} this Deployment does not hold; a backup carries no blob bytes, so nothing was restored from it. Recover the Deployment from a complete recovery artifact with \`myco server restore\` instead`);
    this.name = 'BackupObjectsMissingError';
  }
}
export class BackupTooLargeError extends Error {
  constructor(bytes: number) {
    super(`the assembled backup is ${bytes} bytes, past the ${MAX_BACKUP_BYTES}-byte bound this path serves`);
    this.name = 'BackupTooLargeError';
  }
}

const encoder = new TextEncoder();

/** Enforce the artifact limit in the encoding written to the object store. */
export function assertBackupSize(text: string, previousBytes = 0): number {
  const bytes = previousBytes + encoder.encode(text).byteLength;
  if (bytes > MAX_BACKUP_BYTES) throw new BackupTooLargeError(bytes);
  return bytes;
}
export class BackupIntegrityError extends Error {
  constructor(readonly id: string, evidence: 'size' | 'sha256') {
    super(`the stored backup artifact ${id} does not match the ${evidence === 'sha256' ? 'SHA-256 digest' : 'size'} recorded when it was created; it was not previewed, restored or downloaded`);
    this.name = 'BackupIntegrityError';
  }
}
export class BackupLineageError extends Error {
  constructor(readonly dumpId: string, readonly liveId: string) {
    super('the backup names another Deployment; restoring it is a deliberate adoption, asked for explicitly');
    this.name = 'BackupLineageError';
  }
}
export class BackupSchemaError extends Error {
  constructor(readonly dumpVersion: number, readonly liveVersion: number) {
    super(`the backup carries schema version ${dumpVersion} and this store is at ${liveVersion}; update the Deployment first`);
    this.name = 'BackupSchemaError';
  }
}

/** The lineage id the v13 migration seeded. A store this reads on predates nothing: the migration runs first on both targets. */
export async function deploymentId(db: RelationalStore): Promise<string> {
  const value = await storedDeploymentId(db);
  if (value === null) throw new Error('this store carries no deployment_id; its migrations have not run');
  return value;
}

const MACHINE_REPORT_COLUMNS = new Set(['settings_cached_revision', 'settings_cached_values', 'settings_report_order', 'settings_contract_supported']);

/** Portable machine identities carry no confirmation of the attached member's current cache. */
function portableRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if(table==='agent_run_attempts')return portableAttemptRow(row);
  return table === 'machine_claims' ? Object.fromEntries(Object.entries(row).filter(([column]) => !MACHINE_REPORT_COLUMNS.has(column))) : row;
}

/** Encodes the tables held by one schema snapshot without publishing or changing its store. */
export async function backupSnapshot(
  db: RelationalStore, blobs: BlobStore, opts: { producer: string; now: number },
): Promise<{ header: BackupHeader; bytes: Uint8Array<ArrayBuffer> }> {
  // A store at an older schema carries the tables its schema holds; its header names that schema.
  const held = await db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(BACKUP_TABLES)).all<{ name: string }>();
  const present = new Set(held.results.map((row) => row.name));
  const captured = await relationalSnapshot(db, ['schema_meta', ...BACKUP_TABLES.filter((table) => present.has(table))], MAX_BACKUP_BYTES).catch((error: unknown) => {
    if (error instanceof RelationalSnapshotTooLargeError) throw new BackupTooLargeError(error.bytes);
    throw error;
  });
  const snapshot = excludeDeletedSnapshotRows(captured);
  assertCaptureClosure(snapshot);
  await assertBundleObjectClosure({db,blobs},snapshot);
  const meta = new Map(snapshot.get('schema_meta')!.map((row) => [row.key, row.value]));
  const lineage = meta.get('deployment_id');
  if (typeof lineage !== 'string') throw new Error('this store carries no deployment_id; its migrations have not run');
  const stamped = Number(meta.get('version'));
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  let bytes = 0;
  for (const table of BACKUP_TABLES) {
    counts[table] = 0;
    for (const columns of snapshot.get(table) ?? []) {
      const line = JSON.stringify({ t: table, r: portableRow(table, columns) });
      bytes = assertBackupSize(`${line}\n`, bytes);
      lines.push(line);
      counts[table] = counts[table]! + 1;
    }
  }

  const header: BackupHeader = {
    format: BACKUP_FORMAT, deploymentId: lineage, schemaVersion: stamped,
    createdAt: opts.now, producer: opts.producer, counts,
  };
  const headerLine = JSON.stringify(header);
  assertBackupSize(`${headerLine}\n`, bytes);

  return { header, bytes: utf8([headerLine, ...lines].join('\n') + '\n') };
}

/** Create one backup artifact and its index row; answers the index row written. */
export async function createBackup(db: RelationalStore, blobs: BlobStore, opts: { producer: string; now: number }): Promise<BackupIndexRow> {
  const { header, bytes: artifact } = await backupSnapshot(db,blobs,opts);
  const { deploymentId: lineage, schemaVersion: stamped, counts } = header;
  const id = `bk_${crypto.randomUUID()}`;
  const key = `${BACKUP_KEY_PREFIX}${lineage}__${opts.now}__${id}.jsonl`;
  const sha256 = await sha256HexOf(artifact);
  return publishBackupObject(db, blobs, key,
    () => blobs.put(key, new Response(artifact).body, { sha256, httpMetadata: { contentType: 'application/jsonl' } }),
    size => {
      const row: BackupIndexRow = {
        id, key, created_at: opts.now, size_bytes: size,
        counts_json: JSON.stringify(counts), schema_version: stamped, producer: opts.producer, pinned: 0, sha256,
      };
      return row;
    });
}

/** The instant of the newest backup the index records, or null when it records none. */
export async function latestBackupAt(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT MAX(created_at) AS at FROM backups`).first<{ at: number | null }>();
  return row?.at ?? null;
}


const decoder = new TextDecoder();

type StoredArtifactCheck = { detail: null; bytes: Uint8Array<ArrayBuffer> } | { detail: BackupVerificationDetail };

/** One stored artifact against the size and digest its row recorded. A row with no digest is held to its size alone. */
async function checkStoredArtifact(blobs: BlobStore, row: BackupIndexRow): Promise<StoredArtifactCheck> {
  const stored = await readStoredObject(blobs, row.key, row.size_bytes);
  if (stored.kind === 'absent') return { detail: 'absent' };
  if (stored.kind === 'size_mismatch') return { detail: 'size' };
  if (row.sha256 !== null && await sha256HexOf(stored.bytes) !== row.sha256) return { detail: 'sha256' };
  return { detail: null, bytes: stored.bytes };
}

/** A read that found a bad artifact says so on its row; the read's own refusal stands whether or not this write lands. */
async function recordFailedCheck(db: RelationalStore, row: BackupIndexRow, detail: BackupVerificationDetail): Promise<void> {
  try { await recordBackupVerification(db, { id: row.id, key: row.key, state: 'failed', checkedAt: Date.now(), detail }); }
  catch (error) { emit({ kind: 'backup_verification_record_failed', error_class: classify(error) }); }
}

/**
 * One stored artifact, held to the evidence its row recorded before any caller
 * reads it. A recorded size past the artifact bound is refused unread. The
 * stored object must hold exactly the recorded size, read no further than it
 * (`readStoredObject`). A row that recorded a digest must match it; a row with
 * no recorded digest is held to its size alone.
 */
const readArtifact = async (db: RelationalStore, blobs: BlobStore, id: string): Promise<{ row: BackupIndexRow; text: string } | null> => {
  const row = await db.prepare(`SELECT ${INDEX_COLUMNS} FROM backups WHERE id = ?`)
    .bind(id).first<BackupIndexRow>();
  if (row === null) return null;
  if (row.size_bytes > MAX_BACKUP_BYTES) throw new BackupTooLargeError(row.size_bytes);
  const checked = await checkStoredArtifact(blobs, row);
  if (checked.detail !== null) {
    await recordFailedCheck(db, row, checked.detail);
    if (checked.detail === 'absent') return null;
    throw new BackupIntegrityError(row.id, checked.detail);
  }
  return { row, text: decoder.decode(checked.bytes) };
};

/** Admit every table named by the artifact before any restore write. */
function artifactTable(table: string): void {
  if (!BACKUP_TABLES.includes(table) && !RETIRED_FORMAT_TABLES.includes(table) && !EXCLUDED_TABLES.has(table) && !RETIRED_INPUT_TABLES.has(table) && !RETIRED_TABLES.has(table)) {
    throw new BackupApplyError(table, 'unknown artifact table');
  }
}

/** Rows admitted for restore, and explicit retirement outcomes shared by preview and apply. */
function restoreRows(lines: Iterable<string>, header: BackupHeader): {
  rows: Array<{ t: string; r: Record<string, unknown> }>;
  tables: RestoreOutcome['tables'];
  retiredNotice?: string;
} {
  for (const table of Object.keys(header.counts ?? {})) artifactTable(table);
  const rows: Array<{ t: string; r: Record<string, unknown> }> = [];
  const tables: RestoreOutcome['tables'] = {};
  const retiredCounts: Record<string, number> = {};
  const retiredFormat: Record<string, number> = {};
  for (const line of lines) {
    if (line.length === 0) continue;
    const row = JSON.parse(line) as { t: string; r: Record<string, unknown> };
    artifactTable(row.t);
    if (RETIRED_FORMAT_TABLES.includes(row.t)) { retiredFormat[row.t] = (retiredFormat[row.t] ?? 0) + 1; continue; }
    if (EXCLUDED_TABLES.has(row.t) || RETIRED_INPUT_TABLES.has(row.t)) continue;
    const namespace = row.t === 'knowledge_release_state' ? row.r.namespace : undefined;
    const retiredTable = retiredBackupTable(row.t) ?? retiredBackupTable(namespace);
    if (retiredTable !== undefined) {
      retiredCounts[retiredTable] = (retiredCounts[retiredTable] ?? 0) + 1;
      const previous = tables[row.t]?.rows ?? 0;
      tables[row.t] = { rows: previous + 1, inserted: 0, skipped: 'retired' };
    } else rows.push(row);
  }
  if (Object.keys(retiredFormat).length > 0) throw new BackupFormatRetiredError(retiredFormat);
  const notice = retiredBackupNotice(retiredCounts);
  return { rows, tables, ...(notice === null ? {} : { retiredNotice: notice }) };
}

/** What a restore would touch, answered from a verified artifact without executing its rows. */
export async function previewRestore(
  db: RelationalStore, blobs: BlobStore, id: string, documents?: RestoreDocuments,
): Promise<{ header: BackupHeader; foreignLineage: boolean; authorityExcluded: ForeignAuthorityExclusion | null; tableKeys: string[]; tables: RestoreOutcome['tables']; retiredNotice?: string; documents?: DocumentRestoreSummary } | null> {
  const artifact = await readArtifact(db, blobs, id);
  if (artifact === null) return null;
  const newline = artifact.text.indexOf('\n');
  if (newline === -1) return null;
  const header = JSON.parse(artifact.text.slice(0, newline)) as BackupHeader;
  const tableKeys = new Set<string>();
  const admitted = restoreRows(artifact.text.slice(newline + 1).split('\n'), header);
  for (const row of admitted.rows) tableKeys.add(row.t);
  const foreignLineage = header.deploymentId !== (await deploymentId(db));
  const authorityExcluded = foreignLineage
    ? { tables: FOREIGN_AUTHORITY_TABLES.filter((table) => tableKeys.has(table)), notice: FOREIGN_AUTHORITY_NOTICE }
    : null;
  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const row of admitted.rows) byTable.set(row.t, [...(byTable.get(row.t) ?? []), row.r]);
  const planned = documents === undefined ? undefined : (await documents.plan(byTable)).summary;
  return { header, foreignLineage, authorityExcluded, tableKeys: [...tableKeys], tables: admitted.tables, ...(admitted.retiredNotice === undefined ? {} : { retiredNotice: admitted.retiredNotice }),
    ...(planned === undefined ? {} : { documents: planned }) };
}

/**
 * Another Deployment's authority lands revoked. A live member is held for re-admission; a member its source already
 * revoked keeps that revocation. Every credential, key and grant names `FOREIGN_LINEAGE_REVOKER`, keeping its own
 * instant when it already had one, so no exception that reads `revoked_by` admits it.
 */
function revokeForeignAuthority(byTable: ReadonlyMap<string, Record<string, unknown>[]>, now: number): void {
  for (const table of FOREIGN_AUTHORITY_TABLES) {
    for (const row of byTable.get(table) ?? []) {
      if (table === 'members') {
        if (row.id === HARNESS_MEMBER_ID || typeof row.revoked_at === 'number') continue;
        row.revoked_at = now;
      } else {
        row.revoked_at = typeof row.revoked_at === 'number' ? row.revoked_at : now;
      }
      row.revoked_by = FOREIGN_LINEAGE_REVOKER;
    }
  }
}

/** What a restore does to session documents, decided before any write: sessions converted and merged. */
interface DocumentRestoreSummary { convert: number; merge: number }
/**
 * The document side of a restore: a plan read before any write, then each session's documents restored and published
 * on their own once the rows are restored, a page of sessions at a time in key order.
 */
export interface RestoreDocuments {
  /** Every session the artifact holds document content for, by key, in the order a restore applies them. */
  sessions(byTable: ReadonlyMap<string, readonly Record<string, unknown>[]>): string[];
  /** What the restore will do to each session, decided over the destination before the restore writes anything. */
  plan(byTable: ReadonlyMap<string, readonly Record<string, unknown>[]>): Promise<{ summary: DocumentRestoreSummary; decisions: [string, string][] }>;
  /**
   * Restores the sessions after `after`, at most `limit`, as the plan before any write decided them: how many it
   * walked, and the last, or null once none remain.
   */
  apply(byTable: ReadonlyMap<string, readonly Record<string, unknown>[]>, page: { after: string | null; limit: number; now: number; decisions: readonly [string, string][] }): Promise<{
    sessions: number; last: string | null;
  }>;
}

export interface RestoreOutcome {
  danglingEventBlobs?: { table: string; projectId: string; eventId: string; key: string }[];
  retiredNotice?: string;
  /** Runs in the artifact that retention removed here, left out with their evidence. */
  retiredRunsExcluded?: number;
  documents?: DocumentRestoreSummary;
  /** `reused` counts `blobs` rows this Deployment already registers, kept as they stand. */
  tables: Record<string, { rows: number; inserted: number; skipped?: string; reused?: number }>;
}

async function restoredCaptureReferences(db: RelationalStore, table: string, row: Readonly<Record<string, unknown>>, outcome: RestoreOutcome): Promise<PreparedStatement[]> {
  const missing = await unregisteredAmong(db, referencedBlobsOf(table, row, 'report'));
  if (missing.length > 0) {
    outcome.danglingEventBlobs ??= [];
    outcome.danglingEventBlobs.push(...missing.map(ref => ({ table, ...ref, eventId: String(row.event_id) })));
  }
  const absent = new Set(missing.map(ref => ref.key));
  const references = [...referencedBlobsOf(table, row, 'required'), ...referencedBlobsOf(table, row, 'report').filter(ref => !absent.has(ref.key))];
  return references.length === 0 ? [] : [registeredBlobsGuard(db, references)];
}

interface RestoreProgress {
  artifact_hash: string;
  next_row: number;
}

const RESTORE_OWNER = 'table_name = ? AND artifact_hash = ? AND next_row = ?';

type ArtifactRow = Record<string, unknown>;
/** What an owned row's restore is decided over: the artifact's transcripts, and the scheme each of their groups is admitted to. */
interface RestoreDecisions {
  parents: ReadonlyMap<string, ArtifactRow>;
  schemes: ReadonlyMap<string, PromptIdScheme | null>;
}
type OwnedRowRestorer = (db: RelationalStore, row: ArtifactRow, decided: RestoreDecisions) => PreparedStatement;

/** Owned state restores through the capability that admits its writes. */
const OWNED_ROW_RESTORERS: Readonly<Partial<Record<string, OwnedRowRestorer>>> = {
  agent_state: restoreAgentStateStatement,
  run_bodies: restoreRunBodyStatement,
  agent_run_attempts: restoreAttemptStatement,
  extraction_acks: restoreExtractionAckStatement,
  transcript_segments: restoreTranscriptSegmentStatement,
  session_artifacts: restoreSessionArtifactStatement,
  // A transcript is pinned with its insert, to the scheme its group is admitted to over the whole artifact.
  transcripts(db, row, decided) {
    const columns = Object.keys(row).filter((column) => column !== 'prompt_identity_scheme');
    const pin = restoredPin(row, decided.schemes);
    return db.prepare(`INSERT OR IGNORE INTO transcripts (${[...columns, 'prompt_identity_scheme'].join(', ')})
        SELECT ${columns.map(() => '?').join(', ')}, ${pin.sql} RETURNING rowid`)
      .bind(...columns.map((c) => row[c] ?? null), ...pin.params);
  },

};

function readRestoreProgress(db: RelationalStore, table: string): Promise<RestoreProgress | null> {
  return db.prepare(`SELECT artifact_hash, next_row FROM backup_restore_progress WHERE table_name = ?`)
    .bind(table).first<RestoreProgress>();
}

/** An empty insertion-ordered table admits one artifact; only that artifact may continue its writes. */
async function claimRestoreTable(db: RelationalStore, table: string, hash: string): Promise<RestoreProgress | null> {
  await db.prepare(`INSERT INTO backup_restore_progress (table_name, artifact_hash, next_row)
      SELECT ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM ${table})
      ON CONFLICT (table_name) DO UPDATE SET artifact_hash = excluded.artifact_hash, next_row = 0
      WHERE NOT EXISTS (SELECT 1 FROM ${table})`).bind(table, hash).run();
  const progress = await readRestoreProgress(db, table);
  return progress?.artifact_hash === hash ? progress : null;
}

/** A receipt advances only when every supplied column agrees with the rows held by the target. */
function restoredRowsMatch(table: string, rows: readonly Record<string, unknown>[], keys:readonly string[]=['id']): string {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const mismatch = columns.map((column) =>
    `(json_type(expected.value, '$.${column}') IS NOT NULL AND held.${column} IS NOT json_extract(expected.value, '$.${column}'))`);
  return `NOT EXISTS (SELECT 1 FROM json_each(?) AS expected
    LEFT JOIN ${table} AS held ON ${keys.map(key=>`held.${key} = json_extract(expected.value, '$.${key}')`).join(' AND ')}
    WHERE held.${keys[0]} IS NULL OR ${mismatch.join(' OR ')})`;
}

const TRANSCRIPT_RAW_COLUMNS = ['project_id', 'transcript_id', 'session_id', 'machine_id', 'token_id', 'agent', 'origin_path', 'role', 'head_hash', 'size', 'segment_count', 'first_received_at', 'last_received_at', 'imported_at'] as const;
const TRANSCRIPT_SEGMENT_COLUMNS = ['project_id', 'transcript_id', 'base_offset', 'length', 'blob_key', 'event_id', 'created_at', 'received_at', 'token_id'] as const;
const transcriptIdentity = (project: unknown, id: unknown): string => JSON.stringify([project, id]);

/** Imported transcript attribution requires the held raw identity, bytes and existing owners to agree. */
async function restoreTranscriptReference(
  db: RelationalStore, row: Record<string, unknown>, transcript: Record<string, unknown> | undefined,
  segments: readonly Record<string, unknown>[], insert: PreparedStatement,
): Promise<number> {
  if (transcript === undefined) return 0;
  const expected = Object.fromEntries(TRANSCRIPT_RAW_COLUMNS.map((column) => [column,
    transcript[column] ?? (column === 'role' ? 'primary' : column === 'size' || column === 'segment_count' ? 0 : null)]));
  const heldOwner = effectiveRawOwnerSql('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id');
  const importedOwner = effectiveRawOwnerSql("json_extract(candidate.value, '$.owner_member_id')", "json_extract(candidate.value, '$.provenance')", "json_extract(candidate.value, '$.revision')", "json_extract(candidate.value, '$.claim_member_id')");
  const compatibility = {
    sql: `EXISTS (SELECT 1 FROM transcripts held, json_each(?) expected WHERE ${TRANSCRIPT_RAW_COLUMNS
      .map((column) => `held.${column} IS json_extract(expected.value, '$.${column}')`).join(' AND ')})
      AND (SELECT COUNT(*) FROM transcript_segments WHERE project_id = ? AND transcript_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM raw_resources r, json_each(?) candidate
        WHERE r.project_id = ? AND r.kind = 'transcript' AND r.resource_id = ?
          AND (r.provenance = 'ambiguous'
            OR (r.claim_member_id IS NOT NULL AND r.claim_member_id IS NOT COALESCE(${importedOwner}, json_extract(candidate.value, '$.claim_member_id')))
            OR (${heldOwner} IS NOT NULL AND ${heldOwner} IS NOT ${importedOwner})))`,
    params: [JSON.stringify([expected]), row.project_id, row.resource_id, segments.length, JSON.stringify([row]), row.project_id, row.resource_id],
  };
  const revision = await db.prepare('SELECT revision FROM raw_provenance_state WHERE id = 1').first<{ revision: number }>();
  if (revision === null) throw new Error('Raw provenance revision is missing');
  const agrees = async (check: { sql: string; params: unknown[] }): Promise<boolean> => {
    const result = await db.prepare(`SELECT (${check.sql}) AS matches`).bind(...check.params).first<{ matches: number }>();
    if (result === null) throw new Error('Transcript restore comparison returned no result');
    return result.matches === 1;
  };
  if (!await agrees(compatibility)) return 0;
  for (let start = 0; start < segments.length; start += RESTORE_CHUNK_ROWS) {
    const page = segments.slice(start, start + RESTORE_CHUNK_ROWS);
    if (!await agrees({
      sql: `NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN transcript_segments held
        ON held.project_id = json_extract(expected.value, '$.project_id')
          AND held.transcript_id = json_extract(expected.value, '$.transcript_id')
          AND held.base_offset = json_extract(expected.value, '$.base_offset')
        WHERE held.base_offset IS NULL OR ${TRANSCRIPT_SEGMENT_COLUMNS
          .map((column) => `held.${column} IS NOT json_extract(expected.value, '$.${column}')`).join(' OR ')})`,
      params: [JSON.stringify(page)],
    })) return 0;
  }
  const applied = await db.batch([
    db.prepare(`INSERT INTO restore_reference_guard (missing)
      SELECT 'transcript ownership conflicts with held raw data'
        WHERE NOT ((SELECT revision FROM raw_provenance_state WHERE id = 1) = ? AND (${compatibility.sql}))`)
      .bind(revision.revision, ...compatibility.params),
    insert,
  ]);
  return applied.at(-1)!.results.length;
}

/** What a restore is asked to apply: the artifact's text and the authority it is applied under. */
export interface RestoreOptions {
  text: string;
  blobs?: BlobStore;
  allowForeignLineage?: boolean;
  authorization: RestoreAuthorization;
  now?: number;
  documents?: RestoreDocuments;
}

/** The stages of a restore after its admission, in the order a job walks them. */
export type RestorePhase = 'start' | 'tables' | 'documents' | 'bundles' | 'done';

/**
 * How far a restore has counted the artifact rows a table holds by key: `before` its rows are written, then `after`.
 * The rows a restore added to a table are the difference, true however often a pass replayed or raced.
 */
export interface RestoreTally { table: number; stage: 'before' | 'rows' | 'after'; checked: number; before: number; after: number }

/**
 * Where a restore's next pass begins. `table` is the place in `BACKUP_TABLES` a `tables` pass is at and `row` the
 * artifact row of that table it starts from; the later phases walk their items in key order after `after`.
 */
export interface RestoreCursor {
  phase: RestorePhase;
  table: number;
  row: number;
  after: string | null;
  tally: RestoreTally | null;
  /** The archive bundles the destination held by key before the restore wrote any, once that table was counted. */
  bundlesBefore: number | null;
  /** The scheme each restored transcript group is admitted to, decided once before the restore resets projection catch-up. */
  schemes: [string, PromptIdScheme | null][];
  /** What the documents plan decided for each session before the restore wrote anything. */
  documents: [string, string][];
}
export const RESTORE_START: RestoreCursor = { phase: 'start', table: 0, row: 0, after: null, tally: null, bundlesBefore: null, schemes: [], documents: [] };

/** Artifact rows one key count reads. */
const RESTORE_COUNT_PAGE = 200;
/** Rows one unit of a table that writes each row in its own batch takes before the restore commits where it stands. */
const RESTORE_ROW_UNIT = 5;
/** Events one unit writes when any of them is archived. */
const RESTORE_ARCHIVED_UNIT = 2;
/** Bundles one unit of a restore's start reads and verifies: two objects each. */
const RESTORE_VERIFY_UNIT = 4;
/** The tables whose rows each write in a batch of their own. */
const PER_ROW_TABLES: ReadonlySet<string> = new Set(['archive_bundles', 'raw_resources', 'events', 'event_refs', 'registered_content_proofs']);
/** Tables a restore never inserts into: what it reports of them is decided without writing. */
const UNCOUNTED_TABLES: ReadonlySet<string> = new Set(['raw_provenance_state', 'raw_provenance_backfill', 'deployment_ownership', 'blobs', ...DOCUMENT_ARTIFACT_TABLES]);

type Row = Record<string, unknown>;

/** Everything a pass decides over the artifact and the destination before it writes. */
interface PreparedRestore {
  db: RelationalStore;
  header: BackupHeader;
  hash: string;
  foreign: boolean;
  restoredAt: number;
  byTable: Map<string, Row[]>;
  /** Each row's place in its table as the artifact lists it, before any row is left out here. */
  ordinal: WeakMap<Row, number>;
  /** Rows each table holds in the artifact, before any row is left out here. */
  artifactRows: Map<string, number>;
  admitted: ReturnType<typeof restoreRows>;
  ownership: Row | undefined;
  ownerAudit: Row | undefined;
  documents: RestoreDocuments | undefined;
  /** The artifact holds session documents only the document side of a restore can place. */
  documentContent: boolean;
  /** The documents plan, when this preparation made it. */
  planned: Awaited<ReturnType<RestoreDocuments['plan']>> | undefined;
  provenance: Row[];
  sourceRevision: number;
  initial: RestoreOutcome;
}

/**
 * Every gate a restore meets before it writes, read over the artifact and the destination as they stand: lineage,
 * schema, authority, deleted sessions, retired runs, archive closure, registered blobs and ownership. Bundle objects are
 * read by the pass that verifies them or writes their events (`bundleVerifier`), never all at once. `plan` also plans
 * every session's documents.
 */
async function prepareRestore(db: RelationalStore, opts: RestoreOptions, scope: { plan: boolean }): Promise<PreparedRestore> {
  const { plan } = scope;
  const lines = opts.text.split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]!) as BackupHeader;

  const live = await deploymentId(db);
  if (header.deploymentId !== live && opts.allowForeignLineage !== true) throw new BackupLineageError(header.deploymentId, live);
  const stamped = (await storedSchemaVersion(db)) ?? 0;
  if (header.schemaVersion > stamped) throw new BackupSchemaError(header.schemaVersion, stamped);

  const restoredAt = opts.now ?? Date.now();
  const byTable = new Map<string, Row[]>();
  const ordinal = new WeakMap<Row, number>();
  const admitted = restoreRows(lines.slice(1), header);
  for (const parsed of admitted.rows) {
    const rows = byTable.get(parsed.t) ?? [];
    const row = parsed.t === 'device_requests' ? expireCarriedDeviceRequest(portableRow(parsed.t, parsed.r), restoredAt) : portableRow(parsed.t, parsed.r);
    ordinal.set(row, rows.length);
    rows.push(row);
    byTable.set(parsed.t, rows);
  }
  const artifactRows = new Map([...byTable].map(([table, rows]) => [table, rows.length]));
  const foreign = header.deploymentId !== live;
  if (foreign) revokeForeignAuthority(byTable, restoredAt);

  db = await authorizeRestore(db, opts.authorization, byTable.keys());
  if ((byTable.get('blobs') ?? []).some(row => typeof row.project_id !== 'string' || typeof row.key !== 'string')) {
    throw new BackupApplyError('blobs', 'a row carries no project and key');
  }
  db = await excludeDeletedRestoreRows(db, byTable);
  const retiredRuns = await excludeRetiredRuns(db, byTable, foreign);
  if (retiredRuns.unrecoverable > 0) throw new BackupObjectsMissingError(retiredRuns.unrecoverable);
  try { assertArchivedContentClosure(byTable); }
  catch (error) { throw new BackupApplyError('archive_bundles', error instanceof Error ? error.message : String(error)); }
  try { await admitRestoredArtifacts(db, byTable.get('session_artifacts') ?? [], byTable.get('sessions') ?? []); }
  catch (error) {
    if (error instanceof ArtifactRestoreRefused) throw new BackupApplyError('session_artifacts', error.message);
    throw error;
  }

  // Blob rows are never inserted: each must already be registered here, with the bytes its own row names. Checked
  // whole at admission, so a refused artifact changes nothing; every later write guards the blobs its own rows name.
  if (plan) {
    const required = [...byTable].flatMap(([table, rows]) => table === 'blobs' ? [] : rows.flatMap(row => restoreBlobReferences(table, row)));
    const absent = await unregisteredAmong(db, required);
    if (absent.length > 0) throw new BackupObjectsMissingError(absent.length);
  }
  if ((byTable.get('archive_bundles')?.length ?? 0) > 0 && opts.blobs === undefined) {
    throw new BackupApplyError('archive_bundles', 'bundle objects require a content store for restore verification');
  }

  const ownership = byTable.get('deployment_ownership')?.[0];
  const ownerAudit = ownership?.member_id == null ? undefined : (byTable.get('deployment_ownership_audit') ?? [])
    .find((row) => row.member_id === ownership.member_id && row.revision === ownership.revision);
  if (ownership?.member_id != null && (ownerAudit === undefined || typeof ownerAudit.actor_id !== 'string' || !Number.isSafeInteger(ownerAudit.created_at))) {
    throw new BackupApplyError('deployment_ownership', 'ownership requires its matching audit receipt');
  }

  const documentContent = (byTable.get('session_chunks')?.length ?? 0) > 0;
  if (documentContent && (opts.blobs === undefined || (plan && opts.documents === undefined))) throw new BackupApplyError('documents', 'document restoration requires a content store');
  const documents = opts.documents;
  if (plan) {
    // Pins must have caught up before a transcript's scheme can be decided; a restore is not accepted until they have.
    await restoreRecordSchemeDecisions(db, byTable.get('transcripts') ?? []);
    await restoreSchemeDecisions(db, byTable.get('transcripts') ?? []);
  }
  const planned = plan && documents !== undefined ? await documents.plan(byTable) : undefined;
  const summary = planned?.summary;
  const initial: RestoreOutcome = { tables: { ...admitted.tables }, ...(admitted.retiredNotice === undefined ? {} : { retiredNotice: admitted.retiredNotice }),
    ...(retiredRuns.excluded === 0 ? {} : { retiredRunsExcluded: retiredRuns.excluded, retiredNotice: [admitted.retiredNotice, `${retiredRuns.excluded} run${retiredRuns.excluded === 1 ? '' : 's'} this Deployment has removed under retention ${retiredRuns.excluded === 1 ? 'is' : 'are'} left out.`].filter(Boolean).join(' ') }),
    ...(summary === undefined ? {} : { documents: summary }) };
  const provenance = ['raw_provenance_state', 'raw_resources', 'raw_archive_refs', 'raw_claims', 'events', 'blobs', 'transcripts', 'attachments', 'plans'].flatMap((table) => byTable.get(table) ?? []);
  const sourceRevision = provenance.reduce((max, row) => Math.max(max,
    ...['revision','raw_revision','cutoff_revision'].map((key) => typeof row[key] === 'number' ? row[key] as number : 0)), 0);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new BackupApplyError('raw_claims', 'invalid raw provenance revision');
  return { db, header, hash: await sha256Hex(opts.text), foreign, restoredAt, byTable, ordinal, artifactRows, admitted, ownership, ownerAudit,
    documents, documentContent, planned, provenance, sourceRevision, initial };
}

/** What an admitted restore will walk: the artifact's identity, its rows, and the outcome it starts from. */
export interface AdmittedRestore { hash: string; header: BackupHeader; rowsTotal: number; outcome: RestoreOutcome }

/**
 * Every refusal a restore can meet before it writes, answered without writing: what a job is accepted on. The rows a
 * job walks are the artifact's rows of the tables it restores, then its sessions, legacy references, documents and
 * bundles.
 */
export async function admitRestore(db: RelationalStore, opts: RestoreOptions): Promise<AdmittedRestore> {
  const prepared = await prepareRestore(db, opts, { plan: true });
  return { hash: prepared.hash, header: prepared.header, outcome: prepared.initial, rowsTotal: restoreRowsTotal(prepared) };
}

function restoreRowsTotal(prepared: PreparedRestore): number {
  const tables = BACKUP_TABLES.reduce((sum, table) => sum + (prepared.artifactRows.get(table) ?? 0), 0);
  // A bundle is walked twice: verified before the restore writes, and released at the end if nothing uses it.
  return tables
    + (prepared.documents === undefined ? 0 : prepared.documents.sessions(prepared.byTable).length)
    + 2 * (prepared.byTable.get('archive_bundles')?.length ?? 0);
}

/**
 * How a pass is paced by the invocation it runs in: whether the next unit of work may not fit what is left, and where
 * the restore stands committed after each unit, so a pass that runs out or dies keeps every unit before it.
 */
export interface RestorePace {
  exhausted(): boolean;
  /** Commits where the restore stands; false when another pass moved the job, and this one stops. */
  checkpoint(progress: { cursor: RestoreCursor; outcome: RestoreOutcome; walked: number }): Promise<boolean>;
}

/** One pass of a restore: where it starts, how many artifact rows it may walk, and the outcome of the passes before it. */
export interface RestorePassRequest {
  from: RestoreCursor;
  rows: number;
  /** The outcome so far; a pass from the start without one begins from the admission's. */
  outcome?: RestoreOutcome;
  /** The restore was admitted already, documents planned and refused before any write; a pass need not plan them again. */
  admitted: boolean;
  pace?: RestorePace;
}

/**
 * What a pass did: where the next begins (`done` once the restore finished), the rows it walked, and the outcome so
 * far. `awaitingDocuments` when it stopped at a stage that places session documents and was given no document side;
 * `moved` when another pass moved the job and this one stopped.
 */
export interface RestorePassResult { next: RestoreCursor; walked: number; outcome: RestoreOutcome; awaitingDocuments: boolean; moved: boolean }

/**
 * Walks a restore from `from` for at most `rows` artifact rows, every write committing in a bounded batch, and answers
 * where the next pass begins. Every pass meets the restore's gates again over the destination as it stands. A pass
 * that dies leaves every batch it committed in place, and a pass from the same cursor converges: inserts the
 * destination already holds are no-ops, and an insertion-ordered table resumes from the progress its claim committed.
 */
export async function restorePass(db: RelationalStore, opts: RestoreOptions, request: RestorePassRequest): Promise<RestorePassResult> {
  const prepared = await prepareRestore(db, opts, { plan: request.from.phase === 'start' && !request.admitted });
  db = prepared.db;
  const verifyBundles = bundleVerifier(prepared, opts.blobs);
  const { byTable, hash } = prepared;
  const outcome: RestoreOutcome = structuredClone(request.outcome ?? prepared.initial);
  let cursor: RestoreCursor = { ...request.from, schemes: [...request.from.schemes], documents: [...request.from.documents] };
  let budget = request.rows;
  let walked = 0;
  let moved = false;
  const result = (awaitingDocuments = false): RestorePassResult => ({ next: cursor, walked, outcome, awaitingDocuments, moved });
  const ready = () => budget > 0 && request.pace?.exhausted() !== true;
  // Commits where the restore stands after a unit; false when this pass stops: another pass moved the job, or the next unit may not fit.
  const unitDone = async (): Promise<boolean> => {
    if (request.pace === undefined) return true;
    if (!await request.pace.checkpoint({ cursor, outcome, walked })) { moved = true; return false; }
    return !request.pace.exhausted();
  };
  const needsDocuments = (phase: RestorePhase) => prepared.documentContent && prepared.documents === undefined && (phase === 'start' || phase === 'documents');
  if (needsDocuments(cursor.phase)) return result(true);

  const transcripts = byTable.get('transcripts') ?? [];
  let offset: number;
  if (cursor.phase === 'start') {
    // Every bundle's objects are read and verified before the restore writes anything, a few in each committed unit;
    // `after` names the last bundle verified.
    const bundles = [...(byTable.get('archive_bundles') ?? [])].map((row) => [transcriptIdentity(row.project_id, row.id), row] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    for (;;) {
      const next = bundles.filter(([key]) => cursor.after === null || key > cursor.after).slice(0, RESTORE_VERIFY_UNIT);
      if (next.length === 0) break;
      if (!ready()) return result();
      await verifyBundles(next.map(([, row]) => row));
      walked += next.length;
      budget -= next.length;
      cursor = { ...cursor, after: next.at(-1)![0] };
      if (!await unitDone()) return result();
    }
    if (!ready()) return result();
    // Everything decided over the destination as it stood before the restore writes is decided here, and committed
    // with the cursor before the first table is written.
    const planned = prepared.planned ?? (prepared.documents === undefined ? undefined : await prepared.documents.plan(byTable));
    await restoreRecordSchemeDecisions(db, transcripts);
    const schemes = await restoreSchemeDecisions(db, transcripts);
    await resetProjectionCatchup(db);
    offset = prepared.provenance.length === 0 ? 0 : await reserveRawRestore(db, hash, prepared.sourceRevision);
    cursor = { ...cursor, phase: 'tables', table: 0, row: 0, after: null, schemes: [...schemes], documents: planned?.decisions ?? [] };
    if (!await unitDone()) return result();
  } else {
    const reserved = prepared.provenance.length === 0 ? 0 : await reservedRestoreOffset(db, hash);
    if (reserved === null) throw new BackupApplyError('raw_claims', 'the restore holds no reserved provenance revision; restore the artifact again');
    offset = reserved;
  }
  for (const table of ['raw_resources', 'raw_archive_refs', 'raw_claims', 'events']) {
    for (const row of byTable.get(table) ?? []) {
      if (table === 'raw_resources') row.reference_id = `restore:${hash}:${String(row.reference_id)}`;
      for (const key of table === 'raw_claims' ? ['min_revision', 'cutoff_revision'] : table === 'events' || table === 'raw_archive_refs' ? ['raw_revision'] : ['revision']) {
        if (table === 'raw_claims' && key === 'min_revision' && row[key] === undefined) row[key] = 0;
        if (typeof row[key] === 'number') row[key] = (row[key] as number) + offset;
      }
    }
  }
  const decided: RestoreDecisions = {
    parents: new Map(transcripts.map((row) => [transcriptIdentity(row.project_id, row.transcript_id), row])),
    schemes: new Map(cursor.schemes),
  };
  const context: TablePassContext = { db, prepared, decided, outcome, hash, verifyBundles,
    transcriptSegments: segmentsByTranscript(byTable), bundles: new Map((byTable.get('archive_bundles') ?? []).map((row) => [transcriptIdentity(row.project_id, row.id), row])),
    restoredBundleIds: new Map(), keys: new Map() };

  while (cursor.phase === 'tables' && ready()) {
    const table = BACKUP_TABLES[cursor.table];
    if (table === undefined) {
      for (const [name, skipped] of Object.entries(prepared.admitted.tables)) {
        const applied = outcome.tables[name];
        if (applied !== undefined && byTable.has(name)) outcome.tables[name] = { ...applied, rows: applied.rows + skipped.rows, skipped: skipped.skipped };
      }
      cursor = { ...cursor, phase: 'documents', table: 0, row: 0, after: null, tally: null };
      if (!await unitDone()) return result();
      break;
    }
    const all = byTable.get(table) ?? [];
    const counted = all.length > 0 && !UNCOUNTED_TABLES.has(table);
    const nextTable = { ...cursor, table: cursor.table + 1, row: 0, tally: null };
    if (counted) {
      const tally: RestoreTally = cursor.tally?.table === cursor.table ? cursor.tally : { table: cursor.table, stage: 'before', checked: 0, before: 0, after: 0 };
      if (tally.stage !== 'rows') {
        const page = all.slice(tally.checked, tally.checked + RESTORE_COUNT_PAGE);
        const held = page.length === 0 ? 0 : await heldByKey(context, table, page);
        const next: RestoreTally = tally.stage === 'before'
          ? { ...tally, before: tally.before + held, checked: tally.checked + page.length }
          : { ...tally, after: tally.after + held, checked: tally.checked + page.length };
        if (next.checked < all.length) cursor = { ...cursor, tally: next };
        else if (next.stage === 'before') cursor = { ...cursor, tally: { ...next, stage: 'rows', checked: 0 } };
        else {
          const entry = outcome.tables[table] ?? { rows: all.length, inserted: 0 };
          outcome.tables[table] = { ...entry, inserted: Math.max(next.after - next.before, 0) };
          cursor = { ...nextTable, bundlesBefore: table === 'archive_bundles' ? next.before : cursor.bundlesBefore };
        }
        if (!await unitDone()) return result();
        continue;
      }
    }
    const pending = all.filter((row) => (prepared.ordinal.get(row) ?? 0) >= cursor.row);
    // An archived event writes its bundle's reads and references with it, so a page holding one is smaller.
    const archived = table === 'events' && pending.slice(0, RESTORE_ROW_UNIT).some((row) => row.payload_format === 'archived');
    const unit = Math.min(budget, archived ? RESTORE_ARCHIVED_UNIT : PER_ROW_TABLES.has(table) ? RESTORE_ROW_UNIT : RESTORE_CHUNK_ROWS);
    const taken = await restoreTable(context, table, all, pending, unit);
    const nextRow = taken < pending.length ? prepared.ordinal.get(pending[taken]!)! : (prepared.artifactRows.get(table) ?? 0);
    walked += Math.max(nextRow - cursor.row, 0);
    budget -= taken;
    cursor = taken < pending.length ? { ...cursor, row: nextRow }
      : counted ? { ...cursor, row: nextRow, tally: { ...cursor.tally!, stage: 'after', checked: 0 } } : nextTable;
    if (!await unitDone()) return result();
  }

  if (needsDocuments(cursor.phase)) return result(true);
  while (cursor.phase === 'documents' && ready()) {
    if (prepared.documents === undefined) { cursor = { ...cursor, phase: 'bundles', after: null }; break; }
    const applied = await prepared.documents.apply(byTable, { after: cursor.after, limit: 1, now: prepared.restoredAt, decisions: cursor.documents });
    walked += applied.sessions;
    budget -= Math.max(applied.sessions, 1);
    cursor = applied.last === null ? { ...cursor, phase: 'bundles', after: null } : { ...cursor, after: applied.last };
    if (!await unitDone()) return result();
  }

  while (cursor.phase === 'bundles' && ready()) {
    const key = [...context.bundles.keys()].sort().find((held) => cursor.after === null || held > cursor.after);
    if (key === undefined) {
      if (context.bundles.size > 0 && cursor.bundlesBefore !== null) {
        const entry = outcome.tables.archive_bundles ?? { rows: context.bundles.size, inserted: 0 };
        outcome.tables.archive_bundles = { ...entry, inserted: Math.max(await heldByKeyAll(context, 'archive_bundles', [...context.bundles.values()]) - cursor.bundlesBefore, 0) };
      }
      // Catch-up may have finished a phase over a table this restore had not filled yet; every phase starts again over
      // what the restore left, before the restore is done.
      await resetProjectionCatchup(db);
      cursor = { ...cursor, phase: 'done', after: null, tally: null, schemes: [], documents: [] };
      break;
    }
    const row = context.bundles.get(key)!;
    const id = await restoredBundleId(context, key);
    if (id !== undefined) await releaseUnusedBundle(db, prepared.header, { projectId: row.project_id as string, id, archiveKey: row.archive_key as string, receiptKey: row.receipt_key as string });
    walked += 1;
    budget -= 1;
    cursor = { ...cursor, after: key };
    if (!await unitDone()) return result();
  }
  return result();
}

/**
 * Reads and verifies artifact bundles' objects, each at most once a pass, and gives the archived events each one holds
 * the metadata its body carries. A pass reads only the bundles it verifies before writing or writes events from.
 */
function bundleVerifier(prepared: PreparedRestore, blobs: RestoreOptions['blobs']): (bundles: readonly Row[]) => Promise<void> {
  const verified = new Set<Row>();
  const held = new Map<string, Row[]>();
  for (const event of prepared.byTable.get('events') ?? []) {
    if (event.bundle_id === null || event.bundle_id === undefined) continue;
    const key = transcriptIdentity(event.project_id, event.bundle_id);
    const events = held.get(key) ?? [];
    events.push(event);
    held.set(key, events);
  }
  return async (bundles) => {
    for (const row of bundles) {
      if (verified.has(row)) continue;
      if (blobs === undefined) throw new BackupApplyError('archive_bundles', 'bundle objects require a content store for restore verification');
      const events = held.get(transcriptIdentity(row.project_id, row.id)) ?? [];
      const locators: BundleEntryIdentity[] = events.map((event) => ({ projectId: row.project_id as string, entry: event.bundle_entry as number, kind: 'event',
        resourceId: event.event_id as string, eventId: event.event_id as string, envelopeHash: event.envelope_hash as string, tokenId: event.token_id as string }));
      try {
        const contents = await verifyBundleArtifact({ db: prepared.db, blobs }, row as Parameters<typeof verifyBundleArtifact>[1],
          prepared.byTable.get('registered_content_proofs') ?? [], locators);
        for (const event of events) {
          const payload = contents.get(String(event.event_id));
          if (payload === undefined) throw new Error('event_content_reference_invalid');
          event.payload = archivedEventMetadata(JSON.parse(payload));
        }
      } catch (error) {
        if (invocationSpent(error)) throw error;
        throw new BackupApplyError('archive_bundles', error instanceof Error ? error.message : String(error));
      }
      verified.add(row);
    }
  };
}

/** Counts the rows of `rows` the destination holds by `table`'s key, a page at a time. */
async function heldByKeyAll(context: TablePassContext, table: string, rows: readonly Row[]): Promise<number> {
  let held = 0;
  for (let at = 0; at < rows.length; at += RESTORE_COUNT_PAGE) held += await heldByKey(context, table, rows.slice(at, at + RESTORE_COUNT_PAGE));
  return held;
}

/**
 * How many of `rows` the destination holds by `table`'s key. An archive bundle is held by its object key, since the
 * destination numbers the bundles it holds itself. A row of an insertion-ordered table is held only when every column
 * agrees, since another writer may take the id the artifact's row carries.
 */
async function heldByKey(context: TablePassContext, table: string, rows: readonly Row[]): Promise<number> {
  let keys = context.keys.get(table);
  if (keys === undefined) {
    keys = table === 'archive_bundles' ? ['project_id', 'archive_key'] : await restoreTableKey(context.db, table);
    if (!keys.every((key) => IDENTIFIER.test(key)) || !BACKUP_TABLES.includes(table)) throw new BackupApplyError(table, 'the table has no key a restore can count by');
    context.keys.set(table, keys);
  }
  if (keys.length === 0) return 0;
  const compared = EMPTY_ONLY_TABLES.has(table) ? [...new Set([...keys, ...rows.flatMap((row) => Object.keys(row))])] : keys;
  if (!compared.every((column) => IDENTIFIER.test(column))) throw new BackupApplyError(table, 'a row carries a column name outside the store grammar');
  const held = await context.db.prepare(`SELECT COUNT(*) AS n FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM ${table} t
      WHERE ${keys.map((key) => `t.${key} = json_extract(j.value, '$.${key}')`).join(' AND ')}
        ${compared.filter((column) => !keys.includes(column)).map((column) => `AND t.${column} IS json_extract(j.value, '$.${column}')`).join(' ')})`)
    .bind(JSON.stringify(rows.map((row) => Object.fromEntries(compared.map((column) => [column, row[column] ?? null]))))).first<{ n: number }>();
  return held?.n ?? 0;
}

/** What a table's pass reads beside its rows. */
interface TablePassContext {
  db: RelationalStore;
  prepared: PreparedRestore;
  decided: RestoreDecisions;
  outcome: RestoreOutcome;
  hash: string;
  transcriptSegments: Map<string, Row[]>;
  bundles: Map<string, Row>;
  /** The destination id of each artifact bundle, by the artifact's identity for it. */
  restoredBundleIds: Map<string, number>;
  /** Reads and verifies the bundles an events page writes from, giving their archived events their metadata. */
  verifyBundles: (bundles: readonly Row[]) => Promise<void>;
  /** Each table's key columns, as read once per pass. */
  keys: Map<string, string[]>;
}

function segmentsByTranscript(byTable: ReadonlyMap<string, Row[]>): Map<string, Row[]> {
  const segments = new Map<string, Row[]>();
  for (const row of byTable.get('transcript_segments') ?? []) {
    const identity = transcriptIdentity(row.project_id, row.transcript_id);
    segments.set(identity, [...segments.get(identity) ?? [], row]);
  }
  return segments;
}

/** The bundle the destination holds under an artifact bundle's object key, as its own row. */
function heldBundle(db: RelationalStore, row: Row): Promise<Row | null> {
  return db.prepare(`SELECT * FROM archive_bundles WHERE project_id=? AND archive_key=?`)
    .bind(row.project_id, row.archive_key).first<Row>();
}

/**
 * The destination id of the artifact bundle `key` names, once this pass or an earlier one restored it: read only for
 * the bundles a unit uses, so a pass's own reads do not grow with the bundles the artifact holds.
 */
async function restoredBundleId(context: TablePassContext, key: string): Promise<number | undefined> {
  const known = context.restoredBundleIds.get(key);
  if (known !== undefined) return known;
  const row = context.bundles.get(key);
  if (row === undefined) return undefined;
  const held = await heldBundle(context.db, row);
  if (held === null || !Number.isSafeInteger(held.id)) return undefined;
  context.restoredBundleIds.set(key, held.id as number);
  return held.id as number;
}

/** Removes a restored bundle nothing uses, with its proofs, and releases its objects; true when it removed the bundle. */
async function releaseUnusedBundle(db: RelationalStore, header: BackupHeader, bundle: { projectId: string; id: number; archiveKey: string; receiptKey: string }): Promise<boolean> {
  const unused = `NOT (${bundleHeld('?', '?')})`;
  const guardValues = BUNDLE_REFERENCES.flatMap(() => [bundle.projectId,bundle.id]);
  const pairs = [{projectId:bundle.projectId,key:bundle.archiveKey},{projectId:bundle.projectId,key:bundle.receiptKey}];
  const candidates = recordBlobCandidates(db,pairs,header.createdAt,{bundle:{projectId:bundle.projectId,bundleId:bundle.id,archiveKey:bundle.archiveKey}});
  const results = await db.batch([
    ...candidates,
    db.prepare(`DELETE FROM registered_content_proofs WHERE project_id=?
      AND ((source_kind='bundle' AND source_id=?) OR (source_kind='receipt' AND source_id=?))
      AND ${unused}`).bind(bundle.projectId,bundle.archiveKey,`bundle:${bundle.archiveKey}`,...guardValues),
    db.prepare(`DELETE FROM archive_bundles WHERE project_id=? AND id=? AND ${unused} RETURNING id`)
      .bind(bundle.projectId,bundle.id,...guardValues),
  ]);
  if (results[candidates.length+1]!.results.length === 0) return false;
  await releaseBlobs(db,pairs,header.createdAt);
  return true;
}

/**
 * Restores up to `budget` of a table's `pending` rows (its artifact rows from the cursor on, in artifact order) and
 * answers how many it took. `all` is every row of the table the destination admits, for the tables whose progress
 * is committed by position.
 */
async function restoreTable(context: TablePassContext, table: string, all: Row[], pending: Row[], budget: number): Promise<number> {
  const { db, prepared, outcome, decided, hash } = context;
  const counted = (inserted: number, rows = all.length, extra: { skipped?: string; reused?: number } = {}) => {
    const held = outcome.tables[table];
    outcome.tables[table] = { rows, inserted: (held?.inserted ?? 0) + inserted, ...extra };
  };
  if ((DOCUMENT_ARTIFACT_TABLES as readonly string[]).includes(table)) {
    counted(0, all.length, { skipped: 'document restore owns catalog publication' });
    return pending.length;
  }
  if (pending.length === 0) return 0;
  if (table === 'raw_provenance_state' || table === 'raw_provenance_backfill') {
    counted(0, all.length, { skipped: 'destination provenance checkpoint owns the restored revision reservation' });
    return pending.length;
  }
  if (table === 'deployment_ownership') {
    if (prepared.foreign) {
      counted(0, all.length, { skipped: 'this server keeps its own owner; another server\'s owner is not restored' });
      return pending.length;
    }
    const row = all[0]!;
    const audit = prepared.ownerAudit;
    if (typeof row.member_id === 'string') await restoreOwnership(db, { member_id: row.member_id, revision: Number(row.revision) },
      { actor_id: audit!.actor_id as string, created_at: audit!.created_at as number,
        previous_member_id: audit!.previous_member_id as string | null | undefined, operation: audit!.operation as string | undefined });
    counted(0);
    return pending.length;
  }
  if (table === 'blobs') {
    counted(0, all.length, { reused: all.length });
    return pending.length;
  }
  const page = pending.slice(0, Math.max(1, Math.floor(Math.min(budget, pending.length))));
  if (table === 'archive_bundles') {
    let inserted = 0;
    for (const row of page) {
      const columns = Object.keys(row).filter(column => column !== 'id');
      if (!columns.every(column => IDENTIFIER.test(column)) || !Number.isSafeInteger(row.id)) {
        throw new BackupApplyError(table, 'a bundle has an invalid identity or column name');
      }
      const [,applied] = await db.batch([
        registeredBlobsGuard(db, [{projectId:row.project_id as string,key:row.archive_key as string},
          {projectId:row.project_id as string,key:row.receipt_key as string}]),
        db.prepare(`INSERT OR IGNORE INTO archive_bundles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`)
          .bind(...columns.map(column => row[column] ?? null)),
      ]);
      inserted += applied!.results.length;
      const held = await heldBundle(db, row);
      if (held === null || columns.some(column => held[column] !== (row[column] ?? null))
        || !Number.isSafeInteger(held.id)) throw new BackupApplyError(table, 'a bundle conflicts with the destination');
      context.restoredBundleIds.set(transcriptIdentity(row.project_id,row.id),held.id as number);
    }
    counted(inserted);
    return page.length;
  }
  for (const row of pending) {
    if (!Object.keys(row).every((c) => IDENTIFIER.test(c))) throw new BackupApplyError(table, 'a row carries a column name outside the store grammar');
  }
  if (table === 'raw_resources') {
    let inserted = 0;
    for (const row of page) {
      const columns = Object.keys(row);
      const insert = db.prepare(`INSERT OR IGNORE INTO raw_resources (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`)
        .bind(...columns.map((column) => row[column] ?? null));
      try {
        const identity = transcriptIdentity(row.project_id, row.resource_id);
        inserted += row.kind === 'transcript'
          ? await restoreTranscriptReference(db, row, decided.parents.get(identity), context.transcriptSegments.get(identity) ?? [], insert)
          : (await insert.all()).results.length;
      } catch (error) {
        if (error instanceof RestoreAuthorizationError) throw error;
        throw restoreRefusal(table, error);
      }
    }
    counted(inserted);
    return page.length;
  }
  if (table === 'events') {
    let inserted = 0;
    await context.verifyBundles(page.flatMap((row) => {
      const bundle = row.payload_format === 'archived' ? context.bundles.get(transcriptIdentity(row.project_id, row.bundle_id)) : undefined;
      return bundle === undefined ? [] : [bundle];
    }));
    for (const row of page) {
      try {
        const references = await restoredCaptureReferences(db, table, row, outcome);
        if (row.payload_format === 'archived') {
          const bundle = context.bundles.get(transcriptIdentity(row.project_id, row.bundle_id));
          if (bundle === undefined) throw new BackupApplyError(table, 'an archived event lacks its bundle');
          const restoredId = await restoredBundleId(context, transcriptIdentity(row.project_id,row.bundle_id));
          if (restoredId === undefined) throw new BackupApplyError(table, 'an archived event lacks its restored bundle');
          inserted += await restoreArchivedEvent(db, {...row,bundle_id:restoredId}, {...bundle,id:restoredId}, references);
        } else {
          const columns = Object.keys(row);
          const statements = [...references,
            db.prepare(`INSERT OR IGNORE INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`)
              .bind(...columns.map(column => row[column] ?? null))];
          const applied = await db.batch(statements);
          inserted += applied.at(-1)!.results.length;
        }
      } catch (error) {
        if (error instanceof RestoreAuthorizationError || error instanceof BackupApplyError) throw error;
        throw restoreRefusal(table, error);
      }
    }
    counted(inserted);
    return page.length;
  }
  if (table === 'event_refs') {
    let inserted=0;
    for(const row of page) {
      const result=await db.batch([...await restoredCaptureReferences(db, table, row, outcome),
        ...contentAssertion(db,'EXISTS (SELECT 1 FROM events WHERE project_id=? AND event_id=? AND session_id=? AND kind=?)',
          [row.project_id,row.event_id,row.session_id,row.kind]),eventReferenceStatement(db,row,false)]);
      inserted+=result.at(-1)!.results.length;
    }
    counted(inserted);
    return page.length;
  }
  if (table === 'registered_content_proofs') {
    let inserted = 0;
    for (const row of page) {
      const columns = Object.keys(row);
      const values = columns.filter(column => column !== 'generation');
      const compared = values.filter(column => column !== 'verified_at');
      try {
        const [applied] = await db.batch([db.prepare(`INSERT OR IGNORE INTO registered_content_proofs (${columns.join(', ')})
          SELECT ${columns.map(column => column === 'generation' ? 'b.generation' : '?').join(', ')}
          FROM blobs b WHERE b.project_id = ? AND b.key = ? AND b.size = ?
            AND b.key = ? RETURNING rowid`)
          .bind(...values.map(column => row[column] ?? null), row.project_id, row.key, row.size, row.digest),
          db.prepare(`INSERT INTO restore_reference_guard (missing)
            SELECT 'registered content proof' WHERE NOT EXISTS (
              SELECT 1 FROM registered_content_proofs p JOIN blobs b
                ON b.project_id = p.project_id AND b.key = p.key AND b.generation IS p.generation
              WHERE ${compared.map(column => `p.${column} IS ?`).join(' AND ')} AND b.size = p.size)`)
            .bind(...compared.map(column => row[column] ?? null))]);
        inserted += applied!.results.length;
      } catch (error) {
        if (error instanceof RestoreAuthorizationError) throw error;
        throw restoreRefusal(table, error);
      }
    }
    counted(inserted);
    return page.length;
  }
  if (table === 'processed_resources' && pending.every(row => row.kind === 'tool-input')) {
    counted(0, all.length, { skipped: 'displayed input restoration owns processed references' });
    return pending.length;
  }
  return restoreChunks(context, table, all, pending, budget);
}

/**
 * What an insertion-ordered table reports when another write landed in it while the restore was filling it: the
 * restore leaves the rest of that table out rather than give the artifact's rows other ids, and goes on to the next.
 */
const interleavedWrite = (restored: number, rows: number): string =>
  `another write landed in this table while the restore was filling it, and its ids are insertion-ordered, so ${restored} of ${rows} rows were restored and the rest left out; to restore them all, restore this backup into a Deployment where nothing writes to this table until the restore completes`;

/** The invocation running a pass ran out of what it may spend; the next invocation takes the same unit again. */
export const invocationSpent = (error: unknown): boolean => /_budget_exhausted\b/.test(error instanceof Error ? error.message : String(error));

/** A store error that names a rule the artifact broke: a constraint, a trigger's refusal or an in-batch refusal. */
function refusedByStore(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return classify(error) === 'constraint' || /SQLITE_CONSTRAINT|JSON path/i.test(message)
    || (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'));
}

/**
 * The refusal a write met, named for the table it was writing; any other error (a spent budget, a platform limit, a
 * lost connection) is thrown as it is, so the job tries the same unit again instead of ending.
 */
function restoreRefusal(table: string, error: unknown): Error {
  if (error instanceof BackupApplyError || error instanceof RestoreAuthorizationError) return error;
  if (!refusedByStore(error)) return error instanceof Error ? error : new Error(String(error));
  return new BackupApplyError(table, error instanceof Error ? error.message : String(error), error);
}

/** The general path: additive inserts in chunks, each chunk one batch; an insertion-ordered table commits its claim's progress in that batch. */
async function restoreChunks(context: TablePassContext, table: string, all: Row[], pending: Row[], budget: number): Promise<number> {
  const { db, prepared, outcome, decided, hash } = context;
  const counted = (inserted: number, extra: { skipped?: string } = {}) => {
    const held = outcome.tables[table];
    outcome.tables[table] = { rows: all.length, inserted: (held?.inserted ?? 0) + inserted, ...extra };
  };
  const eligible = table === 'processed_resources' ? all.filter(row => row.kind !== 'tool-input') : all;
  const waiting = new Set(pending);
  const from = eligible.findIndex((row) => waiting.has(row));
  const rows = from === -1 ? [] : eligible;
  const ordered = EMPTY_ONLY_TABLES.has(table);
  if (ordered && (rows.some((row) => !Number.isSafeInteger(row.id)) || new Set(rows.map((row) => row.id)).size !== rows.length)) {
    throw new BackupApplyError(table, 'insertion-ordered rows require unique safe integer ids');
  }
  const progress = ordered ? await claimRestoreTable(db, table, hash) : null;
  if (ordered && progress === null) {
    counted(0, { skipped: 'table already holds rows, and its ids are insertion-ordered; restored only into an empty table' });
    return pending.length;
  }
  if (progress !== null) {
    // Rows a pass committed before this restore credited them are compared with what the table holds now.
    for (let start = Math.max(from, 0); start < progress.next_row; start += RESTORE_CHUNK_ROWS) {
      const committed = rows.slice(start, Math.min(start + RESTORE_CHUNK_ROWS, progress.next_row));
      const match = await db.prepare(`SELECT ${restoredRowsMatch(table, committed)} AS matches`)
        .bind(JSON.stringify(committed)).first<{ matches: number }>();
      if (match?.matches !== 1) {
        counted(0, { skipped: interleavedWrite(start, rows.length) });
        return pending.length;
      }
    }
  }
  let inserted = 0;
  let at = progress === null ? Math.max(from, 0) : Math.max(progress.next_row, from);
  let spent = 0;
  while (at < rows.length && spent < budget) {
    const chunk = rows.slice(at, at + RESTORE_CHUNK_ROWS);
    const next = at + chunk.length;
    const guard = ordered
      ? ` WHERE EXISTS (SELECT 1 FROM backup_restore_progress WHERE ${RESTORE_OWNER})`
      : '';
    const references = chunk.flatMap((row) => referencedBlobsOf(table, row));
    const statements = references.length === 0 ? [] : [registeredBlobsGuard(db, references)];
    const budgetKeys:Readonly<Record<string,readonly string[]>>={agent_runs:['project_id','id'],agent_run_attempts:['project_id','run_id','attempt_id'],agent_state:['project_id','agent_id','key']};
    const keys=budgetKeys[table];
    if(keys!==undefined) {
      const compared=chunk.map(row=>table==='agent_run_attempts'?attemptRestoreComparison(row):Object.fromEntries(keys.map(key=>[key,row[key]])));
      const profiledTimes=table==='agent_run_attempts'?chunk.flatMap(row=>row.profile_json!=null&&typeof row.claimed_at==='number'?[row.claimed_at]:[]):[];
      const restoredFloor=profiledTimes.length===0?undefined:profiledTimes.reduce((floor,time)=>Math.min(floor,time),Infinity);
      statements.push(...estimateInvalidationStatements(db,{sql:`NOT (${restoredRowsMatch(table,compared,keys)})`,params:[JSON.stringify(compared)]},restoredFloor));
    }
    const inserts=statements.length;
    statements.push(...chunk.map((row) => {
      if (table === 'deployment_ownership_audit') return restoreAuthorityAuditStatement(db, table, row, prepared.ownership);
      if (table === 'member_role_audit') return restoreAuthorityAuditStatement(db, table, row,
        prepared.byTable.get('members')?.find(member => member.id === row.member_id));
      const restoreOwned = OWNED_ROW_RESTORERS[table];
      if (restoreOwned !== undefined) return restoreOwned(db, row, decided);
      const columns = Object.keys(row);
      return db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}${guard} RETURNING rowid`)
        .bind(...columns.map((c) => row[c] ?? null), ...(ordered ? [table, hash, at] : []));
    }));
    if (table === 'raw_archive_refs') statements.push(...chunk.filter(row => row.source_kind === 'transcript' && row.disposition === 'archived' && typeof row.transcript_id === 'string')
      .map(row => clearArchivedTranscriptRanges(db, row.project_id as string, row.transcript_id as string, row.base_offset as number)));
    if (table === 'sessions' || table === 'session_tombstones') statements.push(...deletedParentClears(db, chunk));
    if (ordered) {
      statements.push(db.prepare(`UPDATE backup_restore_progress SET next_row = ?, verified = ${restoredRowsMatch(table, chunk)}
        WHERE ${RESTORE_OWNER} RETURNING next_row`)
        .bind(next, JSON.stringify(chunk), table, hash, at));
    }
    let applied;
    try {
      applied = table === 'members'
        ? await restoreMembershipBatch(db, statements, chunk.some(row => row.id !== HARNESS_MEMBER_ID))
        : await db.batch(statements);
    } catch (err) {
      if (err instanceof RestoreAuthorizationError) throw err;
      if (ordered && /backup_restore_rows_match/.test(err instanceof Error ? err.message : String(err))) {
        counted(inserted, { skipped: interleavedWrite(at, rows.length) });
        return pending.length;
      }
      const missing = await unregisteredAmong(db, references);
      if (missing.length > 0) throw new BackupObjectsMissingError(missing.length);
      throw restoreRefusal(table, err);
    }
    for (const result of applied.slice(inserts, inserts + chunk.length)) inserted += result.results.length;
    spent += chunk.length;
    if (ordered && applied[inserts + chunk.length]!.results.length === 0) {
      const current = await readRestoreProgress(db, table);
      if (current?.artifact_hash !== hash || current.next_row <= at) {
        counted(inserted, { skipped: interleavedWrite(at, rows.length) });
        return pending.length;
      }
      at = current.next_row;
    } else {
      at = next;
    }
  }
  counted(inserted);
  if (at >= rows.length) return pending.length;
  const resume = rows[at]!;
  const index = pending.indexOf(resume);
  return index === -1 ? pending.length : index;
}

/** The deleted-parent clear for every Project a restored `sessions` or `session_tombstones` chunk names, run in the chunk's own batch. */
function deletedParentClears(db: RelationalStore, chunk: readonly Record<string, unknown>[]): PreparedStatement[] {
  const byProject = new Map<string, string[]>();
  for (const row of chunk) {
    if (typeof row.project_id !== 'string' || typeof row.session_id !== 'string') continue;
    byProject.set(row.project_id, [...byProject.get(row.project_id) ?? [], row.session_id]);
  }
  return [...byProject].map(([projectId, sessionIds]) => clearDeletedParentsStatement(db, projectId, sessionIds));
}

/** One stored artifact's text and index row, for the download surface. */
export async function backupArtifact(db: RelationalStore, blobs: BlobStore, id: string): Promise<{ row: BackupIndexRow; text: string } | null> {
  return readArtifact(db, blobs, id);
}

/** Reads one artifact, compares it with what its row recorded, and records the outcome; null when no such backup exists. */
export async function verifyBackup(db: RelationalStore, blobs: BlobStore, id: string, now: number): Promise<BackupVerification | null> {
  const row = await readBackupRow(db, id);
  if (row === null) return null;
  if (row.size_bytes > MAX_BACKUP_BYTES) throw new BackupTooLargeError(row.size_bytes);
  const checked = await checkStoredArtifact(blobs, row);
  const state = checked.detail !== null ? 'failed' as const : row.sha256 === null ? null : 'verified' as const;
  const recorded = await recordBackupVerification(db, { id, key: row.key, state, checkedAt: now, detail: checked.detail });
  return recorded ? { state: state ?? 'unverified', checkedAt: now, detail: checked.detail } : null;
}

/** Pin or unpin one index row; a pinned backup is exempt from retention and consumes no slot. */
export async function setBackupPinned(db: RelationalStore, id: string, pinned: boolean): Promise<boolean> {
  return pinBackup(db,id,pinned);
}
