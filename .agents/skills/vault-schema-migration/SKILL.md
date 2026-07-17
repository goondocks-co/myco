---
name: myco:vault-schema-migration
description: |
  Use this skill whenever you need to add, modify, or remove tables, columns, or indexes in the Myco vault SQLite schema — even if the user just asks to "add a column" or "create a new table." The vault uses a versioned createSchema migration chain where each schema version is a numbered step that builds on the previous one. Because user vaults accumulate real data across machines, any schema change that breaks the migration chain can corrupt or destroy vault data. This skill covers how to add a new version to the chain, write safe migration SQL, handle backfill steps, bump the schema version constant, sync D1 databases, and verify the migration works end-to-end before shipping.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safely Versioning the Myco Vault SQLite Schema

The Myco vault is a SQLite database at `.myco/myco.db`. Its schema evolves through a numbered migration chain — each version is an incremental step applied on top of the previous one. This matters because vaults are long-lived: users have real sessions, spores, and graph data that must survive every upgrade. Breaking the chain means breaking their data.

## Prerequisites

- Know which schema version is current. Check `SCHEMA_VERSION` in the schema module (`packages/myco/src/db/schema.ts`).
- Know exactly what you're adding — table name, column names and types, constraints, indexes.
- Understand whether the change needs a **backfill** (populating existing rows after adding a column) or is append-only.

## Steps

### 1. Find the schema file and current version

```bash
grep -r "SCHEMA_VERSION" packages/myco/src --include="*.ts" -l
```

Open that file. You'll see:
- A `SCHEMA_VERSION` constant (e.g., `8`)
- A `createSchema` function containing a sequence of `if (currentVersion < N)` blocks

Read the entire function to understand the chain before touching anything.

### 2. Increment the version constant

Change `SCHEMA_VERSION` from `N` to `N+1`. This is the version the vault will be at after your migration runs.

```ts
// Before
export const SCHEMA_VERSION = 8;

// After
export const SCHEMA_VERSION = 9;
```

Do this first so you never forget — the constant and the migration block must always match.

### 3. Add a new migration block at the end of the chain

Inside `createSchema`, add a new block **after all existing blocks**:

```ts
if (currentVersion < 9) {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id);
  `);
  currentVersion = 9;
}
```

Key rules for the block:
- Use `if (currentVersion < N)` — not `===`, not `>=`. This ensures the block runs exactly once for vaults below that version and is skipped for vaults already at or above it.
- End the block by setting `currentVersion = N`. This advances the in-memory version tracker so subsequent blocks see the right value.
- Keep each block **idempotent where possible**. SQLite's `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are safe. For `ALTER TABLE ADD COLUMN`, SQLite will error if the column already exists — wrap in a try/catch if there's any risk of partial application.

### 4. Write safe migration SQL

**Adding a table:**
```sql
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
```

**Adding a column:**
```sql
ALTER TABLE sessions ADD COLUMN machine_id TEXT;
```
SQLite only allows adding columns, not modifying or dropping them. If you need to change a column type or drop a column, you must recreate the table (see step 4a).

**Recreating a table (rename → create → copy → drop):**
```sql
ALTER TABLE spores RENAME TO spores_old;
CREATE TABLE spores ( /* new schema */ );
INSERT INTO spores SELECT id, content, /* ... */ FROM spores_old;
DROP TABLE spores_old;
```
Wrap table recreations in a transaction to prevent partial states.

### 4a. Backfill step (when needed)

If you added a NOT NULL column or need to populate existing rows, add a backfill *within the same version block*, after the DDL:

```ts
if (currentVersion < 7) {
  db.exec(`ALTER TABLE spores ADD COLUMN machine_id TEXT;`);

  // Backfill: existing rows get 'local' as a safe default
  db.exec(`UPDATE spores SET machine_id = 'local' WHERE machine_id IS NULL;`);

  currentVersion = 7;
}
```

Backfills must complete before `currentVersion` advances — never split DDL and backfill across two version blocks for the same change.

### 5. Update the schema version stored in the database

The migration runner reads and writes `PRAGMA user_version` (or a `meta` table row) to know which version the vault is at. Confirm the runner pattern:

```bash
grep -r "user_version\|schemaVersion\|meta.*version" packages/myco/src --include="*.ts"
```

Most commonly you'll see something like:

