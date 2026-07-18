---
name: myco:vault-schema-migration
description: |
  Use this skill whenever you need to add, modify, or remove tables, columns, or indexes in the Myco vault SQLite schema — even if the user just asks to "add a column" or "create a new table." The vault uses a versioned createSchema migration chain where each schema version is a numbered step that builds on the previous one. Because user vaults accumulate real data across machines, any schema change that breaks the migration chain can corrupt or destroy vault data. This skill covers how to add a new version to the chain, write safe migration SQL, handle backfill steps, bump the schema version constant, keep the dormant team-sync worker's D1 mirror parity-test-clean if your table is in the synced-table set, and verify the migration works end-to-end before shipping.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safely Versioning the Myco Vault SQLite Schema

The Myco vault is a SQLite database at `.myco/myco.db`. Its schema evolves through a numbered migration chain — each version is an incremental step applied on top of the previous one. This matters because vaults are long-lived: users have real sessions, spores, and graph data that must survive every upgrade. Breaking the chain means breaking their data.

## Prerequisites

- Know which schema version is current. Check `SCHEMA_VERSION` in `packages/myco/src/db/schema.ts`.
- Know the migration chain itself — the `MIGRATIONS` registry array and every `migrateVXToVY` function — lives in a *separate* file, `packages/myco/src/db/migrations.ts` (~4,400 lines). `schema.ts` only owns the version constant, the fresh-install DDL application, and `createSchema()`'s driver loop.
- Know exactly what you're adding — table name, column names and types, constraints, indexes.
- Understand whether the change needs a **backfill** (populating existing rows after adding a column) or is append-only.

## Steps

### 1. Find the schema files and the current version

```bash
grep -n "SCHEMA_VERSION = " packages/myco/src/db/schema.ts
```

`createSchema()` (in `schema.ts`) is the driver, not the chain itself:

```ts
export function createSchema(db: Database, machineId: string = DEFAULT_MACHINE_ID): void {
  if (hasSchemaVersionTable(db)) {
    // existing vault: run any migrations the vault hasn't reached yet
    for (const migration of MIGRATIONS) {
      const version = getCurrentVersion(db);       // re-read every iteration
      if (version < migration.version) {
        migration.migrate(db, machineId);
      }
    }
    reapplyCurrentSchemaDdl(db);
    return;
  }
  // fresh install: apply every CURRENT table/FTS/index/trigger DDL at once
  // and stamp schema_version = SCHEMA_VERSION directly — the migration
  // chain never runs for a brand-new vault.
  ...
}
```

Two consequences worth internalizing before you touch anything:
- **A fresh install never runs your migration function.** It only ever runs for a vault that already has a `schema_version` table below the version you're adding. Test both paths (see step 7).
- **The loop re-reads the current version on every iteration**, not once at the top. If a migration throws, everything already committed (via that migration's own transaction — see step 3) stays committed, and the next `createSchema()` call resumes from there instead of re-running completed steps.

Read `packages/myco/src/db/migrations.ts` in full before touching it — skim the `MIGRATIONS` array at the top, then find `migrateV71ToV72` (or whatever the most recent function is) as your shape reference.

### 2. Increment the version constant

Change `SCHEMA_VERSION` in `schema.ts` from `N` to `N+1`. This is the version the vault will be at after your migration runs.

```ts
// Before
export const SCHEMA_VERSION = 72;

// After
export const SCHEMA_VERSION = 73;
```

Do this first so you never forget — the constant and the migration entry must always match.

### 3. Register the migration and write its function

In `migrations.ts`, append one entry to the **end** of the `MIGRATIONS` array:

```ts
export const MIGRATIONS: Migration[] = [
  // ... existing entries ...
  { version: 73, migrate: (db) => migrateV72ToV73(db) },
];
```

Then write the function itself, anywhere in the "Individual migration functions" section further down the file (functions are **not** kept in strict version order there — the array above is what determines execution order, not file position):

```ts
function migrateV72ToV73(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id);`);

    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
    ).run(73, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}
