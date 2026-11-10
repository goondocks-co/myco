import type { SchemaStep } from './schema-step.js';
import { NEXT_S8C } from './schema-vNEXT-s8c.js';

/**
 * A restore is an accepted job that owns its artifact and walks it in bounded passes: one running at a time, its
 * cursor and outcome committed after every pass, and the backup it reads held by retention while it runs.
 */
export const VNEXT_S8C_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S8C, statements: [
    `CREATE TABLE IF NOT EXISTS restore_jobs(
      id TEXT PRIMARY KEY,
      backup_id TEXT,
      upload_key TEXT,
      upload_size INTEGER CHECK (upload_size IS NULL OR upload_size >= 0),
      artifact_sha256 TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      adopt_lineage INTEGER NOT NULL CHECK (adopt_lineage IN (0,1)),
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete','failed')),
      cursor TEXT NOT NULL,
      rows_done INTEGER NOT NULL DEFAULT 0 CHECK (rows_done >= 0),
      rows_total INTEGER NOT NULL CHECK (rows_total >= 0),
      outcome TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      failure TEXT,
      failure_detail TEXT,
      failed_at INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      CHECK ((state = 'running') = (completed_at IS NULL)),
      CHECK ((backup_id IS NULL) <> (upload_key IS NULL)),
      CHECK ((upload_key IS NULL) = (upload_size IS NULL)))`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_restore_jobs_running ON restore_jobs(state) WHERE state='running'",
    'CREATE INDEX IF NOT EXISTS idx_restore_jobs_accepted ON restore_jobs(accepted_at,id)',
  ],
    deploymentIndexes: [
      { index: 'idx_restore_jobs_running', read: 'retention and the restore driver seek the one running restore' },
      { index: 'idx_restore_jobs_accepted', read: 'the backup page shows the latest restore' },
    ],
  },
];
