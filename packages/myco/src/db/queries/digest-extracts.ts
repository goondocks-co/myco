/**
 * Digest extract CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DIGEST_TIERS, epochSeconds } from '@myco/constants.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { type ProjectScope } from '@myco/grove/ids.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when upserting a digest extract. */
export interface DigestExtractUpsert {
  project_id?: string | null;
  agent_id: string;
  tier: number;
  content: string;
  generated_at: number;
  machine_id?: string;
}

/**
 * Options that control whether the upsert actually writes and how the
 * revision history is recorded. Added in schema v15.
 */
export interface DigestExtractUpsertOptions {
  /**
   * When true, the upsert is a no-op: nothing is written, no revision is
   * recorded, and `null` is returned. Used by dry-run tooling so we can
   * preview writes without touching persistent state.
   */
  dryRun?: boolean;
  /**
   * Id of the agent_run that produced this write. Recorded on the
   * revision row so operators can roll a specific run back.
   */
  runId?: string | null;
  /**
   * Optional JSON-encoded metadata to store with the revision.
   */
  metadata?: string | null;
}

/** Row shape for entries in digest_extract_revisions. */
export interface DigestExtractRevisionRow {
  id: number;
  project_id: string | null;
  agent_id: string;
  tier: number;
  content: string;
  metadata: string | null;
  run_id: string | null;
  parent_revision_id: number | null;
  created_at: number;
}

/** Options accepted by rollbackDigestExtract. */
export interface RollbackDigestExtractOptions {
  revisionId: number;
  /** Id of the run performing the rollback (recorded on the new revision). */
  runId?: string | null;
}

/** Row shape returned from digest_extracts queries (all columns). */
export interface DigestExtractRow {
  id: number;
  project_id: string | null;
  agent_id: string;
  tier: number;
  content: string;
  substrate_hash: string | null;
  generated_at: number;
  machine_id: string;
  synced_at: number | null;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const EXTRACT_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'tier',
  'content',
  'substrate_hash',
  'generated_at',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = EXTRACT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed DigestExtractRow. */
function toDigestExtractRow(row: Record<string, unknown>): DigestExtractRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    tier: row.tier as number,
    content: row.content as string,
    substrate_hash: (row.substrate_hash as string) ?? null,
    generated_at: row.generated_at as number,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  return projectId ?? null;
}

/**
 * Collapse a ProjectScope to the row-shaped `string | null` (or undefined
 * meaning "no scope filter") used by the legacy identity helpers below.
 * `'all'` → `undefined` (no filter), `'global'` → `null`, `'project'` → id.
 */
function scopeToRowProjectId(scope: ProjectScope): string | null | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'global') return null;
  return scope.id;
}

function digestIdentityWhere(projectId: string | null): { where: string; params: unknown[] } {
  return projectId === null
    ? { where: 'project_id IS NULL AND agent_id = ? AND tier = ?', params: [] }
    : { where: 'project_id = ? AND agent_id = ? AND tier = ?', params: [projectId] };
}

