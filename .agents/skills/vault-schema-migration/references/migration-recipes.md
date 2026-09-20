# Migration Recipes — Tables, Columns, Backfills, Table Recreation

Reference material for the `vault-schema-migration` skill.

## 4a. Adding a table

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

## 4b. Adding a column — idempotency via `PRAGMA table_info`, not try/catch

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

## 4c. Backfill step (when needed)

Backfill in the *same* migration, after the `ALTER TABLE`, before `COMMIT`:

```ts
db.exec(`ALTER TABLE spores ADD COLUMN machine_id TEXT;`);
db.exec(`UPDATE spores SET machine_id = 'local' WHERE machine_id IS NULL;`);
```

Backfills must complete inside the same `BEGIN`/`COMMIT` as the DDL — never split DDL and backfill across two version blocks for the same change; a crash between them would leave the vault at a version whose backfill never ran.

## 4d. Recreating a table (rename → create → copy → drop)

SQLite only allows adding columns; changing a column's type or dropping/renaming a column requires a full table rebuild. Rename the live table out of the way, create the new shape from a **frozen** literal DDL string (never the live `TABLE_DDLS` constant — see step 4), copy forward only the columns that exist on both shapes, then drop the renamed original.

**Hold foreign keys OFF for the rebuild — outside `BEGIN`, restored in `finally`.** Every connection runs `PRAGMA foreign_keys = ON` (`db/client.ts`), so the copy re-validates every historical row against live FK constraints that were only enforced at original insert time. One orphaned row — plantable by `restoreBackup` (which runs FK-off with `INSERT OR IGNORE`), a partial import, or any historical write path — then rolls the migration back and the vault **refuses to open, on this start and every one after it**. `migrateV33ToV34` is the precedent and `migrateV74ToV75` follows it: save `foreign_keys` + `legacy_alter_table` with `readPragmaNumber`, clear both with `setPragmaBoolean` *before* `BEGIN`, restore both in the `finally`. And seed an orphaned row in the migration's test — an FK-clean fixture cannot see this failure class:

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
