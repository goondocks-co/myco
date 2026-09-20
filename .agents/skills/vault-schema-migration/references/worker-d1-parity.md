# Keeping the Team-Sync Worker D1 Mirror in Parity

Reference material for the `vault-schema-migration` skill.

## 6. Keep the dormant team-sync worker's D1 mirror in parity

**Team sync is retired — there is no live D1 deployment to push to.** The legacy Cloudflare
team-sync transport, routes, config, and UI are gone; `packages/myco-team` (worker + CLI) is
preserved in-repo but dormant — typecheck-only, no longer published or deployed. Schema v72
cleared the `team_sync_membership` gate and reset `team_sync_state.enabled`, so the outbox
enqueue path is quiescent for every vault today (preserved machinery, not an active pipeline;
Phase-F reuse pending). **Do not** add a live D1 deployment step to the migration workflow.

What still matters: the worker's own DDL (`packages/myco-team/worker/src/schema.ts`) and the
cross-package parity test (`tests/db/synced-table-parity.test.ts`) are still real, still-enforced
parts of this repo's test suite — they exist to keep the dormant worker's mirror internally
consistent for whenever this machinery is revived. If the table being changed is in the
worker's synced-table set, the worker mirror still needs updating so CI stays green, even
though nothing is deployed.

### 6a. Identify whether the table is in the synced-table set

```bash
grep -r "BACKFILL_TABLES\|LOCAL_ONLY" packages/myco/src/db/queries/team-outbox.ts
```

The authoritative synced-table set lives in `packages/myco-team/worker/src/synced-tables.ts` (`SYNCED_TABLES`). If the changed table is in that set, the parity rule below is mandatory — otherwise the work is done — skip to step 7.

### 6a-parity. The synced-column parity rule — every local column must reach the D1 mirror

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
