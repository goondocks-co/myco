/**
 * Digest extract CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DIGEST_TIERS } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when upserting a digest extract. */
export interface DigestExtractUpsert {
  agent_id: string;
  tier: number;
  content: string;
  generated_at: number;
}

/** Row shape returned from digest_extracts queries (all columns). */
export interface DigestExtractRow {
  id: number;
  agent_id: string;
  tier: number;
  content: string;
  substrate_hash: string | null;
  generated_at: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const EXTRACT_COLUMNS = [
  'id',
  'agent_id',
  'tier',
  'content',
  'substrate_hash',
  'generated_at',
] as const;

const SELECT_COLUMNS = EXTRACT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed DigestExtractRow. */
function toDigestExtractRow(row: Record<string, unknown>): DigestExtractRow {
  return {
    id: row.id as number,
    agent_id: row.agent_id as string,
    tier: row.tier as number,
    content: row.content as string,
    substrate_hash: (row.substrate_hash as string) ?? null,
    generated_at: row.generated_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a digest extract. Uses ON CONFLICT on (agent_id, tier).
 *
 * Creates or updates the extract for the given agent and token tier.
 * Uses lastInsertRowid for SERIAL PK on insert, or falls back to
 * SELECT for the conflict (update) case.
 */
export function upsertDigestExtract(
  data: DigestExtractUpsert,
): DigestExtractRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, tier) DO UPDATE SET
       content = EXCLUDED.content,
       generated_at = EXCLUDED.generated_at`,
  ).run(data.agent_id, data.tier, data.content, data.generated_at);

  // Always look up by composite unique key — works for both insert and update cases.
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM digest_extracts WHERE agent_id = ? AND tier = ?`,
  ).get(data.agent_id, data.tier);

  return toDigestExtractRow(row as Record<string, unknown>);
}

/**
 * Get a digest extract for a specific agent and tier.
 *
 * @returns the extract row, or null if not found.
 */
export function getDigestExtract(
  agentId: string,
  tier: number,
): DigestExtractRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM digest_extracts
     WHERE agent_id = ? AND tier = ?`,
  ).get(agentId, tier) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toDigestExtractRow(row);
}

/**
 * List digest extracts for an agent, filtered to configured tiers, ordered by tier ASC.
 */
export function listDigestExtracts(
  agentId: string,
): DigestExtractRow[] {
  const db = getDatabase();
  const tierPlaceholders = DIGEST_TIERS.map(() => '?').join(', ');

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM digest_extracts
     WHERE agent_id = ? AND tier IN (${tierPlaceholders})
     ORDER BY tier ASC`,
  ).all(agentId, ...DIGEST_TIERS) as Record<string, unknown>[];

  return rows.map(toDigestExtractRow);
}
