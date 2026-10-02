/** The last reset of each Deployment setting remains attributed after its configured row is removed. */
export const V63_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deployment_setting_resets (
     leaf TEXT PRIMARY KEY,
     reset_at INTEGER NOT NULL,
     reset_by TEXT NOT NULL)`,
];
