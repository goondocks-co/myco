import { LAST_RELEASE_WORK_GENERATION, NEXT_RELEASE_WORK_GENERATION } from './schema-vNEXT-release-work-generation.js';
import { changing, reaching, type SchemaStep } from './schema-step.js';

export const RELEASE_WORK_GENERATION_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_RELEASE_WORK_GENERATION,
    statements: [
      'ALTER TABLE project_release_provenance ADD COLUMN production_generation INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE project_release_provenance ADD COLUMN production_fingerprint TEXT',
      'ALTER TABLE release_work_due ADD COLUMN production_only INTEGER NOT NULL DEFAULT 0 CHECK (production_only IN (0, 1))',
    ],
    reaches: changing(['project_release_provenance', 'release_work_due'], 'Settled work can wait for release tags without being reopened by every integration branch change.'),
  },
  {
    version: LAST_RELEASE_WORK_GENERATION,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_release_work_by_scope ON release_work_due (project_id, production_only, settled_generation, captured_at, session_id) WHERE final=0',
    ],
    reaches: reaching(['release_work_due'], 'Each work scope can seek sessions in due order without scanning the other scope.'),
  },
];
