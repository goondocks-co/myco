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
import type { BlobStore, RelationalStore } from './adapters.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';

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
  'projects', 'project_remotes', 'members', 'machine_claims', 'enrollment_authorities', 'identity_link_authorities',
  'member_credentials', 'agents',
  'sessions', 'session_tombstones', 'events', 'blobs', 'prompt_batches', 'tool_calls', 'responses', 'plans',
  'attachments', 'transcripts', 'transcript_segments', 'tags',
  'agent_tasks', 'agent_runs', 'agent_state', 'spores', 'resolution_events', 'spore_injections', 'session_injections',
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
 * state, transient quota state, the credential-store table nothing else may
 * touch, the backup index itself, the migration guard tables, and operator
 * configuration. Settings, capability admissions, repository connections and
 * sealed secrets require their validated writers and a recorded actor.
 * Operators re-enter configuration on the dashboard after a restore.
 */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'search_blob_queue', 'search_blob_chunks',
  'embedding_versions', 'embedding_receipts', 'embedding_cursors', 'embedding_hubness_work', 'local_vectors',
  ...['prompt_batches', 'responses', 'spores', 'plans', 'skill_records', 'sessions', 'search_blob_chunks']
    .flatMap((table) => ['', '_data', '_idx', '_docsize', '_config'].map((suffix) => `${table}_fts${suffix}`)),
  'schema_meta', 'member_tokens', 'blob_reservations', 'step_up_authorities',
  'deployment_settings', 'project_capabilities', 'project_repositories', 'deployment_secrets', 'backups',
  'backup_restore_progress',
  '_v2_guard_project_id_grammar', '_v2_guard_session_machine_id',
  '_v5_guard_credential_backfillable', '_v5_guard_backfill_complete',
]);

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

