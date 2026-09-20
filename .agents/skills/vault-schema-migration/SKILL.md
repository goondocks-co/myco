---
name: vault-schema-migration
description: >-
  This skill should be used when the user asks to "add a column", "create a new table", "add
  an index", or otherwise change the Myco vault SQLite schema. Because user vaults hold real
  data across machines, a broken migration chain destroys it. Covers appending a version to
  the `createSchema` chain, writing safe migration SQL, backfill steps, bumping the schema
  version constant, keeping the team-sync worker’s D1 mirror parity-clean when the table is
  in the synced set, and verifying the migration end-to-end before shipping.
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safely Versioning the Myco Vault SQLite Schema

The Myco vault is a SQLite database at `.myco/myco.db`. Its schema evolves through a numbered migration chain — each version is an incremental step applied on top of the previous one. This matters because vaults are long-lived: users have real sessions, spores, and graph data that must survive every upgrade. Breaking the chain means breaking their data.

## Prerequisites

- Know which schema version is current. Check `SCHEMA_VERSION` in `packages/myco/src/db/schema.ts`.
- Know the migration chain itself — the `MIGRATIONS` registry array and every `migrateVXToVY` function — lives in a *separate* file, `packages/myco/src/db/migrations.ts` (~4,400 lines). `schema.ts` only owns the version constant, the fresh-install DDL application, and `createSchema()`'s driver loop.
- The exact shape of the change is known — table name, column names and types, constraints, indexes.
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

Two consequences to internalize before touching anything:
- **A fresh install never runs the new migration function.** It only ever runs for a vault that already has a `schema_version` table below the version being added. Test both paths (see step 7).
- **The loop re-reads the current version on every iteration**, not once at the top. If a migration throws, everything already committed (via that migration's own transaction — see step 3) stays committed, and the next `createSchema()` call resumes from there instead of re-running completed steps.

Read `packages/myco/src/db/migrations.ts` in full before touching it — skim the `MIGRATIONS` array at the top, then find `migrateV71ToV72` (or whatever the most recent function is) as the shape reference.

### 2. Increment the version constant

Change `SCHEMA_VERSION` in `schema.ts` from `N` to `N+1`. This is the version the vault lands on after the migration runs.

```ts
// Before
export const SCHEMA_VERSION = 72;

// After
export const SCHEMA_VERSION = 73;
```

Do this first — the constant and the migration entry must always match.

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

**Never call a `db/queries/*` helper function from inside a migration — inline the literal SQL instead**, even when a query module already has a function that does exactly what is needed. Two reasons, and the second is the sneaky one:
1. **Frozen history** — a migration step that imports a live helper silently changes what the shipped migration does whenever that helper is later edited, same failure class as the live-DDL rule above.
2. **Wrong-connection binding** — many query helpers (e.g. `purgePendingOutbox` in `packages/myco/src/db/queries/team-outbox.ts`) bind the `getDatabase()` singleton internally rather than accepting a `db` handle. Calling one from a migration running on a *passed* `db` (as every `createSchema` chain step does, including the `:memory:` databases every migration test uses) executes against a **different database** than the one being migrated — passing on real vaults by coincidence (where the singleton and the real vault happen to be the same file) while silently corrupting a test's isolation.

`migrateV71ToV72` is the precedent for both rules: instead of calling `purgePendingOutbox`, it copies that function's SQL character-for-character (`DELETE FROM team_outbox WHERE sent_at IS NULL`) as a frozen literal.

### 5. Version tracking is a `schema_version` table — not `PRAGMA user_version`

The vault's current version is read with:

```ts
db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
```

and advanced by the `INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING` shown in step 3. There is no `PRAGMA user_version` involved in vault schema versioning.

`PRAGMA user_version` **does** exist elsewhere in this codebase — it tracks `VEC_STORE_SCHEMA_VERSION` for the separate `vectors.db` (the sqlite-vec embedding store, `packages/myco/src/daemon/embedding/sqlite-vec-store.ts`). That's a different SQLite file with its own independent version scheme; don't let a grep hit there justify assuming the main vault uses the same mechanism.

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

To additionally sanity-check against a real on-disk vault, simulate the prior version the same way the tests do — via the `schema_version` table, not `PRAGMA user_version`:

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

## Additional Resources

- **`references/migration-recipes.md`** — Migration Recipes — Tables, Columns, Backfills, Table Recreation
- **`references/offline-vault-migration.md`** — Migrating a Real Existing Vault Offline
- **`references/worker-d1-parity.md`** — Keeping the Team-Sync Worker D1 Mirror in Parity

## Common Pitfalls

**Never edit an existing migration function.** Once a version ships, real vaults have already applied it. Changing it means the migration won't re-run for existing users. To correct a past migration, add a new version that corrects it.

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
