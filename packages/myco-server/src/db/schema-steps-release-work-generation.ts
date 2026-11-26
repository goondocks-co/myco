import { LAST_RELEASE_EVIDENCE, LAST_RELEASE_WORK_GENERATION, NEXT_RELEASE_OBSERVATION, NEXT_STABLE_RELEASE_OBSERVATION, NEXT_RELEASE_EVIDENCE, NEXT_RELEASE_WORK_GENERATION } from './schema-vNEXT-release-work-generation.js';
import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { RELEASE_WORK_OPEN, latestObservationTriggers, releasePathsReady, stableObservationTriggers } from './release/schema.js';

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
  {
    version: NEXT_RELEASE_EVIDENCE,
    statements: [
      'ALTER TABLE release_work_due ADD COLUMN capture_only INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE release_work_due ADD COLUMN own_tags_generation INTEGER NOT NULL DEFAULT 0',
      releasePathsReady,
    ],
    reaches: [...changing(['release_work_due'], 'Settlement records the evidence that can reopen work and the tag generation already compared.'),
      ...reaching(['session_documents'], 'Publishing captured paths reopens work when the document becomes readable.')],
  },
  {
    version: LAST_RELEASE_EVIDENCE,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_release_work_pending ON release_work_due (project_id, production_only, settled_generation, captured_at, session_id) WHERE ${RELEASE_WORK_OPEN}`,
      'DROP INDEX IF EXISTS idx_release_work_open',
      'DROP INDEX IF EXISTS idx_release_work_by_scope',
    ],
    reaches: reaching(['release_work_due'], 'The pending index excludes capture-only settlements while keeping each work scope in due order.'),
    retires: retiring('index', ['idx_release_work_open', 'idx_release_work_by_scope'], 'Release work selects both scopes from idx_release_work_pending.'),
  },
  {
    version: NEXT_RELEASE_OBSERVATION,
    statements: [
      ...latestObservationTriggers.map(({ name }) => `DROP TRIGGER IF EXISTS ${name}`),
      ...latestObservationTriggers.map(({ sql }) => sql),
    ],
    reaches: reaching(['knowledge_git_provenance', 'session_documents'], 'Release work follows the latest turn or session end when capture or published paths change.'),
    retires: retiring('trigger', latestObservationTriggers.map(({ name }) => name), 'The rebuilt triggers select the last captured boundary and reopen work for it.'),
  },
  {
    version: NEXT_STABLE_RELEASE_OBSERVATION,
    statements: [
      ...stableObservationTriggers.map(({ name }) => `DROP TRIGGER IF EXISTS ${name}`),
      ...stableObservationTriggers.map(({ sql }) => sql),
    ],
    reaches: reaching(['knowledge_git_provenance'], 'Capture updates the standing boundary and retains settlement for equivalent release evidence.'),
    retires: retiring('trigger', stableObservationTriggers.map(({ name }) => name), 'The rebuilt triggers preserve release work when only the observed boundary changes.'),
  },
];
