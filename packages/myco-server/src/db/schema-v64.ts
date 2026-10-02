import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Schema v64: the Deployment's embedding model switch, at most one at a time.
 *
 * The one `embedding_switches` row names the model search moves to (provider, model, endpoint and the identity its
 * vectors are partitioned under) and the identity search uses while it is built. While the row stands, the embedding
 * run writes every source of every Project that is not archived under both identities and retires neither; once each
 * such source holds a vector under the new identity, or is recorded as one the new model cannot read, the embedding
 * leaves are written to the new model and the row is deleted in one batch. `state` is `building`, or `paused`, saying
 * why it waits for an admin. A building switch whose model failed for a while carries `retry_at`, the instant its
 * model is asked again, saying why, with the count of `failures` in a row, counted from its last written vector.
 *
 * `embedding_switch_skips` holds, for the switch standing, each source revision whose text could not be read: it counts
 * toward completion and is shown, saying why. A new revision of the source is read again.
 */
export const V64_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_switches (
     slot             TEXT PRIMARY KEY CHECK (slot = 'deployment'),
     id               TEXT NOT NULL,
     provider         TEXT NOT NULL,
     model            TEXT NOT NULL,
     endpoint         TEXT,
     model_key        TEXT NOT NULL,
     from_model_key   TEXT NOT NULL,
     estimated_tokens INTEGER NOT NULL,
     state            TEXT NOT NULL CHECK (state IN ('building', 'paused')),
     reason           TEXT,
     retry_at         INTEGER,
     failures         INTEGER NOT NULL DEFAULT 0,
     started_at       INTEGER NOT NULL,
     started_by       TEXT NOT NULL,
     updated_at       INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS embedding_switch_skips (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     type       TEXT NOT NULL,
     record_id  TEXT NOT NULL,
     revision   TEXT NOT NULL,
     reason     TEXT NOT NULL,
     skipped_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, type, record_id))`,
];
