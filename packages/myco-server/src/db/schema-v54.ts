/**
 * Schema v54: the size a transcript's parse is waiting past (#1461).
 *
 * `transcripts.parse_awaited_size` is set with `parse_error = 'awaiting_bytes'` by a pass that found nothing
 * past its cursor but one record still being written, to the size that pass read. The transcript leaves the
 * parse queue until its size grows past it, so a wait is keyed on bytes, never on a clock: a segment landing in
 * the same millisecond, or from a skewed clock, still puts it back. It is NULL on every other row, and cleared by
 * the pass that moves the cursor and by a re-read. It carries no index: the queue's own predicate reads it only
 * on rows the backlog index already selects.
 */
export const V54_STATEMENTS: readonly string[] = [
  `ALTER TABLE transcripts ADD COLUMN parse_awaited_size INTEGER`,
];
