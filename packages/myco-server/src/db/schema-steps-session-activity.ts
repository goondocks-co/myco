import { activityAt } from './session-dates.js';
import { changing, type SchemaStep } from './schema-step.js';
import { NEXT_SESSION_ACTIVITY } from './schema-vNEXT-session-activity.js';

/** Nullable activity preserves the receipt-time contract of rows written by older releases. */
export const SESSION_ACTIVITY_STEPS: readonly SchemaStep[] = [{
  version: NEXT_SESSION_ACTIVITY,
  statements: [
    'ALTER TABLE sessions ADD COLUMN latest_activity_at INTEGER',
    `CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(${activityAt()})`,
  ],
  reaches: changing(['sessions'], 'Capture stores clock-corrected activity; activity windows seek it independently of delivery time.'),
  deploymentIndexes: [
    { index: 'idx_sessions_activity', read: 'An activity window seeks sessions from its clock-corrected lower bound.' },
  ],
}];
