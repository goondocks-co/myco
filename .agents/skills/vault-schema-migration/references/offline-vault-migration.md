# Migrating a Real Existing Vault Offline

Reference material for the `vault-schema-migration` skill.

## 9. Migrate a real existing vault offline (with backup)

To apply a new binary's migration to a live vault that already holds real data (e.g. before shipping, or to recover a stuck vault), do it offline with a backup so a bad migration is fully reversible:

```bash
# 1. Stop the daemon so nothing writes mid-migration.
myco service stop      # or the service stop for the install

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
