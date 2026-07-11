/**
 * The routed-capture idempotency ledger (residency design §4a).
 *
 * Under Team Host, routed `/events` capture is at-least-once: the member both
 * live-forwards AND buffers every event, and the replay drain re-forwards on
 * reconnect. The member stamps each discrete event with a source-assigned,
 * identity-bearing id (`<machine_id>:<uuid>`, `capture/event-id.ts`), assigned once
 * and persisted with the buffered event — so the live copy and every replay carry
 * the IDENTICAL id. The host's `/events` handlers consult this ledger to
 * insert-if-not-exists, collapsing double-delivery + lost-ack retries to one row.
 *
 * Keyed on the globally-unique `event_id` (the table's PRIMARY KEY). Two genuinely
 * distinct but content-identical events carry DIFFERENT ids and so stay distinct —
 * which a content hash could not tell apart from a replay. Host-local: never synced.
 */
import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';

export type RoutedEventKind = 'user_prompt' | 'tool_use' | 'tool_failure';

export interface RoutedEventDedupRow {
  event_id: string;
  machine_id: string | null;
  kind: string;
  /** The batch a `user_prompt` event opened — returned on a deduped replay so the
   *  caller attaches downstream work to the SAME batch; NULL for activity events. */
  prompt_batch_id: number | null;
  created_at: number;
}

/** The ledger row for a source event id, or `null` when the host has not yet
 *  processed this event — the insert-if-not-exists probe. */
export function getRoutedEventDedup(eventId: string): RoutedEventDedupRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT event_id, machine_id, kind, prompt_batch_id, created_at
         FROM routed_event_dedup
        WHERE event_id = ?`,
    )
    .get(eventId) as RoutedEventDedupRow | undefined;
  return row ?? null;
}

/**
 * Record that a source event has been processed. `ON CONFLICT DO NOTHING` so a
 * rare concurrent double-delivery is a no-op on the second write (the handler's
 * pre-check already dedups the sequential live+drain case). `promptBatchId` is the
 * batch a `user_prompt` opened; omit it for activity events.
 */
export function recordRoutedEventDedup(input: {
  eventId: string;
  machineId?: string | null;
  kind: RoutedEventKind;
  promptBatchId?: number | null;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO routed_event_dedup (event_id, machine_id, kind, prompt_batch_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
    )
    .run(input.eventId, input.machineId ?? null, input.kind, input.promptBatchId ?? null, epochSeconds());
}

/**
 * Age-based prune (consolidation Task C-1). The ledger has no `session_id`
 * to gate on a terminal signal, so retention is purely `created_at` age —
 * see `ROUTED_EVENT_DEDUP_RETENTION_MS` (constants.ts) for why the default
 * window is conservative. Scheduled by the `routed-event-dedup-prune` power
 * job (`daemon/power-jobs.ts`). Returns the number of rows deleted.
 */
export function pruneRoutedEventDedup(
  retentionSeconds: number,
  nowSeconds: number = epochSeconds(),
): number {
  const db = getDatabase();
  const cutoff = nowSeconds - Math.max(0, retentionSeconds);
  const result = db.prepare(
    `DELETE FROM routed_event_dedup WHERE created_at < ?`,
  ).run(cutoff);
  return result.changes;
}
