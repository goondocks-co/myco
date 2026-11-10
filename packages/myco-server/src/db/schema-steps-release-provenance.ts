import { releaseSchemaStatements } from './release/schema.js';
import type { SchemaStep } from './schema-step.js';
import { LAST_S5D, NEXT_S5D } from './schema-vNEXT-s5d.js';

/**
 * Release provenance's due row, work rows, propagation queue and report table, then the two indexes each built alone on
 * the history-sized state table: the list path and the unique current key. The unique key is partial on `canonical`, so
 * it builds empty; the catch-up marks a row current only after resolving every rival of its record.
 */
export const VNEXT_S5D_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S5D, statements: releaseSchemaStatements() },
  { version: NEXT_S5D + 1, statements: ['CREATE INDEX IF NOT EXISTS idx_release_state_list ON knowledge_release_state (project_id, checked_at DESC, id DESC)'] },
  { version: LAST_S5D, statements: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_release_state_current ON knowledge_release_state (project_id, namespace, record_id) WHERE canonical = 1'] },
];
