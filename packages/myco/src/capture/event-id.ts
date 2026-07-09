/**
 * Source-assigned, identity-bearing capture event id (residency design §4a).
 *
 * Routed capture is at-least-once by construction: the member both live-forwards
 * AND buffers every collect event, and the replay drain re-forwards on reconnect.
 * At-least-once becomes exactly-once-effect only with an idempotent sink — and for
 * discrete `/events` (prompt / tool_use / tool_failure) the analogue of a
 * transcript offset is a stable per-event id the host dedups on.
 *
 * The member stamps this id ONCE, at collection, incorporating its `machine_id`
 * (identity), and persists it with the buffered event — so the live-forward and
 * the drain-replay of the SAME event carry the IDENTICAL id and collapse to one
 * row on the host, while two genuinely distinct but content-identical events (the
 * same prompt sent twice) get DIFFERENT ids and stay distinct. That
 * per-event-not-per-content property is exactly why the key is an id and not a
 * content hash. `machine_id` in the id makes it globally unique across members and
 * gives origin-tracing when debugging duplicates.
 */
import { randomUUID } from 'node:crypto';

/** The event-body field carrying the identity-bearing id. Passes through the
 *  host's `EventBody` (`.passthrough()`) and is read by the idempotent handlers. */
export const EVENT_ID_FIELD = 'event_id';

/**
 * Return `event` with an identity-bearing id, assigned ONCE. If the event already
 * carries one (a re-entrant path, or a drain-replayed buffer record), it is kept
 * untouched — the id must be stable across the live-forward and every replay.
 * Non-mutating: the caller's own reference stays as it was, so a sibling consumer
 * (the transcript-drain enqueue trigger) still sees the original body.
 *
 * Format: `<machine_id>:<uuidv4>`. The uuid alone is globally unique; the
 * `machine_id` prefix is the identity axis (§4a) — cross-member uniqueness +
 * origin-tracing.
 */
export function ensureEventId(
  event: Record<string, unknown>,
  machineId: string,
): Record<string, unknown> {
  const existing = event[EVENT_ID_FIELD];
  if (typeof existing === 'string' && existing.length > 0) return event;
  return { ...event, [EVENT_ID_FIELD]: `${machineId}:${randomUUID()}` };
}

/** The stamped id on a collect event, or `null` when unstamped (a local event, or
 *  a route the member does not stamp). The host dedups iff this is present. */
export function readEventId(event: Record<string, unknown>): string | null {
  const id = event[EVENT_ID_FIELD];
  return typeof id === 'string' && id.length > 0 ? id : null;
}