```

Key rules:
- **The `Migration` interface is exactly `{ version: number; migrate: (db: Database, machineId: string) => void }`.** There is no `name`, `description`, or `up` field — don't invent one.
- **Wrap the entire body in an explicit `BEGIN` / `COMMIT`, with a `catch` that `ROLLBACK`s and rethrows.** This is not reserved for multi-statement or "complex" migrations — every migration in the chain uses this exact shape, including single-statement ones, so a failure partway through never leaves the vault stamped at a version it didn't fully reach.
- **The migration advances the version by inserting its own row into `schema_version`** — `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`, immediately before `COMMIT`. There is no `PRAGMA user_version` write for the vault schema (see step 5 for where that confusion comes from).
- Only take a `machineId` second parameter if the migration actually needs it for a backfill (e.g. `migrateV19ToV20`, `migrateV51ToV52`); most migrations take just `db`.
- **Each migration is one conceptual change.** Don't fold unrelated schema changes into one version bump.

### 4. Frozen literal SQL — never reference live schema constants or query helpers

Two hard rules, both enforced structurally by `tests/db/migration-matrix.test.ts`:

**Every migration's SQL must be a literal string frozen at the revision that ships it.** Never write `db.exec(ddl)` against the live `TABLE_DDLS`, `FTS_TABLES`, `SECONDARY_INDEXES`, or `TEAM_DELETE_TRIGGERS` arrays (imported from `schema-ddl.ts`) inside a migration function — a later addition to those constants silently changes what an already-shipped historical migration does, and can brick the chain outright if the addition targets a table that doesn't exist yet at that point in history. This actually happened: v41 shipped applying live `SECONDARY_INDEXES` and broke every vault stamped v34–v40 once `session_myco_tool_calls` indexes were added alongside v45. `reapplyCurrentSchemaDdl()` (in `schema.ts`) is what supplies everything newer, once, after the whole chain completes — that's the only place live constants belong. (`migrateV33ToV34` is the one documented exception, used as a rescue floor for pre-v34 vaults; it creates every table before any index specifically so it can't hit the missing-table failure class. Don't add a second exception without equally strong justification.) A trigger **body** change ships as a new DROP-then-recreate migration (v53 is the precedent) — `CREATE TRIGGER IF NOT EXISTS` alone never refreshes an existing trigger's body.

**Never call a `db/queries/*` helper function from inside a migration — inline the literal SQL instead**, even when a query module already has a function that does exactly what you need. Two reasons, and the second is the sneaky one:
1. **Frozen history** — a migration step that imports a live helper silently changes what the shipped migration does whenever that helper is later edited, same failure class as the live-DDL rule above.
2. **Wrong-connection binding** — many query helpers (e.g. `purgePendingOutbox` in `packages/myco/src/db/queries/team-outbox.ts`) bind the `getDatabase()` singleton internally rather than accepting a `db` handle. Calling one from a migration running on a *passed* `db` (as every `createSchema` chain step does, including the `:memory:` databases every migration test uses) executes against a **different database** than the one being migrated — passing on real vaults by coincidence (where the singleton and the real vault happen to be the same file) while silently corrupting a test's isolation.

`migrateV71ToV72` is the precedent for both rules: instead of calling `purgePendingOutbox`, it copies that function's SQL character-for-character (`DELETE FROM team_outbox WHERE sent_at IS NULL`) as a frozen literal.

### 4a. Adding a table

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
```

`IF NOT EXISTS` on both the table and its indexes makes the statements safe to re-run if a partial upgrade retries.

### 4b. Adding a column — idempotency via `PRAGMA table_info`, not try/catch

SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` form and throws if the column already exists. The pattern used throughout `migrations.ts` is `getTableColumnSet()` (a `PRAGMA table_info` wrapper already defined near the top of the "Individual migration functions" section) plus an explicit `.has()` check — **not** a try/catch that swallows the "duplicate column" error:

```ts
function migrateV66ToV67(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    const cols = getTableColumnSet(db, 'skill_lineage');
    if (!cols.has('machine_id')) {
      db.prepare("ALTER TABLE skill_lineage ADD COLUMN machine_id TEXT NOT NULL DEFAULT 'local'").run();
    }
    if (!cols.has('synced_at')) {
      db.prepare('ALTER TABLE skill_lineage ADD COLUMN synced_at INTEGER').run();
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
    ).run(67, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}
```

### 4c. Backfill step (when needed)

Backfill in the *same* migration, after the `ALTER TABLE`, before `COMMIT`:

```ts
db.exec(`ALTER TABLE spores ADD COLUMN machine_id TEXT;`);
db.exec(`UPDATE spores SET machine_id = 'local' WHERE machine_id IS NULL;`);
```

Backfills must complete inside the same `BEGIN`/`COMMIT` as the DDL — never split DDL and backfill across two version blocks for the same change; a crash between them would leave the vault at a version whose backfill never ran.

### 4d. Recreating a table (rename → create → copy → drop)

SQLite only allows adding columns; changing a column's type or dropping/renaming a column requires a full table rebuild. Rename the live table out of the way, create the new shape from a **frozen** literal DDL string (never the live `TABLE_DDLS` constant — see step 4), copy forward only the columns that exist on both shapes, then drop the renamed original:

```ts
function migrateV39ToV40(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    db.prepare('ALTER TABLE agent_state RENAME TO agent_state_v39').run();
    db.exec(V40_AGENT_STATE_TABLE); // frozen literal DDL, not the live constant
    db.prepare(
      `INSERT INTO agent_state (id, project_id, /* ... */)
       SELECT id, project_id, /* ... */ FROM agent_state_v39`,
    ).run();
    db.prepare('DROP TABLE agent_state_v39').run();

    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
    ).run(40, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}
```

