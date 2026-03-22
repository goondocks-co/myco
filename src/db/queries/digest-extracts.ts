/**
 * Digest extract CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when upserting a digest extract. */
export interface DigestExtractUpsert {
  curator_id: string;
  tier: number;
  content: string;
  generated_at: number;
}

/** Row shape returned from digest_extracts queries (all columns). */
export interface DigestExtractRow {
  id: number;
  curator_id: string;
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
  'curator_id',
  'tier',
  'content',
  'substrate_hash',
  'generated_at',
] as const;

const SELECT_COLUMNS = EXTRACT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed DigestExtractRow. */
function toDigestExtractRow(row: Record<string, unknown>): DigestExtractRow {
  return {
    id: row.id as number,
    curator_id: row.curator_id as string,
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
 * Upsert a digest extract. Uses ON CONFLICT on (curator_id, tier).
 *
 * Creates or updates the extract for the given curator and token tier.
 */
export async function upsertDigestExtract(
  data: DigestExtractUpsert,
): Promise<DigestExtractRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO digest_extracts (curator_id, tier, content, generated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (curator_id, tier) DO UPDATE SET
       content = EXCLUDED.content,
       generated_at = EXCLUDED.generated_at
     RETURNING ${SELECT_COLUMNS}`,
    [data.curator_id, data.tier, data.content, data.generated_at],
  );

  return toDigestExtractRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Get a digest extract for a specific curator and tier.
 *
 * @returns the extract row, or null if not found.
 */
export async function getDigestExtract(
  curatorId: string,
  tier: number,
): Promise<DigestExtractRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM digest_extracts
     WHERE curator_id = $1 AND tier = $2`,
    [curatorId, tier],
  );

  if (result.rows.length === 0) return null;
  return toDigestExtractRow(result.rows[0] as Record<string, unknown>);
}
