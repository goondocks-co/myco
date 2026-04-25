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
  let agg: CanopySessionAggregate;
  try {
    agg = aggregateSessionCanopy(handle, sessionId);
  } catch {
    // Read failure shouldn't block the Stop pipeline. Caller logs.
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
