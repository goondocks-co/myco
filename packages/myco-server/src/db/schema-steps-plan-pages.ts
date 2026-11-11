import { reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_PLAN_PAGES } from './schema-vNEXT-plan-pages.js';
import { occurredAt } from './session-dates.js';

/** Complete ordered access paths and a job-owned visibility fence during plan retirement. */
export const PLAN_PAGE_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_PLAN_PAGES,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_plans_session_updated ON plans(project_id,session_id,updated_at,plan_key)',
      'DROP INDEX idx_plans_session',
    ],
    retires: retiring('index', ['idx_plans_session'], 'Session plan pages read complete edit and plan keys.'),
    reaches: reaching(['plans'], 'A session plan page seeks the complete edit and plan key.'),
  },
  {
    version: NEXT_PLAN_PAGES + 1,
    statements: ['CREATE INDEX IF NOT EXISTS idx_plans_session_status_updated ON plans(project_id,session_id,status,updated_at,plan_key)'],
    reaches: reaching(['plans'], 'A filtered session plan page seeks one status and the complete edit and plan key.'),
  },
  {
    version: NEXT_PLAN_PAGES + 2,
    statements: [`CREATE INDEX IF NOT EXISTS idx_sessions_launch_activity ON sessions(project_id,launch_parent_session_id,${occurredAt()},session_id)`],
    reaches: reaching(['sessions'], 'Launched children page in displayed occurrence and session order.'),
  },
  {
    version: NEXT_PLAN_PAGES + 3,
    statements: [`CREATE INDEX IF NOT EXISTS idx_sessions_parent_activity ON sessions(project_id,parent_session_id,${occurredAt()},session_id)`],
    reaches: reaching(['sessions'], 'Conversation continuations page in displayed occurrence and session order.'),
  },
  {
    version: NEXT_PLAN_PAGES + 4,
    statements: ["CREATE INDEX IF NOT EXISTS idx_session_deletion_plan_retirement ON session_deletion_jobs(project_id,session_id) WHERE state='running' AND phase='plans'"],
    reaches: reaching(['session_deletion_jobs'], 'Activity probes the retiring session, and plan totals probe retiring Projects.'),
    deploymentIndexes: [
      { index: 'idx_session_deletion_plan_retirement', read: 'all-Project plan totals omit Projects retiring plan contributions' },
    ],
  },
  {
    version: NEXT_PLAN_PAGES + 5,
    statements: [
      'DROP TRIGGER project_activity_tombstone_insert',
      'DROP TRIGGER project_activity_tombstone_delete',
      `CREATE TRIGGER IF NOT EXISTS project_activity_tombstone_insert AFTER INSERT ON session_tombstones BEGIN
        DELETE FROM project_activity WHERE project_id=NEW.project_id AND kind='session' AND source_id=NEW.session_id;
      END`,
      `CREATE TRIGGER IF NOT EXISTS project_activity_tombstone_delete AFTER DELETE ON session_tombstones BEGIN
        INSERT INTO project_activity(project_id,kind,source_id,sort_at,preview,session_id)
          SELECT s.project_id,'session',s.session_id,${occurredAt('s.')},NULL,s.session_id FROM sessions s
          WHERE s.project_id=OLD.project_id AND s.session_id=OLD.session_id
          ON CONFLICT(project_id,kind,source_id) DO NOTHING;
      END`,
    ],
    retires: retiring('trigger', ['project_activity_tombstone_insert', 'project_activity_tombstone_delete'],
      'Tombstones change only session activity; bounded plan deletion pages retire plan contributions.'),
    reaches: reaching(['session_tombstones'], 'A tombstone hides its session activity while the deletion job owns bounded plan retirement.'),
  },
];