The whole rename-create-copy-drop sequence stays inside the migration's own `BEGIN`/`COMMIT` — never a separate transaction.

### 5. Version tracking is a `schema_version` table — not `PRAGMA user_version`

The vault's current version is read with:

```ts
db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
```

and advanced by the `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING` shown in step 3. There is no `PRAGMA user_version` involved in vault schema versioning.

`PRAGMA user_version` **does** exist elsewhere in this codebase — it tracks `VEC_STORE_SCHEMA_VERSION` for the separate `vectors.db` (the sqlite-vec embedding store, `packages/myco/src/daemon/embedding/sqlite-vec-store.ts`). That's a different SQLite file with its own independent version scheme; don't let a grep hit there convince you the main vault uses the same mechanism.

### 6. Keep the dormant team-sync worker's D1 mirror in parity

**Team sync is retired — there is no live D1 deployment to push to.** The legacy Cloudflare
team-sync transport, routes, config, and UI are gone; `packages/myco-team` (worker + CLI) is
preserved in-repo but dormant — typecheck-only, no longer published or deployed. Schema v72
cleared the `team_sync_membership` gate and reset `team_sync_state.enabled`, so the outbox
enqueue path is quiescent for every vault today (preserved machinery, not an active pipeline;
Phase-F reuse pending). **Do not** add a live D1 deployment step to your migration workflow.

What still matters: the worker's own DDL (`packages/myco-team/worker/src/schema.ts`) and the
cross-package parity test (`tests/db/synced-table-parity.test.ts`) are still real, still-enforced
parts of this repo's test suite — they exist to keep the dormant worker's mirror internally
consistent for whenever this machinery is revived. If the table you're changing is in the
worker's synced-table set, you still need to update the worker mirror so CI stays green, even
though nothing is deployed.

#### 6a. Identify whether your table is in the synced-table set

```bash
grep -r "BACKFILL_TABLES\|LOCAL_ONLY" packages/myco/src/db/queries/team-outbox.ts
```

The authoritative synced-table set lives in `packages/myco-team/worker/src/synced-tables.ts` (`SYNCED_TABLES`). If your changed table is in that set, the parity rule below is mandatory — otherwise you're done, skip to step 7.

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

