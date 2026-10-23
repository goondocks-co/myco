import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** What a session reported it created: one immutable row per (session, kind, artifact id), minted at report and never updated. */
export const V99_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_artifacts (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('pr', 'issue', 'tag', 'release', 'deploy')),
     artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 256),
     url TEXT NOT NULL CHECK (substr(url, 1, 8) = 'https://' AND length(url) <= 2048),
     author TEXT NOT NULL,
     reported_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_artifacts_identity ON session_artifacts (project_id, session_id, kind, artifact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_artifacts_session ON session_artifacts (project_id, session_id, reported_at, id)`,
];
