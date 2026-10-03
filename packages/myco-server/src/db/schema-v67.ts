/** A machine's current provisioned harness facts. */
export const V67_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS machine_harness_reports (
     machine_id TEXT PRIMARY KEY,
     harnesses TEXT NOT NULL,
     reported_at INTEGER NOT NULL)`,
];
