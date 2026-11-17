import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { NEXT_CURATION_UNDO } from './schema-vNEXT-curation-undo.js';
import type { SchemaStep } from './schema-step.js';
import { CURATION_HISTORY_BACKFILL } from './spores/curation-history-sql.js';

/** Editorial operation history is retained independently of worker attempts. */
export const CURATION_UNDO_STEPS: readonly SchemaStep[] = [{
  version: NEXT_CURATION_UNDO,
  statements: [
    `CREATE TABLE IF NOT EXISTS spore_curation_units(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id) ON DELETE CASCADE,
      id TEXT NOT NULL,kind TEXT NOT NULL,source_run_id TEXT,cluster_key TEXT,created_at INTEGER NOT NULL,member_count INTEGER NOT NULL,unavailable TEXT,
      undone_at INTEGER,undone_by TEXT,undone_label TEXT,PRIMARY KEY(project_id,id))`,
    `CREATE TABLE IF NOT EXISTS spore_curation_unit_members(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),unit_id TEXT NOT NULL,spore_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('source','retired','output')),before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
      after_json TEXT NOT NULL CHECK(json_valid(after_json)),PRIMARY KEY(project_id,unit_id,spore_id),
      FOREIGN KEY(project_id,unit_id) REFERENCES spore_curation_units(project_id,id) ON DELETE CASCADE)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_unit_output ON spore_curation_unit_members(project_id,spore_id) WHERE role=\'output\'',
    'CREATE INDEX IF NOT EXISTS idx_curation_unit_note ON spore_curation_unit_members(project_id,spore_id,role,unit_id)',
    ...CURATION_HISTORY_BACKFILL,
  ],
}];
