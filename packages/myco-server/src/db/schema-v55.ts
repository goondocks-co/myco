/**
 * Schema v55: settings a machine holds, one set per machine identity (#1393).
 *
 * Machine settings are edited on the dashboard and read by the machine, which keeps the set its session start is
 * answered with. A row is one leaf of one machine, keyed by the identity the machine joined with (`machine_claims`),
 * so the set is the machine's whichever of its member's runtimes asks. A leaf at its default holds no row. The
 * primary key leads with the machine, so the foreign key is served by it.
 */
export const V55_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS machine_settings (
     machine_id TEXT NOT NULL REFERENCES machine_claims(machine_id),
     leaf       TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     PRIMARY KEY (machine_id, leaf))`,
];
