import { releaseSchemaStatements } from './release/schema.js';
import { reaching, type SchemaStep, changing } from './schema-step.js';
import { LAST_S5D, NEXT_S5D } from './schema-vNEXT-s5d.js';

/**
 * Release provenance's due row, work rows, propagation queue and report table, then the two indexes each built alone on
 * the history-sized state table: the list path and the unique current key. The unique key is partial on `canonical`, so
 * it builds empty; the catch-up marks a row current only after resolving every rival of its record.
 */
export const VNEXT_S5D_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S5D, statements: releaseSchemaStatements(), reaches: [
    ...changing(['knowledge_release_state', 'project_release_provenance', 'projection_catchup'], 'A release state carries its current key and comparison fields as columns, a Project its work generation, and the catch-up that fills them stays building until every existing row is placed.'),
    ...reaching(['knowledge_git_provenance', 'session_documents', 'spores', 'plans'], 'A capture, a changed path, or a record naming a classified session moves its one due row, so the reconcile reads due rows instead of history.'),
  ],
    deploymentIndexes: [
      { index: 'idx_release_check_due_head', read: 'the release reconcile seeks Projects whose check has come due across the Deployment, soonest first' },
      { index: 'idx_release_propagation_head', read: 'the release reconcile takes queued session propagation across the Deployment, oldest first' },
    ],
  },
  { version: NEXT_S5D + 1, statements: ['CREATE INDEX IF NOT EXISTS idx_release_state_list ON knowledge_release_state (project_id, checked_at DESC, id DESC)'], reaches: reaching(['knowledge_release_state'], 'A release state list walks newest checked first by key, and one current row per record is enforced for every row the catch-up has placed.') },
  { version: LAST_S5D, statements: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_release_state_current ON knowledge_release_state (project_id, namespace, record_id) WHERE canonical = 1'], reaches: reaching(['knowledge_release_state'], 'A release state list walks newest checked first by key, and one current row per record is enforced for every row the catch-up has placed.') },
];
