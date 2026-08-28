/**
 * Digest extracts and their revision history.
 *
 * **Writing a digest archives the one it replaces.** The current row holds only
 * the latest content per agent and tier; every prior body lives on as a
 * revision, chained through `parent_revision_id`. Overwriting without archiving
 * loses every earlier digest, and nothing afterwards can tell that it happened.
 *
 * The archive is an `INSERT ... SELECT` from the current row rather than a read
 * followed by a write: the content being preserved never travels through the
 * caller, and a first write for an agent and tier archives nothing at all — the
 * SELECT matches no row to preserve. Both statements ride one batch, so a digest cannot be
 * replaced without its predecessor being kept.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

export interface DigestUpsert {
  id: string;
  agentId: string;
  tier: number;
  content: string;
  substrateHash: string | null;
  generatedAt: number;
  /** Recorded on the revision this write archives, naming what produced the replacement. */
  metadata?: string | null;
  runId?: string | null;
}

export interface DigestRow {
  id: string;
  agentId: string;
  tier: number;
  content: string;
  substrateHash: string | null;
  generatedAt: number;
}

const COLUMNS = `id, agent_id AS agentId, tier, content, substrate_hash AS substrateHash, generated_at AS generatedAt`;

/**
 * Archive the current digest, then replace it.
 *
 * `parent_revision_id` links each archived body to the one before it, so the
 * chain reads backwards from the newest revision. It is resolved in SQL from
 * the sequenced key, which is why `digest_extract_revisions` keeps an
 * autoincrementing id.
 */
export async function upsertDigest(db: RelationalStore, scope: ReadScope, row: DigestUpsert): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO digest_extract_revisions
        (project_id, id, agent_id, tier, content, metadata, run_id, parent_revision_id, created_at)
      SELECT d.project_id, NULL, d.agent_id, d.tier, d.content, ?, ?,
        (SELECT r.id FROM digest_extract_revisions r
          WHERE r.project_id = d.project_id AND r.agent_id = d.agent_id AND r.tier = d.tier
          ORDER BY r.id DESC LIMIT 1),
        ?
      FROM digest_extracts d
       WHERE d.project_id = ? AND d.agent_id = ? AND d.tier = ?`)
      .bind(row.metadata ?? null, row.runId ?? null, row.generatedAt, scope.projectId, row.agentId, row.tier),
    db.prepare(`INSERT INTO digest_extracts
        (project_id, id, agent_id, tier, content, substrate_hash, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, agent_id, tier) DO UPDATE SET
          content = excluded.content, substrate_hash = excluded.substrate_hash,
          generated_at = excluded.generated_at`)
      .bind(scope.projectId, row.id, row.agentId, row.tier, row.content, row.substrateHash, row.generatedAt),
  ]);
}

export async function getDigest(db: RelationalStore, scope: ReadScope, agentId: string, tier: number): Promise<DigestRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM digest_extracts WHERE project_id = ? AND agent_id = ? AND tier = ?`)
    .bind(scope.projectId, agentId, tier).first<DigestRow>();
}

export async function listDigests(db: RelationalStore, scope: ReadScope, agentId?: string): Promise<DigestRow[]> {
  const conditions = ['project_id = ?'];
  const params: unknown[] = [scope.projectId];
  if (agentId !== undefined) { conditions.push('agent_id = ?'); params.push(agentId); }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM digest_extracts WHERE ${conditions.join(' AND ')} ORDER BY tier ASC`)
    .bind(...params).all<DigestRow>();
  return results;
}

export interface DigestRevisionRow {
  id: number;
  tier: number;
  content: string;
  metadata: string | null;
  runId: string | null;
  parentRevisionId: number | null;
  createdAt: number;
}

/** The archived bodies for an agent and tier, newest first. */
export async function listDigestRevisions(
  db: RelationalStore, scope: ReadScope, agentId: string, tier: number, limit = 50,
): Promise<DigestRevisionRow[]> {
  const { results } = await db
    .prepare(`SELECT id, tier, content, metadata, run_id AS runId,
        parent_revision_id AS parentRevisionId, created_at AS createdAt
      FROM digest_extract_revisions
       WHERE project_id = ? AND agent_id = ? AND tier = ?
       ORDER BY id DESC LIMIT ?`)
    .bind(scope.projectId, agentId, tier, Math.min(limit, 200)).all<DigestRevisionRow>();
  return results;
}
