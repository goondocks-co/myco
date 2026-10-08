import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID } from '../constants.js';
import { restoreAuthorityAuditStatement, restoreMembershipBatch } from './ownership.js';
import { effectiveRawOwnerSql, reserveRawRestore, restoreOwnership } from './raw-claims.js';
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
import { publishBackupObject, referencedBlobsOf, registeredBlobsGuard, releaseBackups, unregisteredAmong,
  recordBlobCandidates, releaseBlobs } from './object-release.js';
import { currentRetentionVictims, type BackupRetentionPolicy } from './backup-retention.js';
export { retentionVictims } from './backup-retention.js';
import type { BlobRef } from './blob-references.js';
import { assertArchivedContentClosure, assertBundleObjectClosure, assertCaptureClosure, relationalSnapshot, RelationalSnapshotTooLargeError } from './relational-snapshot.js';
import { verifyBundleArtifact, type BundleEntryIdentity } from './archive-bundle.js';
import { restoreArchivedEvent } from './event-content.js';
import { restoreToolInput } from './tool-input-restore.js';
export { RelationalSnapshotAdmissionError as BackupAdmissionError } from './relational-snapshot.js';
import { restoreParserCheckpointStatement } from '../ingest/parser-checkpoint.js';
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
  'projects', 'project_remotes', 'members', 'device_decision_audit', 'device_requests', 'machine_claims', 'uncaptured_roots', 'enrollment_authorities', 'identity_link_authorities',
  'member_credentials', 'runners', 'runner_credentials', 'runner_audit', 'deployment_ownership', 'deployment_ownership_audit', 'member_role_audit', 'raw_provenance_state', 'raw_provenance_backfill', 'raw_claims', 'raw_credentials', 'agents',
  'sessions', 'session_tombstones', 'blobs', 'archive_bundles', 'registered_content_proofs', 'prepared_archive_bundles', 'events', 'prompt_batches', 'tool_calls', 'processed_resources', 'responses', 'plans',
  'attachments', 'transcripts', 'transcript_parser_state_chunks', 'transcript_segments', 'raw_resources', 'raw_archive_refs', 'tags',
  'agent_tasks', 'agent_runs', 'agent_run_attempts', 'agent_run_steps', 'run_reads', 'agent_state', 'spores', 'resolution_events', 'spore_injections', 'session_injections',
  'skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage',
  'digest_extracts', 'cortex_instructions', 'canopy_maps', 'knowledge_release_state', 'external_grants',
  'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports',
  'digest_extract_revisions', 'knowledge_git_provenance',
];

/**
 * Append-only tables whose integer id IS the insertion order. Their ids are
 * per-database, so an additive merge into a populated table would drop rows
 * that collide on id while looking idempotent. A restore claims an empty
 * table and resumes only the same artifact; unclaimed history is skipped.
 */
export const EMPTY_ONLY_TABLES: ReadonlySet<string> = new Set([
  'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports',
  'digest_extract_revisions', 'knowledge_git_provenance',
]);

/**
 * Tables an artifact never carries, each for a stated reason: migration-owned
 * state, transient upload-reservation state, the credential-store table nothing else may
 * touch, the backup index itself, the migration guard and holding tables, operator
 * configuration, and current machine and worker reports, which attached machines send again. Settings (the Deployment's and each machine's), capability
 * admissions, repository connections, release provenance settings and sealed secrets require their validated writers and a recorded actor.
 * Operators re-enter configuration on the dashboard after a restore. Embedding state is rebuilt from the sources an
 * artifact carries; the sources embedding passes over are found again, and an embedding model switch is not carried, so a restored Deployment
 * spends on another model only once an admin there starts the switch again.
 */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'search_blob_queue', 'search_blob_chunks',
  'embedding_versions', 'embedding_receipts', 'embedding_cursors', 'embedding_hubness_work', 'embedding_hubness_members', 'embedding_switches', 'embedding_source_failures', 'local_vectors',
  ...['prompt_batches', 'responses', 'spores', 'plans', 'skill_records', 'sessions', 'search_blob_chunks']
    .flatMap((table) => ['', '_data', '_idx', '_docsize', '_config'].map((suffix) => `${table}_fts${suffix}`)),
  'raw_restore_revisions', 'schema_meta', 'member_tokens', 'blob_reservations', 'step_up_authorities',
  'deployment_settings', 'deployment_setting_resets', 'retired_deployment_settings', 'machine_settings', 'project_capabilities', 'project_repositories', 'project_release_provenance', 'deployment_secrets', 'backups',
  'backup_restore_progress', 'recovery_forget_commands',
  'storage_cleanup_state', 'storage_cleanup_queue', 'storage_cleanup_omissions', 'content_scan_checkpoints', 'raw_archive_state', 'raw_event_archive_state', 'orphan_sweep_state', 'storage_content_guard',
  'object_releases', 'blob_release_candidates', 'backup_release_candidates', 'recovery_holds', 'restore_reference_guard',
  'worker_contacts', 'worker_model_catalogs', 'runner_contacts', 'runner_model_catalogs', 'machine_harness_reports', 'machine_settings_snapshots',
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