**Older binary on a newer schema is safe for additive-nullable columns.** The local `createSchema` migration loop no-ops when the vault's version is already ahead of the running binary's `SCHEMA_VERSION` (every entry's `version < migration.version` check fails), and every query names its columns explicitly rather than `SELECT *`. So a machine still on an older binary reading a vault another machine migrated forward keeps working, as long as the new columns are **additive and nullable** (no NOT-NULL-without-default, no dropped/renamed columns an old query still references). This is the guarantee that lets a mixed-version team share one synced schema.

There is no `wrangler d1 execute` deployment step to run — the worker isn't deployed anywhere. Updating the mirror DDL and passing the parity test above is the entire scope of "D1 sync" for this repo today.

### 7. Test the migration

**Write a per-migration test in `tests/db/`** — this is the primary verification method, not a manual smoke. `tests/db/migrate-v71-to-v72-team-sync-quiesce.test.ts` is the current reference shape:

```ts
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { Database } from 'bun:sqlite';

function seedV72LegacyVault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');
  // Roll the stamped version back to simulate a vault frozen at the prior version.
  db.prepare('DELETE FROM schema_version WHERE version > 72').run();
  // ...seed any legacy-shaped rows the migration needs to observe...
  return db;
}

describe('migrateV72ToV73 — <what it does>', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(73); // never pin an exact number
  });

  it('a fresh install already has the new shape', () => {
    const db = new Database(':memory:');
    createSchema(db);
    // assert the new column/table/data shape directly
  });

  it('a v72 vault migrates to v73 on the next createSchema() call', () => {
    const db = seedV72LegacyVault();
    createSchema(db);
    // assert the migration's effect
  });

  it('is idempotent — a second createSchema() call does not error or duplicate effects', () => {
    const db = seedV72LegacyVault();
    createSchema(db);
    createSchema(db); // second boot
    // assert nothing changed on the second call
  });
});
```

Run it directly:

```bash
npm test -- tests/db/migrate-v72-to-v73-<slug>.test.ts
```

**Then run the whole-chain structural guard**, `tests/db/migration-matrix.test.ts` — it upgrades authentic historical fresh-vault fixtures (one per past `SCHEMA_VERSION`, under `tests/db/fixtures/historical/`) through the entire current chain and asserts the result is structurally identical to a fresh-created vault. This is the test that would have caught v41's premature `SECONDARY_INDEXES` reference (step 4) before it bricked v34–v40 vaults — treat it as mandatory after any migration change, not optional:

```bash
npm test -- tests/db/migration-matrix.test.ts
```

If you want to additionally sanity-check against a real on-disk vault, simulate the prior version the same way the tests do — via the `schema_version` table, not `PRAGMA user_version`:

```bash
sqlite3 .myco/myco.db "DELETE FROM schema_version WHERE version > 72;"
myco doctor   # or any command that opens the vault — triggers createSchema()
sqlite3 .myco/myco.db "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1;"
```

### 8. Update schema documentation

If the project has a schema changelog or version reference file, add an entry:

```
v73 (2026-07-16): Added parent_session_id to sessions table for lineage tracking
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
myco service stop      # or the service stop for your install

# 2. Back up the DB and its write-ahead log together — the WAL holds
#    committed pages not yet checkpointed into the main file; copying the
#    .db without the .wal can restore a torn state.
GROVE_DB=~/.myco/groves/<grove-id>/myco.db
cp "$GROVE_DB"      "$GROVE_DB.bak"
cp "$GROVE_DB-wal"  "$GROVE_DB-wal.bak" 2>/dev/null || true

# 3. Open the vault once with the new binary so createSchema runs the
#    migration chain to the new SCHEMA_VERSION.
myco service start
#    (or any command that opens the vault, e.g. `myco doctor`)

# 4. Verify: version advanced and the new column/table is present and intact.
sqlite3 "$GROVE_DB" "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1;"
sqlite3 "$GROVE_DB" ".schema <changed_table>"
sqlite3 "$GROVE_DB" "PRAGMA integrity_check;"   # must print 'ok'
```

If `integrity_check` reports anything but `ok`, or the migration errored, restore from the backup (`mv "$GROVE_DB.bak" "$GROVE_DB"` and the WAL) and fix the migration before retrying. Never leave the daemon running against a half-migrated vault.

## Common Pitfalls

**Never edit an existing migration function.** Once a version ships, real vaults have already applied it. Changing it means the migration won't re-run for existing users. If you need to fix a past migration, add a new version that corrects it.

**Never reference live schema constants or `db/queries/*` helpers from inside a migration.** See step 4 — this is the single highest-value rule in this skill. Both failure modes (a later DDL addition retroactively changing a shipped migration's behavior, and a query helper silently binding the `getDatabase()` singleton instead of the migration's own `db` handle) are invisible locally and only surface on a vault or test that happens to diverge from the coincidental common case. `tests/db/migration-matrix.test.ts` structurally enforces the DDL half; there's no automated enforcement for the query-helper half, so review for it explicitly (spore `gotcha-55c32500`).

**NOT NULL columns without defaults will fail on existing data.** Either provide a DEFAULT in the DDL, or backfill immediately after the ALTER TABLE and before `COMMIT`.

**Older SQLite releases may not support DROP COLUMN.** If targeting older SQLite (common in embedded contexts), use the rename→create→copy→drop pattern instead (step 4d).

**Every migration wraps itself in its own `BEGIN`/`COMMIT`/`ROLLBACK` — this is mandatory, not just for multi-statement migrations.** If a version's body executes multiple statements and one fails mid-way without this wrapping, the vault can be left in a partially migrated state:

```ts
function migrateVNToVN1(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    db.exec(`ALTER TABLE foo RENAME TO foo_old;`);
    db.exec(`CREATE TABLE foo ( /* new */ );`);
    db.exec(`INSERT INTO foo SELECT * FROM foo_old;`);
    db.exec(`DROP TABLE foo_old;`);
    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
    ).run(/* N */, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}
```

**A missing worker mirror update fails CI, not a live deployment.** Team sync itself is retired and quiescent (no live D1 exists to drift against today), but `tests/db/synced-table-parity.test.ts` still enforces that the dormant worker's DDL matches the local schema for every synced table. Skipping step 6a-parity turns that test red — treat it the same as any other failing test, not as an optional cleanup step.

**A new column on a synced table with no worker mirror would stall sync for the whole table if this machinery is ever reactivated.** The worker builds its INSERT column list from the row payload, so an unmirrored column would make D1 throw `no such column` for every synced row — silently, with no local error. This can't happen today (nothing is deployed), but the parity test exists precisely so it can't happen on the day Phase-F revives the pipeline either. Apply the 3-part worker pattern (DDL + idempotent ALTER + `verifyColumnsAddressable`) from step 6a-parity and run `tests/db/synced-table-parity.test.ts`, which fails and names any local column missing from the D1 mirror. A column that is deliberately local-only belongs in `LOCAL_ONLY_SYNC_COLUMNS` instead.