```ts
const currentVersion = db.prepare('PRAGMA user_version').get().user_version;
// ... migration chain ...
db.pragma(`user_version = ${SCHEMA_VERSION}`);
```

Make sure the final `PRAGMA user_version = N` assignment uses the constant, not a hardcoded number.

### 6. Sync Cloudflare D1 schema changes

**Critical:** Deployed Cloudflare D1 databases do NOT auto-receive local migrations. After local schema changes that affect D1-backed tables (typically team sync tables), you must manually update the D1 database.

#### 6a. Identify D1-backed tables

Check which tables replicate to D1:

```bash
grep -r "D1\|BACKFILL_TABLES" packages/myco/src --include="*.ts"
```

Common D1 tables include: `team_outbox`, `notifications`, `agent_runs`, and `sessions` (if team sync is enabled).

The authoritative synced-table set lives in `packages/myco-team/worker/src/synced-tables.ts` (`SYNCED_TABLES`). If your changed table is in that set, the parity rule below is mandatory.

#### 6a-parity. The synced-column parity rule — every local column must reach the D1 mirror

**Any column added to a synced table MUST also be added to the D1 worker mirror.** The worker's insert path (`buildInsertParts` in `packages/myco-team/worker/src/index.ts`) builds its column list from the row payload, not from an allowlist — `sanitizeSyncPayload` only strips `LOCAL_ONLY_SYNC_COLUMNS`. So any new local column rides straight into the worker's `INSERT OR REPLACE INTO ${table} (...)`, and if D1 has no matching column, D1 throws `no such column` for **every** unsynced row of that table — a total sync stall for the table, with no local error.

Mirror the column with the **3-part idempotent pattern** in `packages/myco-team/worker/src/schema.ts`, all inside `initD1Schema` (which is idempotent and runs on every request):

1. **DDL** — add the column to the table's `CREATE TABLE` constant (e.g. `PROMPT_BATCHES_TABLE`), so fresh D1 databases get it at creation.
2. **Idempotent ALTER** — add `ALTER TABLE <table> ADD COLUMN <col> <type>` to the `migrations` array; it runs inside a try/catch that swallows the "column already exists" error, so existing D1 databases pick it up on the next request.
3. **`verifyColumnsAddressable`** — add the column to that table's entry in the `verifyColumnsAddressable(db, [...])` list, so a lazy/partial schema-cache refresh that hasn't propagated the ALTER fails fast and is retried on the next request instead of silently dropping writes.

If the new column is intentionally local-only (never synced), add it to `LOCAL_ONLY_SYNC_COLUMNS[table]` in `packages/myco/src/db/queries/team-outbox.ts` instead — then it's stripped before the payload reaches the worker.

**The column-parity test enforces this.** `tests/db/synced-table-parity.test.ts` extracts column names from both the local and worker `CREATE TABLE` DDL strings and asserts every synced local column (minus `LOCAL_ONLY_SYNC_COLUMNS` and globally-stripped columns) exists on the worker DDL. Adding a synced column without its worker counterpart turns this test red and names the offending column — run it after any synced-table change:

```bash
npm test -- tests/db/synced-table-parity.test.ts
```

**Older binary on a newer schema is safe for additive-nullable columns.** The local `createSchema` migration loop no-ops when the vault's `user_version` is already ahead of the running binary's `SCHEMA_VERSION` (the `if (currentVersion < N)` blocks are all skipped), and every query names its columns explicitly rather than `SELECT *`. So a machine still on an older binary reading a vault another machine migrated forward keeps working, as long as the new columns are **additive and nullable** (no NOT-NULL-without-default, no dropped/renamed columns an old query still references). This is the guarantee that lets a mixed-version team share one synced schema.

#### 6b. Generate D1 migration SQL

Extract the SQL statements from your migration block that affect D1 tables:

```sql
-- Example: if your migration added notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
```

Save this to a temporary file like `d1-migration-v9.sql`.

#### 6c. Apply to D1 via wrangler

Execute each statement against the D1 database:

```bash
# For team-sync database
wrangler d1 execute myco-team-sync --file=d1-migration-v9.sql

# Or individual statements
wrangler d1 execute myco-team-sync --command="CREATE TABLE IF NOT EXISTS notifications (...);"
```

#### 6d. Verify D1 schema sync

Confirm the schema applied correctly:

```bash
wrangler d1 execute myco-team-sync --command=".schema notifications"
```