export interface ForeignAuthorityExclusion {
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
  constructor(readonly table: string, detail: string) {
    super(`the artifact could not be applied at ${table}: ${detail}; committed chunks are preserved; retry the same artifact after resolving the error`);
    this.name = 'BackupApplyError';
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

const metaValue = async (db: RelationalStore, key: string): Promise<string | null> => {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
};

/** The lineage id the v13 migration seeded. A store this reads on predates nothing: the migration runs first on both targets. */
export async function deploymentId(db: RelationalStore): Promise<string> {
  const value = await metaValue(db, 'deployment_id');
  if (value === null) throw new Error('this store carries no deployment_id; its migrations have not run');
  return value;
}

const tableCount = async (db: RelationalStore, table: string): Promise<number> => {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
  return row?.c ?? 0;
};

const MACHINE_REPORT_COLUMNS = new Set(['settings_cached_revision', 'settings_cached_values', 'settings_report_order', 'settings_contract_supported']);

/** Portable machine identities carry no confirmation of the attached member's current cache. */
function portableRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  return table === 'machine_claims' ? Object.fromEntries(Object.entries(row).filter(([column]) => !MACHINE_REPORT_COLUMNS.has(column))) : row;
}

/** Create one backup artifact and its index row; answers the index row written. */
export async function createBackup(
  db: RelationalStore, blobs: BlobStore, opts: { producer: string; now: number },
): Promise<BackupIndexRow> {
  const snapshot = await relationalSnapshot(db, ['schema_meta', ...BACKUP_TABLES], MAX_BACKUP_BYTES).catch((error: unknown) => {
    if (error instanceof RelationalSnapshotTooLargeError) throw new BackupTooLargeError(error.bytes);
    throw error;
  });
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
    for (const columns of snapshot.get(table)!) {
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

  const id = `bk_${crypto.randomUUID()}`;
  const key = `${BACKUP_KEY_PREFIX}${lineage}__${opts.now}__${id}.jsonl`;
  const artifact = utf8([headerLine, ...lines].join('\n') + '\n');
  const sha256 = await sha256HexOf(artifact);
  return publishBackupObject(db, blobs, key,
    () => blobs.put(key, new Response(artifact).body, { sha256, httpMetadata: { contentType: 'application/jsonl' } }),
    async size => {
      const row: BackupIndexRow = {
        id, key, created_at: opts.now, size_bytes: size,
        counts_json: JSON.stringify(counts), schema_version: stamped, producer: opts.producer, pinned: 0, sha256,
      };
      await db.prepare(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .bind(row.id, row.key, row.created_at, row.size_bytes, row.counts_json, row.schema_version, row.producer, row.sha256).run();
      return row;
    });
}

export interface ListedBackup extends BackupIndexRow {
  /** Whether the named object is actually in the store; an index row whose object vanished renders broken, never healthy. */
  present: boolean;
}

/** The instant of the newest backup the index records, or null when it records none. */
export async function latestBackupAt(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT MAX(created_at) AS at FROM backups`).first<{ at: number | null }>();
  return row?.at ?? null;
}

/** Every index row, newest first, each verified against the object store. */
export async function listBackups(db: RelationalStore, blobs: BlobStore, limit = 100): Promise<ListedBackup[]> {
  const { results } = await db
    .prepare(`SELECT ${INDEX_COLUMNS}
        FROM backups ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit).all<BackupIndexRow>();
  const listed: ListedBackup[] = [];
  for (const row of results) {
    const head = await blobs.head(row.key);
    listed.push({ ...row, present: head !== null });
  }
  return listed;
}

const decoder = new TextDecoder();

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
  const stored = await readStoredObject(blobs, row.key, row.size_bytes);
  if (stored.kind === 'absent') return null;
  if (stored.kind === 'size_mismatch') throw new BackupIntegrityError(row.id, 'size');
  if (row.sha256 !== null && await sha256HexOf(stored.bytes) !== row.sha256) throw new BackupIntegrityError(row.id, 'sha256');
  return { row, text: decoder.decode(stored.bytes) };
};

/** Recognized row envelopes in an artifact, for both preview and apply. */
function* restoreRows(lines: Iterable<string>): IterableIterator<{ t: string; r: Record<string, unknown> }> {
  for (const line of lines) {
    if (line.length === 0) continue;
    const row = JSON.parse(line) as { t: string; r: Record<string, unknown> };
    if (BACKUP_TABLES.includes(row.t)) yield row;
  }
}

/** What a restore would touch, answered from a verified artifact without executing its rows. */
export async function previewRestore(
  db: RelationalStore, blobs: BlobStore, id: string,
): Promise<{ header: BackupHeader; foreignLineage: boolean; authorityExcluded: ForeignAuthorityExclusion | null; tableKeys: string[] } | null> {
  const artifact = await readArtifact(db, blobs, id);
  if (artifact === null) return null;
  const newline = artifact.text.indexOf('\n');
  if (newline === -1) return null;
  const header = JSON.parse(artifact.text.slice(0, newline)) as BackupHeader;
  const tableKeys = new Set<string>();
  for (const row of restoreRows(artifact.text.slice(newline + 1).split('\n'))) tableKeys.add(row.t);
  const foreignLineage = header.deploymentId !== (await deploymentId(db));
  const authorityExcluded = foreignLineage
    ? { tables: FOREIGN_AUTHORITY_TABLES.filter((table) => tableKeys.has(table)), notice: FOREIGN_AUTHORITY_NOTICE }
    : null;
  return { header, foreignLineage, authorityExcluded, tableKeys: [...tableKeys] };
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

export interface RestoreOutcome {
  /** `reused` counts `blobs` rows this Deployment already registers, kept as they stand. */
  tables: Record<string, { rows: number; inserted: number; skipped?: string; reused?: number }>;
}

interface RestoreProgress {
  artifact_hash: string;
  next_row: number;
}

const RESTORE_OWNER = 'table_name = ? AND artifact_hash = ? AND next_row = ?';

type ArtifactRow = Record<string, unknown>;
type OwnedRowRestorer = (db: RelationalStore, row: ArtifactRow, parents: ReadonlyMap<string, ArtifactRow>) => PreparedStatement;

/** Owned state restores through the capability that admits its writes. */
const OWNED_ROW_RESTORERS: Readonly<Partial<Record<string, OwnedRowRestorer>>> = {
  transcript_parser_state_chunks(db, row, parents) {
    const parent = parents.get(transcriptIdentity(row.project_id, row.transcript_id));
    if (parent === undefined) throw new BackupApplyError('transcript_parser_state_chunks', 'a checkpoint row names no transcript in the artifact');
    return restoreParserCheckpointStatement(db, row, parent);
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
function restoredRowsMatch(table: string, rows: readonly Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const mismatch = columns.map((column) =>
    `(json_type(expected.value, '$.${column}') IS NOT NULL AND held.${column} IS NOT json_extract(expected.value, '$.${column}'))`);
  return `NOT EXISTS (SELECT 1 FROM json_each(?) AS expected
    LEFT JOIN ${table} AS held ON held.id = json_extract(expected.value, '$.id')
    WHERE held.id IS NULL OR ${mismatch.join(' OR ')})`;
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

/**
 * Apply one artifact: refusal gates first, then additive `INSERT OR IGNORE`
 * per row in bounded batches. Rows the target already holds stay exactly as
 * they are — a restore never overwrites, so the target's revocations and
 * edits always win. A re-run converges: every insert is a no-op the second time.
 * An artifact from another Deployment inserts its authority already revoked
 * (`FOREIGN_AUTHORITY_TABLES`) and leaves this Deployment's owner as it is.
 */
export async function restoreBackup(
  db: RelationalStore, blobs: BlobStore,
  opts: { id: string; allowForeignLineage?: boolean; authorization: RestoreAuthorization; now?: number },
): Promise<RestoreOutcome | null> {
  const artifact = await readArtifact(db, blobs, opts.id);
  if (artifact === null) return null;
  return restoreArtifact(db, { text: artifact.text, blobs, allowForeignLineage: opts.allowForeignLineage, authorization: opts.authorization, now: opts.now });
}

/**
 * Apply one artifact's text — the path an uploaded artifact shares with a
 * stored one, so both meet the same gates in the same order.
 */
export async function restoreArtifact(
  db: RelationalStore,
  opts: { text: string; blobs?: BlobStore; allowForeignLineage?: boolean; authorization: RestoreAuthorization; now?: number },
): Promise<RestoreOutcome> {
  const lines = opts.text.split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]!) as BackupHeader;

  const live = await deploymentId(db);
  if (header.deploymentId !== live && opts.allowForeignLineage !== true) throw new BackupLineageError(header.deploymentId, live);
  const stamped = Number(await metaValue(db, 'version'));
  if (header.schemaVersion > stamped) throw new BackupSchemaError(header.schemaVersion, stamped);

  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const parsed of restoreRows(lines.slice(1))) {
    const rows = byTable.get(parsed.t) ?? [];
    rows.push(portableRow(parsed.t, parsed.r));
    byTable.set(parsed.t, rows);
  }
  const foreign = header.deploymentId !== live;
  if (foreign) revokeForeignAuthority(byTable, opts.now ?? Date.now());

  db = await authorizeRestore(db, opts.authorization, byTable.keys());
  try { assertArchivedContentClosure(byTable); }
  catch (error) { throw new BackupApplyError('archive_bundles', error instanceof Error ? error.message : String(error)); }

  // Blob rows are never inserted: each must already be registered here, with the bytes its own row names. Checked
  // before any table is written, so a refused artifact changes nothing.
  const artifactBlobs = byTable.get('blobs') ?? [];
  const named = artifactBlobs.map((row) => ({ projectId: row.project_id, key: row.key }))
    .filter((pair): pair is BlobRef => typeof pair.projectId === 'string' && typeof pair.key === 'string');
  if (named.length !== artifactBlobs.length) throw new BackupApplyError('blobs', 'a row carries no project and key');
  const absent = await unregisteredAmong(db, named);
  if (absent.length > 0) throw new BackupObjectsMissingError(absent.length);
  const artifactBundles = byTable.get('archive_bundles') ?? [];
  if (artifactBundles.length > 0 && opts.blobs === undefined) {
    throw new BackupApplyError('archive_bundles','bundle objects require a content store for restore verification');
  }
  for (const row of artifactBundles) {
    const locators: BundleEntryIdentity[] = [];
    for (const event of byTable.get('events') ?? []) {
      if (event.project_id !== row.project_id || event.bundle_id !== row.id) continue;
      locators.push({projectId:row.project_id as string,entry:event.bundle_entry as number,kind:'event',
        resourceId:event.event_id as string,eventId:event.event_id as string,
        envelopeHash:event.envelope_hash as string,tokenId:event.token_id as string});
    }
    for (const tool of byTable.get('tool_calls') ?? []) {
      if (tool.project_id !== row.project_id || tool.input_bundle_id !== row.id) continue;
      locators.push({projectId:row.project_id as string,entry:tool.input_bundle_entry as number,
        kind:'tool-input',resourceId:tool.tool_call_id as string,tokenId:tool.token_id as string});
    }
    try {
      await verifyBundleArtifact({db,blobs:opts.blobs!},row as Parameters<typeof verifyBundleArtifact>[1],
        byTable.get('registered_content_proofs') ?? [],locators);
    } catch (error) {
      throw new BackupApplyError('archive_bundles',error instanceof Error ? error.message : String(error));
    }
  }

  const ownership = byTable.get('deployment_ownership')?.[0];
  const ownerAudit = ownership?.member_id == null ? undefined : (byTable.get('deployment_ownership_audit') ?? [])
    .find((row) => row.member_id === ownership.member_id && row.revision === ownership.revision);
  if (ownership?.member_id != null && (ownerAudit === undefined || typeof ownerAudit.actor_id !== 'string' || !Number.isSafeInteger(ownerAudit.created_at))) {
    throw new BackupApplyError('deployment_ownership', 'ownership requires its matching audit receipt');
  }

  const outcome: RestoreOutcome = { tables: {} };
  const transcriptParents = new Map((byTable.get('transcripts') ?? []).map((row) => [transcriptIdentity(row.project_id, row.transcript_id), row]));
  const hash = await sha256Hex(opts.text);
  const provenance = ['raw_provenance_state', 'raw_resources', 'raw_archive_refs', 'raw_claims', 'events', 'blobs', 'transcripts', 'attachments', 'prompt_batches', 'responses', 'plans', 'tool_calls'].flatMap((table) => byTable.get(table) ?? []);
  const sourceRevision = provenance.reduce((max, row) => Math.max(max,
    ...['revision','raw_revision','cutoff_revision'].map((key) => typeof row[key] === 'number' ? row[key] as number : 0)), 0);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new BackupApplyError('raw_claims', 'invalid raw provenance revision');
  const offset = provenance.length === 0 ? 0 : await reserveRawRestore(db, hash, sourceRevision);
  for (const table of ['raw_resources', 'raw_archive_refs', 'raw_claims', 'events']) {
    for (const row of byTable.get(table) ?? []) {
      if (table === 'raw_resources') row.reference_id = `restore:${hash}:${String(row.reference_id)}`;
      for (const key of table === 'raw_claims' ? ['min_revision', 'cutoff_revision'] : table === 'events' || table === 'raw_archive_refs' ? ['raw_revision'] : ['revision']) {
        if (table === 'raw_claims' && key === 'min_revision' && row[key] === undefined) row[key] = 0;
        if (typeof row[key] === 'number') row[key] = (row[key] as number) + offset;
      }
    }
  }
  const transcriptRows = new Map((byTable.get('transcripts') ?? []).map((row) => [transcriptIdentity(row.project_id, row.transcript_id), row]));
  const bundles = new Map((byTable.get('archive_bundles') ?? []).map((row) => [transcriptIdentity(row.project_id, row.id), row]));
  const restoredBundleIds = new Map<string, number>();
  const insertedBundles: Array<{projectId:string;id:number;archiveKey:string;receiptKey:string}> = [];
  const artifactEvents = new Map((byTable.get('events') ?? []).map(row => [transcriptIdentity(row.project_id, row.event_id), row]));
  const displayedInputs = new Set((byTable.get('tool_calls') ?? [])
    .filter(row => typeof row.input === 'string' && typeof row.input_bytes === 'number'
      && row.input_bytes > 2048 && typeof row.input_blob_key === 'string')
    .map(row => transcriptIdentity(row.project_id, row.tool_call_id)));
  const transcriptSegments = new Map<string, Record<string, unknown>[]>();
  for (const row of byTable.get('transcript_segments') ?? []) {
    const identity = transcriptIdentity(row.project_id, row.transcript_id);
    const segments = transcriptSegments.get(identity) ?? [];
    segments.push(row);
    transcriptSegments.set(identity, segments);
  }
  for (const table of BACKUP_TABLES) {
    let rows = byTable.get(table) ?? [];
    const artifactRowCount = rows.length;
    if (rows.length === 0) continue;
    if (table === 'raw_provenance_state' || table === 'raw_provenance_backfill') {
      outcome.tables[table] = { rows: rows.length, inserted: 0, skipped: 'destination provenance checkpoint owns the restored revision reservation' };
      continue;
    }
    if (table === 'deployment_ownership') {
      if (foreign) {
        outcome.tables[table] = { rows: rows.length, inserted: 0, skipped: 'this server keeps its own owner; another server\'s owner is not restored' };
        continue;
      }
      const row = rows[0]!;
      if (typeof row.member_id === 'string') await restoreOwnership(db, { member_id: row.member_id, revision: Number(row.revision) },
        { actor_id: ownerAudit!.actor_id as string, created_at: ownerAudit!.created_at as number,
          previous_member_id: ownerAudit!.previous_member_id as string | null | undefined, operation: ownerAudit!.operation as string | undefined });
      outcome.tables[table] = { rows: rows.length, inserted: 0 };
      continue;
    }
    if (table === 'blobs') {
      outcome.tables[table] = { rows: rows.length, inserted: 0, reused: rows.length };
      continue;
    }
    if (table === 'archive_bundles') {
      let inserted = 0;
      for (const row of rows) {
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
        const held = await db.prepare(`SELECT * FROM archive_bundles WHERE project_id=? AND archive_key=?`)
          .bind(row.project_id,row.archive_key).first<Record<string,unknown>>();
        if (held === null || columns.some(column => held[column] !== (row[column] ?? null))
          || !Number.isSafeInteger(held.id)) throw new BackupApplyError(table, 'a bundle conflicts with the destination');
        restoredBundleIds.set(transcriptIdentity(row.project_id,row.id),held.id as number);
        if (applied!.results.length > 0) insertedBundles.push({projectId:row.project_id as string,id:held.id as number,
          archiveKey:row.archive_key as string,receiptKey:row.receipt_key as string});
      }
      outcome.tables[table] = {rows:rows.length,inserted};
      continue;
    }
    for (const row of rows) {
      if (!Object.keys(row).every((c) => IDENTIFIER.test(c))) throw new BackupApplyError(table, 'a row carries a column name outside the store grammar');
    }
    if (table === 'raw_resources') {
      let inserted = 0;
      for (const row of rows) {
        const columns = Object.keys(row);
        const insert = db.prepare(`INSERT OR IGNORE INTO raw_resources (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`)
          .bind(...columns.map((column) => row[column] ?? null));
        try {
          const identity = transcriptIdentity(row.project_id, row.resource_id);
          inserted += row.kind === 'transcript'
            ? await restoreTranscriptReference(db, row, transcriptRows.get(identity), transcriptSegments.get(identity) ?? [], insert)
            : (await insert.all()).results.length;
        } catch (error) {
          if (error instanceof RestoreAuthorizationError) throw error;
          throw new BackupApplyError(table, error instanceof Error ? error.message : String(error));
        }
      }
      outcome.tables[table] = { rows: rows.length, inserted };
      continue;
    }
    if (table === 'events') {
      let inserted = 0;
      for (const row of rows) {
        try {
          if (row.payload_format === 'archived') {
            const bundle = bundles.get(transcriptIdentity(row.project_id, row.bundle_id));
            if (bundle === undefined) throw new BackupApplyError(table, 'an archived event lacks its bundle');
            const restoredId = restoredBundleIds.get(transcriptIdentity(row.project_id,row.bundle_id));
            if (restoredId === undefined) throw new BackupApplyError(table, 'an archived event lacks its restored bundle');
            inserted += await restoreArchivedEvent(db, {...row,bundle_id:restoredId}, {...bundle,id:restoredId});
          } else {
            const references = referencedBlobsOf(table, row);
            const columns = Object.keys(row);
            const statements = [...(references.length === 0 ? [] : [registeredBlobsGuard(db, references)]),
              db.prepare(`INSERT OR IGNORE INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`)
                .bind(...columns.map(column => row[column] ?? null))];
            const applied = await db.batch(statements);
            inserted += applied.at(-1)!.results.length;
          }
        } catch (error) {
          if (error instanceof RestoreAuthorizationError || error instanceof BackupApplyError) throw error;
          throw new BackupApplyError(table, error instanceof Error ? error.message : String(error));
        }
      }
      outcome.tables[table] = { rows: rows.length, inserted };
      continue;
    }
    if (table === 'tool_calls') {
      let inserted = 0;
      for (const row of rows) {
        try {
          if (row.input_bundle_id !== null && row.input_bundle_id !== undefined) {
            const restoredId = restoredBundleIds.get(transcriptIdentity(row.project_id,row.input_bundle_id));
            if (restoredId === undefined) throw new BackupApplyError(table, 'a tool input lacks its restored bundle');
            row.input_bundle_id = restoredId;
          }
          const identity = transcriptIdentity(row.project_id, row.tool_call_id);
          if (displayedInputs.has(identity)) {
            const outcomeEvent = artifactEvents.get(transcriptIdentity(row.project_id, row.event_id));
            const processed = (byTable.get('processed_resources') ?? []).find(candidate => candidate.project_id === row.project_id
              && candidate.kind === 'tool-input' && candidate.resource_id === row.tool_call_id && candidate.blob_key === row.input_blob_key);
            const inputEvent = processed === undefined ? undefined : artifactEvents.get(transcriptIdentity(row.project_id, processed.event_id));
            if (outcomeEvent === undefined || inputEvent === undefined || processed === undefined) {
              throw new BackupApplyError(table, 'a displayed input lacks its source or processed reference');
            }
            const proofs = (byTable.get('registered_content_proofs') ?? []).filter(proof => proof.project_id === row.project_id
              && ((proof.source_kind === 'tool-input' && proof.source_id === row.tool_call_id && proof.key === row.input_blob_key)
                || (proof.source_kind === 'receipt' && proof.source_id === `tool-input:${String(row.tool_call_id)}`)));
            inserted += await restoreToolInput(db, row, outcomeEvent, inputEvent, processed, proofs);
          } else {
            const references = referencedBlobsOf(table, row);
            const columns = Object.keys(row);
            const bundledGuard = row.input_bundle_id === null || row.input_bundle_id === undefined ? [] : [
              db.prepare(`INSERT INTO restore_reference_guard (missing)
                SELECT 'bundled tool input closure' WHERE NOT EXISTS (
                  SELECT 1 FROM archive_bundles a JOIN registered_content_proofs p
                    ON p.project_id=a.project_id AND p.key=a.archive_key
                    AND p.source_kind='bundle' AND p.source_id=a.archive_key AND p.durable=1
                  JOIN blobs b ON b.project_id=p.project_id AND b.key=p.key AND b.generation=p.generation
                  JOIN events e ON e.project_id=a.project_id AND e.event_id=?
                  WHERE a.project_id=? AND a.id=? AND a.session_id=? AND a.token_id=?
                    AND a.entry_count>? AND e.session_id=? AND e.envelope_hash=?)`)
                .bind(row.event_id,row.project_id,row.input_bundle_id,row.session_id,row.token_id,
                  row.input_bundle_entry,row.session_id,artifactEvents.get(transcriptIdentity(row.project_id,row.event_id))?.envelope_hash)
            ];
            const statements = [...bundledGuard, ...(references.length === 0 ? [] : [registeredBlobsGuard(db, references)]),
              db.prepare(`INSERT OR IGNORE INTO tool_calls (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`)
                .bind(...columns.map(column => row[column] ?? null))];
            const applied = await db.batch(statements);
            inserted += applied.at(-1)!.results.length;
          }
        } catch (error) {
          if (error instanceof RestoreAuthorizationError || error instanceof BackupApplyError) throw error;
          throw new BackupApplyError(table, error instanceof Error ? error.message : String(error));
        }
      }
      outcome.tables[table] = { rows: rows.length, inserted };
      continue;
    }
    if (table === 'processed_resources') {
      rows = rows.filter(row => row.kind !== 'tool-input'
        || !displayedInputs.has(transcriptIdentity(row.project_id, row.resource_id)));
      if (rows.length === 0) {
        outcome.tables[table] = { rows: artifactRowCount, inserted: 0, skipped: 'displayed input restoration owns processed references' };
        continue;
      }
    }
    if (table === 'registered_content_proofs') {
      let inserted = 0;
      for (const row of rows) {
        if ((row.source_kind === 'tool-input' && displayedInputs.has(transcriptIdentity(row.project_id, row.source_id)))
          || (row.source_kind === 'receipt' && typeof row.source_id === 'string'
            && row.source_id.startsWith('tool-input:')
            && displayedInputs.has(transcriptIdentity(row.project_id, row.source_id.slice('tool-input:'.length))))) continue;
        const columns = Object.keys(row);
        const values = columns.filter(column => column !== 'generation');
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
                WHERE ${values.map(column => `p.${column} IS ?`).join(' AND ')} AND b.size = p.size)`)
              .bind(...values.map(column => row[column] ?? null))]);
          inserted += applied!.results.length;
        } catch (error) {
          if (error instanceof RestoreAuthorizationError) throw error;
          throw new BackupApplyError(table, error instanceof Error ? error.message : String(error));
        }
      }
      outcome.tables[table] = { rows: rows.length, inserted };
      continue;
    }
    const ordered = EMPTY_ONLY_TABLES.has(table);
    if (ordered && (rows.some((row) => !Number.isSafeInteger(row.id)) || new Set(rows.map((row) => row.id)).size !== rows.length)) {
      throw new BackupApplyError(table, 'insertion-ordered rows require unique safe integer ids');
    }
    const progress = ordered ? await claimRestoreTable(db, table, hash) : null;
    if (ordered && progress === null) {
      outcome.tables[table] = { rows: rows.length, inserted: 0, skipped: 'table already holds rows, and its ids are insertion-ordered; restored only into an empty table' };
      continue;
    }
    if (progress !== null) {
      for (let start = 0; start < progress.next_row; start += RESTORE_CHUNK_ROWS) {
        const committed = rows.slice(start, Math.min(start + RESTORE_CHUNK_ROWS, progress.next_row));
        const match = await db.prepare(`SELECT ${restoredRowsMatch(table, committed)} AS matches`)
          .bind(JSON.stringify(committed)).first<{ matches: number }>();
        if (match?.matches !== 1) throw new BackupApplyError(table, 'previously restored rows changed; use a fresh destination to recover the complete artifact');
      }
    }
    let inserted = 0;
    let at = progress?.next_row ?? 0;
    while (at < rows.length) {
      const chunk = rows.slice(at, at + RESTORE_CHUNK_ROWS);
      const next = at + chunk.length;
      const guard = ordered
        ? ` WHERE EXISTS (SELECT 1 FROM backup_restore_progress WHERE ${RESTORE_OWNER})`
        : '';
      const references = chunk.flatMap((row) => referencedBlobsOf(table, row));
      const statements = references.length === 0 ? [] : [registeredBlobsGuard(db, references)];
      statements.push(...chunk.map((row) => {
        if (table === 'deployment_ownership_audit') return restoreAuthorityAuditStatement(db, table, row, ownership);
        if (table === 'member_role_audit') return restoreAuthorityAuditStatement(db, table, row,
          byTable.get('members')?.find(member => member.id === row.member_id));
        const restoreOwned = OWNED_ROW_RESTORERS[table];
        if (restoreOwned !== undefined) return restoreOwned(db, row, transcriptParents);
        const columns = Object.keys(row);
        return db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}${guard} RETURNING rowid`)
          .bind(...columns.map((c) => row[c] ?? null), ...(ordered ? [table, hash, at] : []));
      }));
      const inserts = references.length === 0 ? 0 : 1;
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
        const missing = await unregisteredAmong(db, references);
        if (missing.length > 0) throw new BackupObjectsMissingError(missing.length);
        throw new BackupApplyError(table, err instanceof Error ? err.message : String(err));
      }
      for (const result of applied.slice(inserts, inserts + chunk.length)) inserted += result.results.length;
      if (ordered && applied[inserts + chunk.length]!.results.length === 0) {
        const current = await readRestoreProgress(db, table);
        if (current?.artifact_hash !== hash || current.next_row <= at) {
          throw new BackupApplyError(table, 'the restore no longer owns this table');
        }
        at = current.next_row;
      } else {
        at = next;
      }
    }
    outcome.tables[table] = { rows: artifactRowCount, inserted };
  }
  for (const bundle of insertedBundles) {
    const unused = `NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id=? AND e.bundle_id=?)
      AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.project_id=? AND t.input_bundle_id=?)`;
    const guardValues = [bundle.projectId,bundle.id,bundle.projectId,bundle.id];
    const pairs = [{projectId:bundle.projectId,key:bundle.archiveKey},{projectId:bundle.projectId,key:bundle.receiptKey}];
    const results = await db.batch([
      db.prepare(`DELETE FROM registered_content_proofs WHERE project_id=?
        AND ((source_kind='bundle' AND source_id=?) OR (source_kind='receipt' AND source_id=?))
        AND ${unused}`).bind(bundle.projectId,bundle.archiveKey,`bundle:${bundle.archiveKey}`,...guardValues),
      db.prepare(`DELETE FROM archive_bundles WHERE project_id=? AND id=? AND ${unused}`)
        .bind(bundle.projectId,bundle.id,...guardValues),
      ...recordBlobCandidates(db,pairs,header.createdAt),
    ]);
    if (results[1]!.meta.changes > 0) {
      await releaseBlobs(db,pairs,header.createdAt);
      if (outcome.tables.archive_bundles) outcome.tables.archive_bundles.inserted--;
    }
  }
  return outcome;
}

