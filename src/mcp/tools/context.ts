/**
 * myco_context — retrieve synthesized project context from digest extracts.
 *
 * Queries the `digest_extracts` table in PGlite. In Phase 1 this table
 * is typically empty, so the handler returns a graceful fallback message.
 */

import { getDatabase } from '@myco/db/client.js';
import { DIGEST_TIERS } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default tier when none is requested. */
const DEFAULT_CONTEXT_TIER = 3000;

/** Message returned when no digest extracts are available yet. */
const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextInput {
  tier?: number;
}

export interface ContextResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated_at?: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoContext(
  input: ContextInput,
): Promise<ContextResult> {
  const requestedTier = input.tier ?? DEFAULT_CONTEXT_TIER;
  const db = getDatabase();

  // Try exact tier first
  const exact = await db.query(
    `SELECT content, tier, generated_at
     FROM digest_extracts
     WHERE tier = $1
     ORDER BY generated_at DESC
     LIMIT 1`,
    [requestedTier],
  );

  if (exact.rows.length > 0) {
    const row = exact.rows[0] as Record<string, unknown>;
    return {
      content: row.content as string,
      tier: row.tier as number,
      fallback: false,
      generated_at: row.generated_at as number,
    };
  }

  // Fall back to nearest available tier
  const candidates = [...DIGEST_TIERS]
    .sort((a, b) => Math.abs(a - requestedTier) - Math.abs(b - requestedTier));

  for (const tier of candidates) {
    if (tier === requestedTier) continue; // Already tried
    const result = await db.query(
      `SELECT content, tier, generated_at
       FROM digest_extracts
       WHERE tier = $1
       ORDER BY generated_at DESC
       LIMIT 1`,
      [tier],
    );

    if (result.rows.length > 0) {
      const row = result.rows[0] as Record<string, unknown>;
      return {
        content: row.content as string,
        tier: row.tier as number,
        fallback: true,
        generated_at: row.generated_at as number,
      };
    }
  }

  return {
    content: NO_DIGEST_MESSAGE,
    tier: requestedTier,
    fallback: false,
  };
}
