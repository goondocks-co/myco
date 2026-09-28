import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Schema v50: spore calibration keeps a membership record (#1429).
 *
 * `embedding_hubness_members` holds, per Project and model, every spore vector
 * the stored distance moments cover: its state (0 settled, 1 joining, 2
 * leaving), its count, mean and sum of squared deviations of cosine distance to
 * the other members, and a copy of its vector (float32 without its zero tail, base64). A spore added
 * or removed changes each member's moments by one sample, read from the copies,
 * so its vector may be deleted from the vector store while it leaves.
 *
 * `embedding_cursors.hubness_token` is the calibration's commit token: every
 * calibration write names the token it read and replaces it, so a step that
 * lost a race writes nothing.
 *
 * The step discards the pass the previous calibration had in flight; the
 * membership record starts empty and is built by the same operations.
 */
export const V50_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_hubness_members (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), model_key TEXT NOT NULL, id TEXT NOT NULL,
    state INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0, 1, 2)),
    n INTEGER NOT NULL DEFAULT 0, mean REAL NOT NULL DEFAULT 0, m2 REAL NOT NULL DEFAULT 0,
    vector TEXT NOT NULL,
    PRIMARY KEY(project_id, model_key, id))`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_hubness_members_state ON embedding_hubness_members(project_id, model_key, state, id)`,
  `ALTER TABLE embedding_cursors ADD COLUMN hubness_token TEXT`,
  `UPDATE embedding_cursors SET hubness_count = NULL, hubness_target_count = NULL, hubness_cursor = NULL`,
  `DELETE FROM embedding_hubness_work`,
];
