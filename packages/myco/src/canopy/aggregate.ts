/**
 * Per-turn Canopy aggregation entry point.
 *
 * Run at each Stop boundary: aggregate the persisted activity rows for the
 * session into a row-level summary on the `sessions` table. The capture
 * buffer remains authoritative for raw events; this is a derived view.
 *
 * Designed for fire-and-forget invocation — the function never throws on
 * read paths, returning `null` instead so the caller (typically the daemon
 * Stop processor) doesn't take the whole stop pipeline down on a corrupt
 * row or a transient SQLite error.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import { aggregateSessionCanopy, type CanopySessionAggregate } from '@myco/db/queries/canopy.js';

/**
 * Compute the per-session Canopy aggregate and UPDATE it onto the
 * sessions row. Returns the aggregate it wrote (handy for logging /
 * tests), or `null` if the underlying query failed.
 *
 * Column order in the UPDATE matches `CANOPY_SESSION_COLUMNS` in
 * schema-ddl.ts. If those names change, the queries module's startup
 * guard fires first.
 */
export function materializeCanopyAggregates(
  sessionId: string,
  db?: Database | null,
): CanopySessionAggregate | null {
  const handle = db ?? getDatabase();
  // Most sessions have no Canopy activity (capability off, injection
  // disabled, or no Read tool calls). Skip the heavier aggregate query +
  // sessions-row UPDATE in those cases — the columns stay NULL, which the
  // UI already treats as "no data, hide the tile."
  try {
    const probe = handle
      .prepare(
        'SELECT 1 FROM activities WHERE session_id = ? AND canopy_injection_tokens IS NOT NULL LIMIT 1',
      )
      .get(sessionId);
    if (!probe) return null;
  } catch {
    return null;
  }
  let agg: CanopySessionAggregate;
  try {
    agg = aggregateSessionCanopy(handle, sessionId);
  } catch {
    return null;
  }

  try {
    handle.prepare(`
      UPDATE sessions SET
        canopy_injections_offered     = ?,
        canopy_injection_total_tokens = ?,
        canopy_skips_after_injection  = ?,
        canopy_reads_after_injection  = ?,
        canopy_tokens_saved           = ?,
        canopy_redundant_reads        = ?
      WHERE id = ?
    `).run(
      agg.injections_offered,
      agg.injection_total_tokens,
      agg.skips_after_injection,
      agg.reads_after_injection,
      agg.tokens_saved,
      agg.redundant_reads,
      sessionId,
    );
  } catch {
    return null;
  }

  return agg;
}
