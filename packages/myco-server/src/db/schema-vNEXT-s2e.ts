import { retiring, type SchemaStep, reaching, changing } from './schema-step.js';
export const NEXT_S2E = 779;

/**
 * The hot archive path: its index builds alone, and the sweep cursor changes meaning in the next step.
 * The first step's statement is one index over the events table; it is this step's whole work.
 */
export const VNEXT_S2E_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S2E, statements: [
    "CREATE INDEX IF NOT EXISTS idx_events_hot_received ON events(received_at) WHERE payload_format='inline'",
  ],
    reaches: reaching(['events'], 'The hot event archive seeks due rows by receipt age: one index over the table it reads, in its own step.'),
    deploymentIndexes: [
      { index: 'idx_events_hot_received', read: 'raw archival seeks due hot event bodies by receipt age across the Deployment' },
    ],
  },
  { version: NEXT_S2E + 1, statements: [
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_project',
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_session',
    'ALTER TABLE raw_event_archive_state DROP COLUMN cursor_created',
    'ALTER TABLE raw_event_archive_state ADD COLUMN cursor_received INTEGER NOT NULL DEFAULT -1',
    'UPDATE raw_event_archive_state SET cursor_rowid=-1,revision=revision+1 WHERE id=1',
  ], retires: retiring('column', ['cursor_project', 'cursor_session', 'cursor_created'].map((column) => `raw_event_archive_state.${column}`),
    'The archive sweep cursor orders hot rows by receipt age alone, so the session columns of the retired walk go.'),
    reaches: changing(['raw_event_archive_state'], 'The archive sweep cursor orders hot rows by receipt age alone, so the session columns of the retired walk go. A cursor from the retired walk has no meaning in the new order, so it restarts at the head of the due path.'),
  },
];

export const NEXT_S2E_LAST = NEXT_S2E + 1;