/** Create one backup artifact and its index row; answers the index row written. */
export async function createBackup(
  db: RelationalStore, blobs: BlobStore, opts: { producer: string; now: number },
): Promise<BackupIndexRow> {
  const lineage = await deploymentId(db);
  const stamped = Number(await metaValue(db, 'version'));
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  let bytes = 0;
  for (const table of BACKUP_TABLES) {
    counts[table] = 0;
    let cursor = 0;
    for (;;) {
      const { results } = await db
        .prepare(`SELECT rowid AS __rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 200`)
        .bind(cursor).all<Record<string, unknown>>();
      if (results.length === 0) break;
      for (const row of results) {
        cursor = row.__rid as number;
        const { __rid, ...columns } = row;
        const line = JSON.stringify({ t: table, r: columns });
        bytes = assertBackupSize(`${line}\n`, bytes);
        lines.push(line);
        counts[table] = counts[table]! + 1;
      }
      if (results.length < 200) break;
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
  const stored = await blobs.put(key, new Response(artifact).body, { sha256, httpMetadata: { contentType: 'application/jsonl' } });
  const row: BackupIndexRow = {
    id, key, created_at: opts.now, size_bytes: stored.size,
    counts_json: JSON.stringify(counts), schema_version: stamped, producer: opts.producer, pinned: 0, sha256,
  };
  await db.prepare(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .bind(row.id, row.key, row.created_at, row.size_bytes, row.counts_json, row.schema_version, row.producer, row.sha256).run();
  return row;
}

export interface ListedBackup extends BackupIndexRow {
  /** Whether the named object is actually in the store; an index row whose object vanished renders broken, never healthy. */
  present: boolean;
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

const readArtifact = async (db: RelationalStore, blobs: BlobStore, id: string): Promise<{ row: BackupIndexRow; text: string } | null> => {
  const row = await db.prepare(`SELECT ${INDEX_COLUMNS} FROM backups WHERE id = ?`)
    .bind(id).first<BackupIndexRow>();
  if (row === null) return null;
  const body = await blobs.get(row.key);
  if (body === null) return null;
  return { row, text: await new Response(body.body).text() };
};

/** What a restore would touch, answered from the header alone — the artifact's rows are never executed here. */
export async function previewRestore(
  db: RelationalStore, blobs: BlobStore, id: string,
): Promise<{ header: BackupHeader; foreignLineage: boolean } | null> {
  const artifact = await readArtifact(db, blobs, id);
  if (artifact === null) return null;
  const newline = artifact.text.indexOf('\n');
  if (newline === -1) return null;
  const header = JSON.parse(artifact.text.slice(0, newline)) as BackupHeader;
  return { header, foreignLineage: header.deploymentId !== (await deploymentId(db)) };
}

export interface RestoreOutcome {
  tables: Record<string, { rows: number; inserted: number; skipped?: string }>;
}

interface RestoreProgress {
  artifact_hash: string;
  next_row: number;
}

const RESTORE_OWNER = 'table_name = ? AND artifact_hash = ? AND next_row = ?';

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

/**
 * Apply one artifact: refusal gates first, then additive `INSERT OR IGNORE`
 * per row in bounded batches. Rows the target already holds stay exactly as
 * they are — a restore never overwrites, so the target's revocations and
 * edits always win. A re-run converges: every insert is a no-op the second time.
 */
export async function restoreBackup(
  db: RelationalStore, blobs: BlobStore,
  opts: { id: string; allowForeignLineage?: boolean },
): Promise<RestoreOutcome | null> {
  const artifact = await readArtifact(db, blobs, opts.id);
  if (artifact === null) return null;
  return restoreArtifact(db, { text: artifact.text, allowForeignLineage: opts.allowForeignLineage });
}

/**
 * Apply one artifact's text — the path an uploaded artifact shares with a
 * stored one, so both meet the same gates in the same order.
 */
export async function restoreArtifact(
  db: RelationalStore,
  opts: { text: string; allowForeignLineage?: boolean },
): Promise<RestoreOutcome> {
  const lines = opts.text.split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]!) as BackupHeader;

  const live = await deploymentId(db);
  if (header.deploymentId !== live && opts.allowForeignLineage !== true) throw new BackupLineageError(header.deploymentId, live);
  const stamped = Number(await metaValue(db, 'version'));
  if (header.schemaVersion > stamped) throw new BackupSchemaError(header.schemaVersion, stamped);

  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as { t: string; r: Record<string, unknown> };
    if (!BACKUP_TABLES.includes(parsed.t)) continue;
    const rows = byTable.get(parsed.t) ?? [];
    rows.push(parsed.r);
    byTable.set(parsed.t, rows);
  }

  const outcome: RestoreOutcome = { tables: {} };
  const hash = await sha256Hex(opts.text);
  for (const table of BACKUP_TABLES) {
    const rows = byTable.get(table) ?? [];
    if (rows.length === 0) continue;
    for (const row of rows) {
      if (!Object.keys(row).every((c) => IDENTIFIER.test(c))) throw new BackupApplyError(table, 'a row carries a column name outside the store grammar');
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
      const statements = chunk.map((row) => {
        const columns = Object.keys(row);
        return db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}${guard} RETURNING rowid`)
          .bind(...columns.map((c) => row[c] ?? null), ...(ordered ? [table, hash, at] : []));
      });
      if (ordered) {
        statements.push(db.prepare(`UPDATE backup_restore_progress SET next_row = ?, verified = ${restoredRowsMatch(table, chunk)}
          WHERE ${RESTORE_OWNER} RETURNING next_row`)
          .bind(next, JSON.stringify(chunk), table, hash, at));
      }
      let applied;
      try {
        applied = await db.batch(statements);
      } catch (err) {
        throw new BackupApplyError(table, err instanceof Error ? err.message : String(err));
      }
      for (const result of applied.slice(0, chunk.length)) inserted += result.results.length;
      if (ordered && applied[chunk.length]!.results.length === 0) {
        const current = await readRestoreProgress(db, table);
        if (current?.artifact_hash !== hash || current.next_row <= at) {
          throw new BackupApplyError(table, 'the restore no longer owns this table');
        }
        at = current.next_row;
      } else {
        at = next;
      }
    }
    outcome.tables[table] = { rows: rows.length, inserted };
  }
  return outcome;
}

/** One stored artifact's text and index row, for the download surface. */
export async function backupArtifact(db: RelationalStore, blobs: BlobStore, id: string): Promise<{ row: BackupIndexRow; text: string } | null> {
  return readArtifact(db, blobs, id);
}

/**
 * Which unpinned index rows retention lets go of: keep the newest `keepDaily`
 * rows, plus the newest row of each of the `keepWeekly` most recent week
 * windows. Pinned rows are exempt and consume no slot. Pure, so the rule is
 * testable without a store.
 */
export function retentionVictims(rows: readonly BackupIndexRow[], keepDaily: number, keepWeekly: number): BackupIndexRow[] {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const unpinned = rows.filter((r) => r.pinned === 0).sort((a, b) => b.created_at - a.created_at);
  const keep = new Set<string>(unpinned.slice(0, Math.max(0, keepDaily)).map((r) => r.id));
  const weeksKept = new Set<number>();
  for (const row of unpinned) {
    const week = Math.floor(row.created_at / WEEK_MS);
    if (weeksKept.has(week)) continue;
    if (weeksKept.size >= Math.max(0, keepWeekly)) continue;
    weeksKept.add(week);
    keep.add(row.id);
  }
  return unpinned.filter((r) => !keep.has(r.id));
}

/**
 * Prune per the retention rule, FAIL-CLOSED: any error reading the index or
 * the store skips the prune whole — a backup that spans a schema gap is worth
 * more than a tidy list. Deletion order is object first, row second, so an
 * index row never outlives losing its object silently.
 */
export async function pruneBackups(
  db: RelationalStore, blobs: BlobStore, keep: { keepDaily: number; keepWeekly: number },
): Promise<{ pruned: number }> {
  if (keep.keepDaily < 1) return { pruned: 0 };
  let pruned = 0;
  try {
    const { results } = await db
      .prepare(`SELECT ${INDEX_COLUMNS} FROM backups ORDER BY created_at DESC`)
      .all<BackupIndexRow>();
    const victims = retentionVictims(results, keep.keepDaily, keep.keepWeekly);
    for (const victim of victims) {
      await blobs.delete(victim.key);
      await db.prepare(`DELETE FROM backups WHERE id = ?`).bind(victim.id).run();
      pruned += 1;
    }
    return { pruned };
  } catch {
    return { pruned };
  }
}

/** Pin or unpin one index row; a pinned backup is exempt from retention and consumes no slot. */
export async function setBackupPinned(db: RelationalStore, id: string, pinned: boolean): Promise<boolean> {
  const result = await db.prepare(`UPDATE backups SET pinned = ? WHERE id = ?`).bind(pinned ? 1 : 0, id).run();
  return result.meta.changes === 1;
}
