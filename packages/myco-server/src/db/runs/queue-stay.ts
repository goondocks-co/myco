/**
 * When a run's current stay in the queue began: `queue_entered_at`, which every write that puts a run back in the queue
 * after it ran sets, else `queued_at` for its first stay. A refused launch returns the run to the stay it was in.
 * Null for a run that was never queued.
 */
export const queueEnteredSql = (row: string) => `COALESCE(${row}.queue_entered_at,${row}.queued_at)`;
