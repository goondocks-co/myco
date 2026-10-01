/**
 * Schema v61: the repositories a machine could not capture.
 *
 * - `uncaptured_roots` holds one row per machine and repository that a member's hooks met and could not connect to a
 *   project: outside the folders the machine captures, with no remote, refused by the Deployment, or with project
 *   creation turned off. A repository is named by a key the member derives from its path and by its folder name, never
 *   by a path, so no home directory reaches the Deployment. `held` says whether the machine still holds what its agents
 *   did there: `held`, `full` past its cap, or `expired` with age. A connection deletes the row.
 * - `idx_uncaptured_roots_member` reads one member's rows, most recently missed first, and serves the foreign key
 *   `member_id` carries; `idx_uncaptured_roots_seen` reads every machine's rows the same way, for an administrator.
 */
export const V61_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS uncaptured_roots (
     machine_id    TEXT NOT NULL,
     root_key      TEXT NOT NULL,
     member_id     TEXT NOT NULL REFERENCES members(id),
     label         TEXT NOT NULL,
     remote        TEXT,
     reason        TEXT NOT NULL,
     misses        INTEGER NOT NULL DEFAULT 1,
     held          TEXT NOT NULL DEFAULT 'held',
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL,
     PRIMARY KEY (machine_id, root_key))`,
  `CREATE INDEX IF NOT EXISTS idx_uncaptured_roots_member ON uncaptured_roots (member_id, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_uncaptured_roots_seen ON uncaptured_roots (last_seen_at)`,
];
