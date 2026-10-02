/**
 * Schema v64: the Deployment's embedding model switch, at most one at a time.
 *
 * The one row names the model search moves to (provider, model, endpoint and the identity its vectors are partitioned
 * under) and the identity search uses while it is built. While the row stands, the embedding run writes every source
 * under both identities and retires neither; once every source holds a vector under the new identity, the embedding
 * leaves are written to the new model and the row is deleted in one batch. `state` is `building`, or `paused` with the
 * reason the new model could not be reached.
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
     started_at       INTEGER NOT NULL,
     started_by       TEXT NOT NULL,
     updated_at       INTEGER NOT NULL)`,
];