function digestIdentityParams(projectId: string | null, agentId: string, tier: number): unknown[] {
  const { params } = digestIdentityWhere(projectId);
  return [...params, agentId, tier];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a digest extract by project-scoped (agent_id, tier).
 *
 * Schema v15 behaviour: when an existing row would be overwritten, the
 * prior content is copied into digest_extract_revisions (linked to the
 * previous revision if any) *before* the upsert runs. This makes the
 * revision log append-only and preserves the state the agent is replacing.
 *
 * When `options.dryRun === true`, the function is a no-op: nothing is
 * written to digest_extracts or digest_extract_revisions, and `null` is
 * returned. Call sites that care about the hydrated row should skip
 * follow-up reads when dry-running.
 */
export function upsertDigestExtract(
  data: DigestExtractUpsert,
  options: DigestExtractUpsertOptions = {},
): DigestExtractRow | null {
  if (options.dryRun) return null;

  const db = getDatabase();
  const projectId = normalizeProjectId(data.project_id);
  const identity = digestIdentityWhere(projectId);
  const identityParams = digestIdentityParams(projectId, data.agent_id, data.tier);
  const machineId = data.machine_id ?? getTeamMachineId();

  // The revision snapshot and the live-row upsert MUST be atomic. Without
  // a transaction, a crash between the two writes would leave the revision
  // log out of sync with `digest_extracts` — the exact invariant this log
  // exists to guarantee. Matches the pattern used in sessions.ts /
  // skill-records.ts for multi-table writes.
  return db.transaction(() => {
    // Capture the row we're about to overwrite (if any) so we can copy it
    // into the revision history before mutating the live table.
    const existingRow = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM digest_extracts WHERE ${identity.where}`,
    ).get(...identityParams) as Record<string, unknown> | undefined;

    if (existingRow) {
      const priorRevisionId = db.prepare(
        `SELECT id FROM digest_extract_revisions
         WHERE ${identity.where}
         ORDER BY id DESC
         LIMIT 1`,
      ).get(...identityParams) as { id: number } | undefined;

      db.prepare(
        `INSERT INTO digest_extract_revisions
           (project_id, agent_id, tier, content, metadata, run_id, parent_revision_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectId,
        data.agent_id,
        data.tier,
        existingRow.content as string,
        options.metadata ?? null,
        options.runId ?? null,
        priorRevisionId?.id ?? null,
        epochSeconds(),
      );
    }

    if (existingRow) {
      db.prepare(
        `UPDATE digest_extracts
         SET content = ?, generated_at = ?, machine_id = ?
         WHERE id = ?`,
      ).run(data.content, data.generated_at, machineId, existingRow.id);
    } else {
      db.prepare(
        `INSERT INTO digest_extracts (project_id, agent_id, tier, content, generated_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, data.agent_id, data.tier, data.content, data.generated_at, machineId);
    }

    const row = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM digest_extracts WHERE ${identity.where}`,
    ).get(...identityParams);

    return toDigestExtractRow(row as Record<string, unknown>);
  })();
}

/**
 * Get a digest extract for a specific agent and tier.
 *
 * @returns the extract row, or null if not found.
 */
export function getDigestExtract(
  agentId: string,
  tier: number,
  scope: ProjectScope,
): DigestExtractRow | null {
  const db = getDatabase();
  if (scope.kind === 'all') {
    const row = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM digest_extracts
       WHERE agent_id = ? AND tier = ?
       LIMIT 1`,
    ).get(agentId, tier) as Record<string, unknown> | undefined;
    return row ? toDigestExtractRow(row) : null;
  }
  const projectId = scopeToRowProjectId(scope) ?? null;
  const identity = digestIdentityWhere(projectId);

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM digest_extracts
     WHERE ${identity.where}`,
  ).get(...digestIdentityParams(projectId, agentId, tier)) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toDigestExtractRow(row);
}

/**
 * List digest extracts for an agent, filtered to configured tiers, ordered by tier ASC.
 */
export function listDigestExtracts(
  agentId: string,
  scope: ProjectScope,
): DigestExtractRow[] {
  const db = getDatabase();
  const tierPlaceholders = DIGEST_TIERS.map(() => '?').join(', ');
  let identity: { where: string; params: unknown[] };
  if (scope.kind === 'all') {
    identity = { where: 'agent_id = ?', params: [agentId] };
  } else if (scope.kind === 'global') {
    identity = { where: 'project_id IS NULL AND agent_id = ?', params: [agentId] };
  } else {
    identity = { where: 'project_id = ? AND agent_id = ?', params: [scope.id, agentId] };
  }

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM digest_extracts
     WHERE ${identity.where} AND tier IN (${tierPlaceholders})
     ORDER BY tier ASC`,
  ).all(...identity.params, ...DIGEST_TIERS) as Record<string, unknown>[];

  return rows.map(toDigestExtractRow);
}

// ---------------------------------------------------------------------------
// Revision history (schema v15)
// ---------------------------------------------------------------------------

const REVISION_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'tier',
  'content',
  'metadata',
  'run_id',
  'parent_revision_id',
  'created_at',
] as const;

const REVISION_SELECT = REVISION_COLUMNS.join(', ');

function toRevisionRow(row: Record<string, unknown>): DigestExtractRevisionRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    tier: row.tier as number,
    content: row.content as string,
    metadata: (row.metadata as string) ?? null,
    run_id: (row.run_id as string) ?? null,
    parent_revision_id: (row.parent_revision_id as number) ?? null,
    created_at: row.created_at as number,
  };
}

/**
 * List revisions for a specific (agent_id, tier) pair, newest first.
 * Used by operators who want to roll back a digest to an earlier state.
 */
export function listDigestRevisions(
  options: { agentId: string; tier: number; limit?: number; scope: ProjectScope },
): DigestExtractRevisionRow[] {
  const db = getDatabase();
  const limit = options.limit ?? 50;
  if (options.scope.kind === 'all') {
    const rows = db.prepare(
      `SELECT ${REVISION_SELECT}
       FROM digest_extract_revisions
       WHERE agent_id = ? AND tier = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(options.agentId, options.tier, limit) as Record<string, unknown>[];
    return rows.map(toRevisionRow);
  }
  const projectId = scopeToRowProjectId(options.scope) ?? null;
  const identity = digestIdentityWhere(projectId);
  const rows = db.prepare(
    `SELECT ${REVISION_SELECT}
     FROM digest_extract_revisions
     WHERE ${identity.where}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...digestIdentityParams(projectId, options.agentId, options.tier), limit) as Record<string, unknown>[];
  return rows.map(toRevisionRow);
}

/** Result of a successful rollback. */
export interface RollbackDigestExtractResult {
  /** The restored digest_extracts row (content now matches the target revision). */
  row: DigestExtractRow;
  /**
   * Id of the newly-appended revision that captures the pre-rollback live
   * content (so the rollback itself is reversible). `null` when no live row
   * existed before the rollback (nothing to preserve).
   */
  newRevisionId: number | null;
}

/**
 * Restore an earlier revision's content back into digest_extracts, and
 * append a *new* revision row so the revision history remains append-only.
 *
 * The newly-appended revision captures what was live before the rollback
 * (so the rollback itself is reversible), with its parent set to the last
 * revision for (agent_id, tier).
 *
 * Returns the restored digest_extracts row plus the newly-minted revision
 * id, or null if the revision id doesn't exist.
 */
export function rollbackDigestExtract(
  options: RollbackDigestExtractOptions,
): RollbackDigestExtractResult | null {
  const db = getDatabase();

  const revision = db.prepare(
    `SELECT ${REVISION_SELECT}
     FROM digest_extract_revisions
     WHERE id = ?`,
  ).get(options.revisionId) as Record<string, unknown> | undefined;

  if (!revision) return null;

  const agentId = revision.agent_id as string;
  const tier = revision.tier as number;
  const projectId = normalizeProjectId(revision.project_id as string | null | undefined);
  const targetContent = revision.content as string;
  const now = epochSeconds();
  const identity = digestIdentityWhere(projectId);
  const identityParams = digestIdentityParams(projectId, agentId, tier);

  // Preservation of the pre-rollback state and the live-row restore must
  // be atomic — same invariant as `upsertDigestExtract`.
  return db.transaction(() => {
    // 1) Append a new revision that preserves the *current* live content
    //    (pre-rollback state) so the rollback itself is reversible.
    const currentRow = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM digest_extracts WHERE ${identity.where}`,
    ).get(...identityParams) as Record<string, unknown> | undefined;

    let newRevisionId: number | null = null;
    if (currentRow) {
      const priorRevisionId = db.prepare(
        `SELECT id FROM digest_extract_revisions
         WHERE ${identity.where}
         ORDER BY id DESC
         LIMIT 1`,
      ).get(...identityParams) as { id: number } | undefined;

      const info = db.prepare(
        `INSERT INTO digest_extract_revisions
           (project_id, agent_id, tier, content, metadata, run_id, parent_revision_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectId,
        agentId,
        tier,
        currentRow.content as string,
        JSON.stringify({ rollback_of: options.revisionId }),
        options.runId ?? null,
        priorRevisionId?.id ?? null,
        now,
      );
      newRevisionId = Number(info.lastInsertRowid);
    }

    // 2) Restore the target revision's content into the live row.
    if (currentRow) {
      db.prepare(
        `UPDATE digest_extracts
         SET content = ?, generated_at = ?
         WHERE id = ?`,
      ).run(targetContent, now, currentRow.id);
    } else {
      db.prepare(
        `INSERT INTO digest_extracts (project_id, agent_id, tier, content, generated_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, agentId, tier, targetContent, now, getTeamMachineId());
    }

    const restored = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM digest_extracts WHERE ${identity.where}`,
    ).get(...identityParams) as Record<string, unknown>;

    return {
      row: toDigestExtractRow(restored),
      newRevisionId,
    };
  })();
}
