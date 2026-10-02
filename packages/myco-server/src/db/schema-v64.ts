import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Schema v64: the Deployment's embedding model switch, at most one at a time, and the sources embedding cannot use.
 *
 * The one `embedding_switches` row names the model search moves to (provider, model, endpoint and the identity its
 * vectors are partitioned under) and the identity search uses while it is built. While the row stands, the embedding
 * run writes every source of every Project that is not archived under both identities and retires neither; once each
 * such source holds a vector under the new identity, or is one embedding passes over, the embedding leaves are written
 * to the new model and the row is deleted in one batch. `state` is `building`, or `paused`, saying why it waits for an
 * admin. A building switch whose model failed for a while carries `retry_at`, the instant its model is asked again,
 * saying why, with the count of `failures` in a row, counted from its last written vector. `estimated_sources` is the
 * count its token estimate covers, and `progressed_at` the instant its model last wrote a vector, or it started.
 *
 * `embedding_source_failures` holds each source revision embedding passes over, saying why: one whose stored text
 * cannot be read, under every model (`model_key` empty), or one a model's provider refused as input, under that model.
 * The embedding run never writes a source it holds, Health lists them, and a new revision of the source is read again.
 */
export const V64_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_switches (
     slot              TEXT PRIMARY KEY CHECK (slot = 'deployment'),
     id                TEXT NOT NULL,
     provider          TEXT NOT NULL,
     model             TEXT NOT NULL,
     endpoint          TEXT,
     model_key         TEXT NOT NULL,
     from_model_key    TEXT NOT NULL,
     estimated_tokens  INTEGER NOT NULL,
     estimated_sources INTEGER NOT NULL,
     state             TEXT NOT NULL CHECK (state IN ('building', 'paused')),
     reason            TEXT,
     retry_at          INTEGER,
     failures          INTEGER NOT NULL DEFAULT 0,
     progressed_at     INTEGER NOT NULL,
     started_at        INTEGER NOT NULL,
     started_by        TEXT NOT NULL,
     updated_at        INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS embedding_source_failures (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     type        TEXT NOT NULL,
     record_id   TEXT NOT NULL,
     model_key   TEXT NOT NULL,
     revision    TEXT NOT NULL,
     reason      TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, type, record_id, model_key))`,
];
