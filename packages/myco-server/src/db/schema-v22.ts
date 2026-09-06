import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const V22_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS canopy_maps (
    project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
    revision TEXT NOT NULL,
    artifact TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    repository_branch TEXT NOT NULL,
    repository_commit TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    generated_at INTEGER NOT NULL)`,
];