/** One stored artifact's text and index row, for the download surface. */
export async function backupArtifact(db: RelationalStore, blobs: BlobStore, id: string): Promise<{ row: BackupIndexRow; text: string } | null> {
  return readArtifact(db, blobs, id);
}

/**
 * Prune per the policy in force, FAIL-CLOSED: any error reading the index or the policy skips the prune whole — a backup
 * that spans a schema gap is worth more than a tidy list. The retention owner names the victims, and the release owner
 * journals each victim's object and removes its row in one transaction, or keeps it recorded while a recovery hold is
 * open.
 */
export async function pruneBackups(db: RelationalStore, policy: BackupRetentionPolicy, now: number): Promise<{ pruned: number }> {
  try {
    const victims = await currentRetentionVictims(db, policy);
    const outcome = await releaseBackups(db, [...victims], victims, now);
    return { pruned: outcome.released };
  } catch {
    return { pruned: 0 };
  }
}

/** Pin or unpin one index row; a pinned backup is exempt from retention and consumes no slot. */
export async function setBackupPinned(db: RelationalStore, id: string, pinned: boolean): Promise<boolean> {
  const result = await db.prepare(`UPDATE backups SET pinned = ? WHERE id = ?`).bind(pinned ? 1 : 0, id).run();
  return result.meta.changes === 1;
}
