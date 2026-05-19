---
name: myco:vault-schema-extension
description: |
  Use this skill when adding or evolving Myco's SQLite vault database schema and its Cloudflare D1 cloud counterpart — even if the user doesn't explicitly ask for "schema work." Covers: authoring versioned migration scripts with correct error guards (IF NOT EXISTS, user_version bumps), evolving existing tables with ALTER TABLE in a backfill-safe sequence, creating and populating FTS5 full-text search indexes with auto-sync triggers, keeping local SQLite and D1 schemas in sync (including D1's lazy-migration behaviour where ALTER TABLE applies on the first request after deploy, not at deploy time), selecting the right query patterns (WHERE IN with json_each for dynamic ID sets, hydration joins instead of N+1 selects, cursor-based pagination instead of OFFSET), Grove multi-tenant database design for global daemon architecture, and updating the constants and query modules that complete the data layer surface. Every new Myco feature that stores data touches this domain.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Vault Schema and Data Layer Extension

Myco stores all project intelligence in a local SQLite file (`.myco/myco.db`) and mirrors the schema to Cloudflare D1 for team sync. Every new feature that persists data requires a versioned migration entry in the MIGRATIONS registry, query functions, and — depending on the feature — an FTS5 index and D1 alignment. Schema versions progress monotonically (v6→v7→v8→v9→…); each migration is a self-contained, idempotent entry in the declarative MIGRATIONS array. Grove architecture extends this foundation with global daemon coordination patterns and multi-project data organization.

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

For historical context, some columns have been renamed over time (e.g., `agent_runs.runtime` → `agent_runs.harness` in v29). When working with legacy databases, SQLite requires full table rebuild for column rename. Always update query functions and TypeScript interfaces when column names change to maintain consistency across the codebase.

### What never to do

- `DROP COLUMN` — SQLite requires a full table rebuild; it will corrupt existing vaults that have been opened with the old schema.
- `RENAME COLUMN` — same constraint.
- Two unrelated `ALTER TABLE` statements in one migration — if one fails, the retry will attempt both again, and the first may now throw "duplicate column."

## Procedure C: D1/Cloud Schema Alignment

Cloudflare D1 mirrors the local SQLite schema for team sync. Its critical behavioural difference: **D1 migrations apply lazily on the first request after deploy, not at deploy time.** A table added in a Workers deployment does not exist on D1 until that first request triggers migration.

### Maintaining the D1 migration file

Keep a parallel migration file in the Workers project using the same version number as the local migration. Apply via: `wrangler d1 migrations apply <db-name> --env staging`

### Mitigating the lazy-migration gotcha

Because the table doesn't exist until the first request, a cloud handler that assumes the table is present can throw on the very first post-deploy request. Three mitigations:

1. **Explicit migration endpoint** — expose `POST /migrate` that runs all pending DDL. Call it from your deploy script immediately after `wrangler deploy`.
2. **Defensive `IF NOT EXISTS` everywhere** — this is already required; never use bare `CREATE TABLE` on D1.
3. **Dead-letter row pattern** — for high-value writes where silent loss is unacceptable, catch the "no such table" error and store the payload in a `dead_letter` table for replay once the schema is ready.

### ALTER TABLE on D1

`ALTER TABLE` on D1 is safe: it applies on the next request with no table lock and no downtime. The column simply doesn't exist on D1 until that request fires. Plan reads against the new column accordingly — guard with `IS NOT NULL` or a fallback until you know migration has run.

## Procedure D: FTS5 Index Creation and Maintenance

Tables that the intelligence agent keyword-searches need FTS5 virtual tables with auto-sync triggers.

### Creating the FTS5 virtual table and triggers

Add both in the same migration entry as the source table. `CREATE TRIGGER IF NOT EXISTS` is mandatory — without it, re-opening the DB after a partial migration creates duplicate triggers and corrupts the FTS index.

### FTS5 search query pattern

Always JOIN the source table — FTS virtual tables only expose the indexed text columns plus `rowid`:

```typescript
export function searchMyNewTable(
  db: Database,
  query: string,
  limit = 20
): MyNewTableRow[] {
  return db.prepare(`
    SELECT t.*
    FROM my_new_table t
    JOIN my_new_table_fts fts ON t.rowid = fts.rowid
    WHERE my_new_table_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as MyNewTableRow[];
}
```

### Backfilling existing rows into a new FTS index

If FTS is added to a table that already has rows, populate the index in the migration.

## Procedure E: Migration Testing and Conflict Resolution

For complex migrations involving data transformations or potential conflicts, implement test-driven migration patterns.

### Migration Test Patterns

Include test functions in the migration module for complex data transformations. Always design migrations to be re-runnable safely using `PRAGMA table_info` checks for column existence.

### Idempotent Migration Guards

Always design migrations to be re-runnable safely:

```typescript
{
  version: 23,
  name: 'add_column_with_check',
  description: 'Add new_column to my_table with safety check',
  up: (db: Database) => {
    const columnExists = db.prepare(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('my_table')
      WHERE name = 'new_column'
    `).get() as {count: number};

    if (columnExists.count === 0) {
      db.exec(`ALTER TABLE my_table ADD COLUMN new_column TEXT;`);
    }
  }
}
```

## Procedure F: Query Pattern Selection and Optimization

Choose the right pattern upfront — post-filter in JS is a performance trap that compounds as the table grows. The Myco vault is accessed by both the daemon and MCP tool handlers, which can be called in tight loops by agent pipelines. Small query inefficiencies compound quickly.

### Core Optimization Patterns

| Situation | Pattern | Reason |
|---|---|---|
| `WHERE id IN (dynamic list)` | `json_each(json(?))` | Stable, cacheable query shape |
| JavaScript `.filter()` on DB results | Push condition into SQL | SQLite query planner uses indexes |
| New table creation | Add `(agent_id, status)` index immediately | Avoid full table scan later |
| Pagination endpoint | `listWithCount` combined query | Never two round-trips |
| `db.prepare()` inside function | Move to module scope | Compiled once at load |

### Pattern 1: Use `json_each` for Variable-Length List Filters

```typescript
// ❌ Different statement shape for each call — not cacheable
const placeholders = ids.map(() => '?').join(',');
db.prepare(`SELECT * FROM spores WHERE id IN (${placeholders})`).all(...ids);

// ✅ Single stable shape — compiled and cached once
db.prepare(`
  SELECT s.*
  FROM spores s
  JOIN json_each(json(?)) je ON s.id = je.value
  WHERE s.agent_id = ?
`).all(JSON.stringify(ids), agentId);
```

### Pattern 2: Add Indexes at Schema Definition Time

Add covering indexes for all primary query shapes in the same `CREATE TABLE` migration:

```sql
-- For any table with agent-scoped queries:
CREATE INDEX IF NOT EXISTS idx_my_table_agent_status
  ON my_table (agent_id, status);

-- For join/lookup columns (e.g., outbox FK queries):
CREATE INDEX IF NOT EXISTS idx_team_outbox_table_row
  ON team_outbox (table_name, row_id);
```

**Index gaps to watch**: SQLite does not auto-index foreign keys; explicitly add indexes for all FK columns, `WHERE`/`ORDER BY` columns, and `created_at` if filtered/sorted by time.

## Procedure G: Grove Project-Scoped Schema Architecture

Grove's global daemon architecture introduces project-scoped row management patterns requiring specialized schema design considerations.

### Project-Scoped Row Management

Grove migration (v31-v32) adds `project_id` columns across 24+ tables for proper project-scoped access. When querying in Grove context, always scope by project_id to maintain proper isolation.

### Migration Import Journal Pattern

Grove migration introduces `migration_import_journal` tables for tracking data imports from legacy project vaults.

### Grove Migration Contract Requirements

**CRITICAL**: Grove activation must not import directly from legacy DBs with older schema versions. The migration contract requires a three-step normalization process:

```bash
# Step 1: Serialize the legacy DB (preserves exact state)
sqlite3 legacy_vault.db ".backup legacy_serialized.db"

# Step 2: Run current schema migrations on a copy
cp legacy_serialized.db normalized_import.db
myco-cli migrate --vault normalized_import.db  # Brings to current schema

# Step 3: Import from normalized copy (matching schema)
grove-importer import --source normalized_import.db --target grove_db.db
```

**Why this matters**: Legacy vaults can have outdated column names (e.g., `agent_runs.runtime` before the v29 harness rename to `agent_runs.harness`) while the Grove importer expects current schema. Direct import from mismatched schema causes activation failures.

## Procedure H: Git Reconciler Schema Design for Release Provenance

The Git reconciler feature introduces schema tables to distinguish between work that has shipped to production and work still in development. This enables agents to make informed decisions about knowledge relevance and maturity.

### Schema Design: Two-Table Architecture

Implement release provenance as two tables that follow Grove + project scoping requirements:

#### knowledge_git_provenance (Raw Git Evidence)

Captures factual git state at session lifecycle points (session_start, batch_start, batch_stop, session_end).

#### knowledge_release_state (Derived Release Classification)

Computes release state from git provenance with reconciliation logic:
- Session spans main/master branch → likely shipped
- Session on feature branch that later merged to main → shipped  
- Session entirely on feature branch with no main merge → development
- Mixed signals → development (conservative classification)

### Critical Design Requirements

**Grove + Project Scoping**: Both tables include `project_id` for project isolation and `grove_id` for cross-project coordination. This enables session-level release status for local intelligence and organizational patterns about shipping velocity across projects.

**Capture Points**: Git provenance captures at four lifecycle points to detect mid-session commits, branch switches, and merge events that change release classification.

## Procedure I: Migration Chain Validation

Test the complete migration path from v1 to current version, not just individual migrations.

### Steps

1. **Run Existing Migration Tests**: Execute specific migration version tests that exist in the codebase
   ```bash
   npm test -- tests/db/migrate-v40.test.ts
   npm test -- tests/db/migrate-v43-activity-not-null.test.ts
   npm test -- tests/db/project-id-cleanup-migration.test.ts
   ```

2. **Verify Schema Invariants**: Test that all expected tables, columns, and indexes exist
   ```javascript
   // Assert invariants, not version constants
   import { SCHEMA_VERSION } from '@myco/db/schema.js';
   expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
   
   // Verify actual schema structure
   const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
   expect(tables.map(t => t.name)).toContain('skill_candidates');
   ```

3. **Test Migration Idempotency**: Ensure migrations can be run multiple times safely
   ```bash
   # Apply migrations twice - second run should be no-op  
   npm run build && npm run db:migrate
   npm run build && npm run db:migrate  # Should not fail or change anything
   ```

**Key Pattern**: Always test the real migration chain rather than constructing specific versions manually. Follow the pattern from existing tests like `tests/db/migrate-v40.test.ts`.

## Procedure J: Fresh Install vs Migration Equivalence Testing

Verify that fresh installs and migrated databases produce functionally equivalent schemas.

### Steps

1. **Create Two Database Instances**: Database A (fresh install from DDL), Database B (migrate from earlier version)

2. **Compare Schema Structure by Column Names**: Use the pattern from existing tests
   ```javascript
   function getColumnNames(db: Database, tableName: string): string[] {
     const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
     return rows.map(r => r.name);
   }
   
   // Verify expected columns exist and are addressable
   const freshColumns = getColumnNames(freshDb, 'skill_candidates');
   const migratedColumns = getColumnNames(migratedDb, 'skill_candidates');
   
   expect(freshColumns).toContain('quality_score');
   expect(migratedColumns).toContain('quality_score');
   // Don't assert column order - fresh vs migrated differ
   ```

3. **Test Functional Equivalence**: Run identical queries against both databases

**Gotcha**: Fresh installs follow CREATE TABLE column order; migrated databases append ALTER TABLE columns at the end. Test column addressability, not ordinal position.

## Procedure K: Migration Test Hardening

Write tests that survive schema evolution and don't break on version advances.

### Steps

1. **Avoid Version Pinning**: Don't assert exact `SCHEMA_VERSION` values
   ```javascript
   // BAD - breaks after every migration
   expect(SCHEMA_VERSION).toBe(41);
   
   // GOOD - tests compatibility
   expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
   ```

2. **Test Schema Invariants**: Assert actual database structure, not version numbers
   ```javascript
   const tableInfo = await db.prepare("PRAGMA table_info(skill_candidates)").all();
   const hasQualityScore = tableInfo.some(col => col.name === 'quality_score');
   expect(hasQualityScore).toBe(true);
   ```

3. **Use Current Schema**: Test against the current state, not historical snapshots

**Pattern**: Tests should check invariants ("this feature works") rather than absolute values ("version is exactly X"). Follow the patterns from `tests/db/migrate-v40.test.ts` and `tests/db/schema.test.ts`.

## Procedure L: D1 Schema Parity Management

Ensure SQLite schema changes are propagated to D1 deployment schema.

### Steps

1. **Identify Sync Tables**: Determine which tables sync to D1 via team CLI
   ```bash
   grep -r "skill_candidates" packages/myco-team/ --include="*.ts" | grep -i sync
   ```

2. **Update D1 Schema Files**: Add new columns to D1 schema configuration following patterns from team deployment

3. **Create Idempotent D1 Migrations**: Add `ALTER TABLE` statements for existing D1 databases

4. **Test D1 Compatibility**: Run schema validation tests
   ```bash
   npm test -- tests/worker/schema.test.ts
   ```

**Critical Rule**: Treat D1 schema updates as a required paired step with any SQLite schema change that syncs to team. Add checklist verification for D1 column parity.

## Cross-Cutting Gotchas

- **`IF NOT EXISTS` is mandatory everywhere** — on both `CREATE TABLE` and `CREATE TRIGGER`. Migrations run at every startup; a bare `CREATE TABLE` throws on the second run.
- **Each migration is atomic** — the migration runner applies all migrations up to the highest version or rolls back entirely on failure.
- **D1 ALTER TABLE is lazy** — the column does not exist on D1 until the first post-deploy request triggers migration. Guard reads against new columns until you know migration has run.
- **FTS triggers must use `IF NOT EXISTS`** — duplicate triggers corrupt the index silently.
- **Never post-filter in JS what SQL can filter** — use `json_each` for dynamic ID sets, JOIN for related data, and keyset cursors for pagination.
- **All SQL lives in the appropriate query modules** — no inline SQL in MCP handlers or business logic. This keeps it grep-able, testable, and refactorable.
- **Scan `packages/myco/src/db/schema-ddl.ts` after every new table** — missing a registration in `TABLE_DDLS` or `FTS_TABLES` silently limits the feature surface.
- **Grove project_id is mandatory in v31+** — all new project-scoped tables must include a project_id column and all project-scoped queries must scope by project_id.
- **Grove migration contract enforcement** — never import directly from legacy DBs with older schemas. Always serialize legacy DB, run current migrations on normalized copy, then import from schema-aligned source.
- **Historical column renames** — be aware of column renames like `agent_runs.runtime` → `agent_runs.harness` (v29) when working with legacy database imports or when updating query functions. Always use current column names in new code.
- **Column Order Drift** — Fresh installs and migrated databases have different column orders. Always test column addressability by name using `PRAGMA table_info`, never by position. Use the `getColumnNames()` helper pattern from `packages/myco/src/db/migrations.ts`.
- **Version Pinning Fragility** — Tests asserting `SCHEMA_VERSION === N` break immediately when the schema advances. Test schema capabilities and invariants instead of exact version numbers. Import `SCHEMA_VERSION` from `packages/myco/src/db/schema.ts` and use relative comparisons.
- **D1 Parity Gaps** — Adding columns to SQLite without updating D1 schema causes silent sync failures. The team CLI at `packages/myco-team/src/cli.ts` manages D1 deployment - treat D1 updates as mandatory paired steps.
- **Test Chain Assumptions** — Hand-building specific schema versions in tests misses migration chain interactions. Follow patterns from existing migration tests like `tests/db/migrate-v40.test.ts` that test real migration sequences.