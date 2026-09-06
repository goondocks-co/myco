import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const V21_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_repositories (
    project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
    revision TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    username TEXT,
    secret_slot TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    CHECK ((secret_slot IS NULL AND username IS NULL) OR (secret_slot IS NOT NULL AND username IS NOT NULL)))`,
];
