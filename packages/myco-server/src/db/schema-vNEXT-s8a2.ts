export const NEXT_S8A2 = 745;

/** The resumable position of the object store walk: the last object key decided, when the next pass may begin, and the instant this database took ownership of its store, before which the walk leaves every object alone. */
export const NEXT_S8A2_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS object_store_reconciliation (
    slot INTEGER PRIMARY KEY CHECK(slot=1), after_key TEXT NOT NULL DEFAULT '', next_pass_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, armed_at INTEGER NOT NULL)`,
  "INSERT INTO object_store_reconciliation(slot,armed_at) VALUES(1,(CAST(strftime('%s','now') AS INTEGER)+1)*1000) ON CONFLICT DO NOTHING",
];
