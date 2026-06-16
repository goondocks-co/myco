---
name: myco:vault-schema-extension
description: |
  Use this skill when adding or evolving Myco's SQLite vault database schema and its Cloudflare D1 cloud counterpart — even if the user doesn't explicitly ask for "schema work." Covers: authoring versioned migration scripts with correct error guards (IF NOT EXISTS, user_version bumps), evolving existing tables with ALTER TABLE in a backfill-safe sequence, creating and populating FTS5 full-text search indexes with auto-sync triggers, keeping local SQLite and D1 schemas in sync (including D1's lazy-migration behaviour where ALTER TABLE applies on the first request after deploy, not at deploy time), selecting the right query patterns (WHERE IN with json_each for dynamic ID sets, hydration joins instead of N+1 selects, cursor-based pagination instead of OFFSET), Grove multi-tenant database design for global daemon architecture, and updating the constants and query modules that complete the data layer surface. Every new Myco feature that stores data touches this domain.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Vault Schema and Data Layer Extension

MycoVault stores all project intelligence in a local SQLite file (`.myco/myco.db`) and mirrors the schema to Cloudflare D1 for team sync. Every new feature that persists data requires a versioned migration entry in the MIGRATIONS registry, query functions, and — depending on the feature — an FTS5 index and D1 alignment. Schema versions progress monotonically (v6→v7→v8→v9→…); each migration is a self-contained, idempotent entry in the declarative MIGRATIONS array. Grove architecture extends this foundation with global daemon coordination patterns and multi-project data organization.

## Prerequisites

- Know what data needs to be stored and how it relates to existing tables (`sessions`, `spores`, `entities`, `edges`, etc.)
- Check the current highest version in the `MIGRATIONS` array in `packages/myco/src/db/migrations.ts`
- Decide upfront whether the table needs FTS5 (required if the intelligence agent will keyword-search it) and D1 alignment (required if the cloud MCP server queries it)
- Understand Grove architecture implications for multi-project data coordination
- For Grove migrations: understand project-scoped row management and migration_import_journal patterns
- **For legacy database migration**: Be aware of historical column renames (e.g., `agent_runs.runtime` was renamed to `agent_runs.harness` in v29) that require schema normalization before Grove import

## Procedure A: Adding a New Table

Follow these steps in order. Skipping the query functions or constants update leaves the data layer incomplete.

### 1. Add migration to the MIGRATIONS registry

Locate the migration runner (`packages/myco/src/db/migrations.ts`). Add a new `Migration` entry to the `MIGRATIONS` array:

```typescript
export const MIGRATIONS: Migration[] = [
  // ... existing migrations
  {
    version: 21,
    name: 'add_my_new_table',
    description: 'Add my_new_table for <purpose>',
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS my_new_table (
          id          TEXT PRIMARY KEY,
          session_id  TEXT,
          content     TEXT NOT NULL,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_my_new_table_session
          ON my_new_table(session_id);
        CREATE INDEX IF NOT EXISTS idx_my_new_table_created_at
          ON my_new_table(created_at DESC);
      `);
    }
  }
];
```

Key rules:
- **Always use `IF NOT EXISTS`** — migrations run at every startup and must be idempotent.
- **Add all indexes inline** with the table creation. Putting them in a later migration risks a partial-schema state if the process dies between versions.
- Use `INTEGER NOT NULL DEFAULT (unixepoch())` for timestamps — store Unix epoch seconds, not ISO strings.
- Use `TEXT PRIMARY KEY` with a UUID for entity tables; use `INTEGER PRIMARY KEY AUTOINCREMENT` only for pure log/event tables where an ordered surrogate is the point.
- **Each migration is atomic** — the migration runner applies all migrations up to the highest version or rolls back entirely on failure.

### 2. Create the query functions

Add query functions directly in the appropriate module or create a dedicated query module as needed. All SQL lives in the appropriate query modules — never inline SQL strings in MCP handlers or business logic.

### 3. Update schema constants

Open `packages/myco/src/db/schema-ddl.ts` and update the relevant constants. Add to `TABLE_DDLS` (always), `FTS_TABLES` (if FTS5-indexed), and `SECONDARY_INDEXES` (if custom indexes exist).

### 4. Wire the MCP surface (if needed)

If the table should be queryable via the MCP server, add a tool or resource in the appropriate MCP handler file, following the existing pattern for similar tables.

## Procedure B: Evolving an Existing Table (ALTER TABLE)

Use `ALTER TABLE` for additive changes (new columns). SQLite does not support dropping or renaming columns without a full table rebuild — avoid both on a live vault.

### Adding a column

```typescript
{
  version: 22,
  name: 'add_supersedes_column',
  description: 'Add supersedes column to skill_candidates',
  up: (db: Database) => {
    db.exec(`ALTER TABLE skill_candidates ADD COLUMN supersedes TEXT;`);
    // Backfill: give existing rows a safe default before any code relies on the column
    db.exec(`UPDATE skill_candidates SET supersedes = '[]' WHERE supersedes IS NULL;`);
  }
}
```

Rules:
- **Never add `NOT NULL` without a `DEFAULT`** — existing rows fail the constraint on open.
- **Backfill in the same migration**, before the migration completes. This keeps the migration atomic: either both the schema change and the backfill succeed, or the whole migration retries.
- **One conceptual change per migration** — keep each migration atomic and describable in a single sentence.
- Update the query functions' INSERT and SELECT statements and the TypeScript row interface to include the new column.

### Column renames (legacy considerations)

SQLite requires full table rebuild for column rename. For historical context, `agent_runs.runtime` was renamed to `agent_runs.harness` in v29. Always update query functions and TypeScript interfaces when column names change.

### What never to do

- `DROP COLUMN` — SQLite requires a full table rebuild; it will corrupt existing vaults opened with the old schema.
- `RENAME COLUMN` — same constraint.
- Two unrelated `ALTER TABLE` statements in one migration — if one fails, the retry will attempt both again and the first may throw "duplicate column."

## Procedure C: D1/Cloud Schema Alignment

Cloudflare D1 mirrors the local SQLite schema for team sync. Critical behavioural difference: **D1 migrations apply lazily on the first request after deploy, not at deploy time.**

### Mitigating the lazy-migration gotcha

1. **Explicit migration endpoint** — expose `POST /migrate` that runs all pending DDL. Call it from your deploy script immediately after `wrangler deploy`.
2. **Defensive `IF NOT EXISTS` everywhere** — never use bare `CREATE TABLE` on D1.
3. **Dead-letter row pattern** — for high-value writes where silent loss is unacceptable, catch the "no such table" error and store the payload for replay.

`ALTER TABLE` on D1 is safe: it applies on the next request with no table lock. Guard reads against new columns until you know migration has run.

## Procedure D: FTS5 Index Creation and Maintenance

Tables that the intelligence agent keyword-searches need FTS5 virtual tables with auto-sync triggers. Add both in the same migration entry as the source table. `CREATE TRIGGER IF NOT EXISTS` is mandatory — without it, re-opening the DB after a partial migration creates duplicate triggers and corrupts the FTS index.

Always JOIN the source table in FTS queries — FTS virtual tables only expose indexed text columns plus `rowid`:

```typescript
export function searchMyNewTable(db: Database, query: string, limit = 20): MyNewTableRow[] {
  return db.prepare(`
    SELECT t.* FROM my_new_table t
    JOIN my_new_table_fts fts ON t.rowid = fts.rowid
    WHERE my_new_table_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(query, limit) as MyNewTableRow[];
}
```

## Procedure E: Migration Testing and Conflict Resolution

Always design migrations to be re-runnable safely using `PRAGMA table_info` checks for column existence:

```typescript
const columnExists = db.prepare(`
  SELECT COUNT(*) as count FROM pragma_table_info('my_table') WHERE name = 'new_column'
`).get() as {count: number};
if (columnExists.count === 0) {
  db.exec(`ALTER TABLE my_table ADD COLUMN new_column TEXT;`);
}
```

## Procedure F: Query Pattern Selection and Optimization

| Situation | Pattern | Reason |
|---|---|---|
| `WHERE id IN (dynamic list)` | `json_each(json(?))` | Stable, cacheable query shape |
| JS `.filter()` on DB results | Push condition into SQL | SQLite uses indexes |
| New table creation | Add `(agent_id, status)` index immediately | Avoid full table scan later |
| Pagination | keyset cursor | Never OFFSET |
| `db.prepare()` inside function | Move to module scope | Compiled once at load |

**`json_each` for Variable-Length List Filters:**
```typescript
// ✅ Single stable shape — compiled and cached once
db.prepare(`
  SELECT s.* FROM spores s
  JOIN json_each(json(?)) je ON s.id = je.value
  WHERE s.agent_id = ?
`).all(JSON.stringify(ids), agentId);
```

**NOT EXISTS for zero-injection session detection:**
```typescript
db.prepare(`
  SELECT s.id FROM sessions s WHERE s.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM activities WHERE session_id = s.id
        AND json_extract(content, '$.tool_name') IN
            ('myco:inject_cortex', 'myco:inject_spores', 'myco:inject_canopy')
    ) LIMIT 100
`).all();
```

## Procedure G: Grove Project-Scoped Schema Architecture

Grove migration (v31-v32) adds `project_id` columns across 24+ tables. Always scope queries by `project_id` in Grove context. **Grove activation must not import directly from legacy DBs with older schemas** — serialize the legacy DB, run current migrations on a copy, then import from the schema-aligned source.

## Procedure H: Git Reconciler Schema Design for Release Provenance

Two tables for release provenance tracking (both include `project_id` and `grove_id`):
- **knowledge_git_provenance** — Raw Git evidence at session lifecycle points
- **knowledge_release_state** — Derived release classification with reconciliation logic

## Procedure I: Migration Chain Validation

Test the complete migration path, not just individual migrations. Follow patterns from existing tests (`tests/db/migrate-v40.test.ts`). Assert invariants, not version constants:
```javascript
expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
```

## Procedure J: Fresh Install vs Migration Equivalence Testing

Fresh installs follow CREATE TABLE column order; migrated databases append ALTER TABLE columns at the end. Test column addressability by name, not ordinal position. Use `PRAGMA table_info(table_name)` to check column existence.

## Procedure K: Migration Test Hardening

```javascript
// BAD — breaks after every migration
expect(SCHEMA_VERSION).toBe(41);
// GOOD — tests compatibility
expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
// Test actual schema structure instead of version numbers
const tableInfo = await db.prepare("PRAGMA table_info(skill_candidates)").all();
expect(tableInfo.some(col => col.name === 'quality_score')).toBe(true);
```

## Procedure L: D1 Schema Parity Management

Treat D1 schema updates as a required paired step with any SQLite schema change that syncs to team. Run `npm test -- tests/worker/schema.test.ts` to validate D1 compatibility.

## Procedure M: Session Lifecycle Batch Management and Tool Call Aggregation

Tool call counts are materialized at session Stop boundary via `aggregateSessionMycoToolCalls()`:
- Flat table design: `(session_id, tool_name, op, count)` — no denormalized JSON
- Stop boundary timing: aggregation at session completion, not per-call
- Team sync exclusion: tool usage data remains local-only
- Idempotent: uses UPSERT patterns

**Phantom Batch Detection**: Schema v44 requires checking for orphaned session references before adding FK constraints:
```sql
SELECT s.id, pb.id FROM sessions s
LEFT JOIN prompt_batches pb ON s.id = pb.session_id
WHERE s.status = 'active' AND pb.id IS NULL;
```

## Procedure N: D1 Drift Reconciliation Architecture

Team sync scenarios can create schema version mismatches. Always query D1 schema version before sync operations and implement graceful degradation. Use defensive column-checking before INSERT in reconciliation code.

## Procedure O: Tool Name Canonicalization and Injection Dedup for Activities

- **MCP Prefix Stripping**: Raw tool names include `mcp__myco-vault__` prefixes — strip for analytics
- **Injection dedup scope**: Per `(project_id, content_hash)` — prevents duplicate processing across worktrees while allowing same injection in different projects
- **Synthetic injection tool names**: `myco:inject_cortex`, `myco:inject_spores`, `myco:inject_canopy`
- **Retroactive application**: Apply canonicalization to existing activities during migration, not just new ones

## Procedure P: Vec0 Virtual Table Schema Management

The sqlite-vec extension powers semantic search via `vec0` virtual tables (one per embeddable namespace). Critical constraint: **vec0 has no `ALTER TABLE`**. Adding partition keys or metadata columns requires a full table rebuild.

### Filterable-Key Registry (SSoT)

All filterable key definitions live in `packages/myco/src/semantic-search-filters.ts` as `FILTERABLE_KEY_REGISTRY`. The vec0 store derives its column layout, upsert projection, and KNN query routing from this single registry. **Never hardcode vec0 column lists** — always derive from the registry.

Three strategies per key:
- `'partition'` — vec0 partition key (equality-only; tenancy scope)
- `'column'` — in-KNN metadata column (TEXT, equality, must be short <12 chars, and **embed-stable**: never patched after insert)
- `'postKnn'` — filtered post-KNN via `json_extract` on `embedding_metadata.domain_metadata`

### Vec0 Migration Pattern

When the vec0 schema changes (new partition key or metadata column), increment `VEC_STORE_SCHEMA_VERSION` (tracked via `PRAGMA user_version` on the vectors database). Migration steps:

1. Create a temp table: `CREATE VIRTUAL TABLE vec_<ns>__migrating USING vec0(...)` with the new layout
2. Backfill with a pure in-engine `INSERT … SELECT` joining the old vec table to `embedding_metadata` to project values from `domain_metadata` JSON — no JS round-trip, no re-embedding
3. Drop the old table and rename the migration table
4. Repeat for each embeddable namespace

See `packages/myco/src/daemon/embedding/sqlite-vec-store.ts` for the reference implementation (`vecMigratingTable`, `vecBackfillSelect`).

### Team Sync Protocol Versioning

Any breaking team sync schema change must assess `SYNC_PROTOCOL_VERSION` in `packages/myco/src/constants.ts`. Bump it if the change breaks wire compatibility with older clients.

## Cross-Cutting Gotchas

- **`IF NOT EXISTS` is mandatory everywhere** — migrations run at every startup; a bare `CREATE TABLE` throws on the second run.
- **Each migration is atomic** — all migrations up to the highest version succeed or the runner rolls back entirely.
- **D1 ALTER TABLE is lazy** — the column does not exist on D1 until the first post-deploy request. Guard reads against new columns until migration has run.
- **FTS triggers must use `IF NOT EXISTS`** — duplicate triggers corrupt the index silently.
- **Never post-filter in JS what SQL can filter** — use `json_each` for dynamic ID sets, JOIN for related data, keyset cursors for pagination.
- **All SQL lives in query modules** — no inline SQL in MCP handlers or business logic.
- **Scan `packages/myco/src/db/schema-ddl.ts` after every new table** — missing `TABLE_DDLS` or `FTS_TABLES` registration silently limits feature surface.
- **Grove `project_id` is mandatory in v31+** — all new project-scoped tables must include `project_id` and all queries must scope by it.
- **Column Order Drift** — Fresh installs and migrated databases have different column orders. Test column addressability by name using `PRAGMA table_info`, never by position.
- **Version Pinning Fragility** — Tests asserting `SCHEMA_VERSION === N` break immediately when the schema advances. Test schema capabilities and invariants instead.
- **D1 Parity Gaps** — Adding columns to SQLite without updating D1 schema causes silent sync failures. Treat D1 updates as mandatory paired steps.
- **ensureOpenBatch Dependencies** — Schema v44+ migrations that create tool call aggregation tables must account for sessions that may not have active batches.
- **Phantom Batch States** — Always check for orphaned session references before adding FK constraints.
- **Tool usage data is local-only** — `session_myco_tool_calls` does not sync to team D1 databases.
- **Vec0 has no ALTER TABLE** — any change to partition keys or metadata columns requires a full table rebuild using the temp-table + `INSERT…SELECT` migration pattern.
- **`patchDomainMetadata` updates the JSON blob only** — it writes to `embedding_metadata.domain_metadata` but does NOT update vec0 partition or metadata columns. Keys patched in-place after embedding (e.g., `release_state`, `release_confidence`) MUST use the `'postKnn'` strategy in `FILTERABLE_KEY_REGISTRY`; promoting them to `'column'` causes stale in-KNN filter values that silently exclude matching rows.
- **`SYNC_PROTOCOL_VERSION` must be assessed on breaking team sync schema changes** — bump it in `packages/myco/src/constants.ts` if the wire format breaks compatibility with older clients.
- **Vec0 missing-value sentinel is `''` (empty string), not NULL** — sqlite-vec rejects NULL binds on partition/column values. Records missing a filtered field use `''`, which correctly excludes them from equality filters but is wrong for range comparisons — which is why range keys stay `postKnn`.
- **Migration PR sequencing** — Only one schema-changing PR may merge to main at a time. Any branch cut before that merge must rebase onto post-merge main and take the next sequential version number before submitting. Two branches with the same migration version silently collide — the first to merge wins; the second fails at startup.
- **`purgeNonMemberOutbox` empty-set guard** — When `memberProjectIds` is empty, SQLite's `NOT IN ()` predicate matches every non-NULL row, silently wiping all team outbox entries. Always guard with an early-return check before calling `purgeNonMemberOutbox` when the member list may be empty.
- **`team_sync_membership` is the tenancy-authority table** — `project-tenancy.ts:reconcileClient` projects team membership computation into `team_sync_membership`. Code determining team-sync eligibility must JOIN this table; never replicate the membership logic inline.