**Common D1 migration failures:**
- **Syntax differences**: D1 may not support all SQLite features. Test statements separately.
- **Constraint violations**: D1 enforces foreign keys differently than local SQLite.
- **Timeout on large migrations**: Split complex migrations into smaller batches.

### 7. Test the migration locally

Run the daemon against a fresh vault to verify the schema creates correctly from zero:

```bash
rm -rf .myco/myco.db && pnpm dev
```

Then test against an existing vault to verify the migration applies cleanly. The easiest way is to temporarily reduce `user_version` in a test vault:

```bash
sqlite3 .myco/myco.db "PRAGMA user_version = N-1;"
pnpm dev
sqlite3 .myco/myco.db "PRAGMA user_version; .schema your_new_table"
```

Confirm the version advanced and the new table/column exists.

### 8. Update schema documentation

If the project has a schema changelog or version reference file, add an entry:

```
v9 (2026-04-03): Added parent_session_id to sessions table for lineage tracking
```

Check:
```bash
ls docs/ | grep schema
grep -r "schema v" memory/ --include="*.md"
```

### 9. Migrate a real existing vault offline (with backup)

When you need to apply a new binary's migration to a live vault that already holds real data (e.g. before shipping, or to recover a stuck vault), do it offline with a backup so a bad migration is fully reversible:

```bash
# 1. Stop the daemon so nothing writes mid-migration.
myco daemon stop      # or the service stop for your install

# 2. Back up the DB and its write-ahead log together — the WAL holds
#    committed pages not yet checkpointed into the main file; copying the
#    .db without the .wal can restore a torn state.
GROVE_DB=~/.myco/groves/<grove-id>/myco.db
cp "$GROVE_DB"      "$GROVE_DB.bak"
cp "$GROVE_DB-wal"  "$GROVE_DB-wal.bak" 2>/dev/null || true

# 3. Open the vault once with the new binary so createSchema runs the
#    migration chain to the new SCHEMA_VERSION.
myco daemon start
#    (or any command that opens the vault, e.g. `myco doctor`)

# 4. Verify: version advanced and the new column/table is present and intact.
sqlite3 "$GROVE_DB" "PRAGMA user_version;"
sqlite3 "$GROVE_DB" ".schema <changed_table>"
sqlite3 "$GROVE_DB" "PRAGMA integrity_check;"   # must print 'ok'
```

If `integrity_check` reports anything but `ok`, or the migration errored, restore from the backup (`mv "$GROVE_DB.bak" "$GROVE_DB"` and the WAL) and fix the migration before retrying. Never leave the daemon running against a half-migrated vault.

## Common Pitfalls

**Never edit an existing migration block.** Once a version block ships, real vaults have already applied it. Changing it means the migration won't re-run for existing users. If you need to fix a past migration, add a new version that corrects it.

**NOT NULL columns without defaults will fail on existing data.** Either provide a DEFAULT in the DDL, or backfill immediately after the ALTER TABLE and before advancing `currentVersion`.

**Older SQLite releases may not support DROP COLUMN.** If targeting older SQLite (common in embedded contexts), use the rename→create→copy→drop pattern instead.

**Transaction wrapping matters for multi-statement migrations.** If a version block executes multiple statements and one fails mid-way, the vault can be left in a partially migrated state. Wrap complex blocks:

```ts
db.transaction(() => {
  db.exec(`ALTER TABLE foo RENAME TO foo_old;`);
  db.exec(`CREATE TABLE foo ( /* new */ );`);
  db.exec(`INSERT INTO foo SELECT * FROM foo_old;`);
  db.exec(`DROP TABLE foo_old;`);
})();
```

**D1 schema drift causes team sync failures.** Always sync D1 schema changes using the procedures in step 6. Missing this step creates runtime drift between the daemon schema and the worker database.

**A new column on a synced table with no worker mirror stalls sync for the whole table.** The worker builds its INSERT column list from the row payload, so an unmirrored column makes D1 throw `no such column` for every unsynced row — silently, with no local error. Apply the 3-part worker pattern (DDL + idempotent ALTER + `verifyColumnsAddressable`) from step 6a-parity and run `tests/db/synced-table-parity.test.ts`, which fails and names any local column missing from the D1 mirror. A column that is deliberately local-only belongs in `LOCAL_ONLY_SYNC_COLUMNS` instead.
