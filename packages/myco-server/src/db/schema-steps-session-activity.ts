import { activityAt, occurredAt } from './session-dates.js';
import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_SESSION_ACTIVITY } from './schema-vNEXT-session-activity.js';
import { emptyOpenSession, emptySessionSchema, retainedSession } from './sessions/visibility.js';

/** Capture facts are nullable so older writers and unclassified history retain their contract. */
export const SESSION_ACTIVITY_STEPS: readonly SchemaStep[] = [{
  version: NEXT_SESSION_ACTIVITY,
  statements: [
    'ALTER TABLE sessions ADD COLUMN latest_activity_at INTEGER',
    'ALTER TABLE sessions ADD COLUMN has_activity INTEGER',
    'ALTER TABLE session_read_facts ADD COLUMN has_activity INTEGER',
    `CREATE INDEX IF NOT EXISTS idx_sessions_retained_project ON sessions(project_id,${occurredAt()} DESC,session_id DESC) WHERE ${retainedSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_retained_across ON sessions(${occurredAt()} DESC,project_id DESC,session_id DESC) WHERE ${retainedSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_session_read_retained_activity ON session_read_facts(project_id,last_received_at DESC) WHERE has_session=1 AND tombstoned=0 AND ${retainedSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_retained_activity ON sessions(${activityAt()}) WHERE ${retainedSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_retained_working ON sessions(working_since) WHERE ${retainedSession()} AND working_since IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_empty_live ON sessions(${activityAt()}) WHERE ${emptyOpenSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_empty_live_project ON sessions(project_id,${activityAt()}) WHERE ${emptyOpenSession()}`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_empty_working ON sessions(working_since) WHERE ${emptyOpenSession()} AND working_since IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_empty_working_project ON sessions(project_id,working_since) WHERE ${emptyOpenSession()} AND working_since IS NOT NULL`,
    ...emptySessionSchema(),
  ],
  reaches: [
    ...changing(['sessions'], 'Capture stores bounded event activity and affirmative prompt or tool evidence in its session upsert.'),
    ...changing(['session_read_facts'], 'The session read model mirrors capture evidence for a retained, non-deleted activity seek.'),
    ...reaching(['session_tombstones'], 'Deletion removes the session contribution from empty-session totals.'),
  ],
  deploymentIndexes: [
    { index: 'idx_sessions_retained_across', read: 'The across-Project session page seeks retained history in occurrence order.' },
    { index: 'idx_sessions_retained_activity', read: 'An activity window seeks retained history from its lower bound.' },
    { index: 'idx_sessions_retained_working', read: 'The working page seeks open turns independently of quiet empty history.' },
    { index: 'idx_sessions_empty_working', read: 'Pages seek empty sessions with a current turn independently of quiet history.' },
    { index: 'idx_sessions_empty_live', read: 'Across-Project pages seek only empty sessions within their live window.' },
  ],
}];
