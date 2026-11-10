export const NEXT_S2E = 779;

/**
 * The hot archive path: its index builds alone, and the sweep cursor changes meaning in the next step.
 * The first step's statement is one index over the events table; it is this step's whole work.
 */
export const VNEXT_S2E_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S2E, statements: [
    "CREATE INDEX IF NOT EXISTS idx_events_hot_received ON events(received_at) WHERE payload_format='inline'",
  ] },
  { version: NEXT_S2E + 1, statements: [
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_project',
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_session',
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_created',
    'ALTER TABLE raw_event_archive_state ADD COLUMN cursor_received INTEGER NOT NULL DEFAULT -1',
    'UPDATE raw_event_archive_state SET cursor_rowid=-1,revision=revision+1 WHERE id=1',
  ] },
];

export const NEXT_S2E_LAST = NEXT_S2E + 1;
