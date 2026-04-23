---
name: myco:vault-schema-extension
description: |
  Use this skill when adding or evolving Myco's SQLite vault database schema and its Cloudflare D1 cloud counterpart — even if the user doesn't explicitly ask for "schema work." Covers: authoring versioned migration scripts with correct error guards (IF NOT EXISTS, user_version bumps), evolving existing tables with ALTER TABLE in a backfill-safe sequence, creating and populating FTS5 full-text search indexes with auto-sync triggers, keeping local SQLite and D1 schemas in sync (including D1's lazy-migration behaviour where ALTER TABLE applies on the first request after deploy, not at deploy time), selecting the right query patterns (WHERE IN with json_each for dynamic ID sets, hydration joins instead of N+1 selects, cursor-based pagination instead of OFFSET), and updating the constants and query modules that complete the data layer surface. Every new Myco feature that stores data touches this domain.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Vault Schema and Data Layer Extension

Myco stores all project intelligence in a local SQLite file (`.myco/myco.db`) and mirrors the schema to Cloudflare D1 for team sync. Every new feature that persists data requires a versioned migration block, query functions, and — depending on the feature — an FTS5 index and D1 alignment. Schema versions progress monotonically (v6→v7→v8→v9→…); each version is a self-contained, idempotent block in the migration runner.

## Prerequisites

- Know what data needs to be stored and how it relates to existing tables (`sessions`, `spores`, `entities`, `edges`, etc.)
- Identify the current `user_version` — check `packages/myco/src/db/migrations.ts` or run `PRAGMA user_version;` against `.myco/myco.db`
- Decide upfront whether the table needs FTS5 (required if the intelligence agent will keyword-search it) and D1 alignment (required if the cloud MCP server queries it)

## Procedure A: Adding a New Table

Follow these steps in order. Skipping the query functions or constants update leaves the data layer incomplete.

### 1. Write the migration block

Locate the migration runner (`packages/myco/src/db/migrations.ts`). Add a new version block at the end:

```typescript
// v9 — add my_new_table for <purpose>
if (currentVersion < 9) {
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
  db.pragma('user_version = 9');
}
```

Key rules:
- **Always use `IF NOT EXISTS`** — migrations run at every startup and must be idempotent.
- **Bump `user_version` last**, after all DDL in the block succeeds. If the block throws partway through, the version stays at the previous value and the migration retries on the next startup — this is intentional.
- **Add all indexes inline** with the table creation. Putting them in a later block risks a partial-schema state if the process dies between versions.
- Use `INTEGER NOT NULL DEFAULT (unixepoch())` for timestamps — store Unix epoch seconds, not ISO strings.
- Use `TEXT PRIMARY KEY` with a UUID for entity tables; use `INTEGER PRIMARY KEY AUTOINCREMENT` only for pure log/event tables where an ordered surrogate is the point.

### 2. Create the query functions

Add query functions directly in the appropriate module or create a dedicated query module as needed:

```typescript
import type { Database } from 'better-sqlite3';

export interface MyNewTableRow {
  id: string;
  session_id: string | null;
  content: string;
  created_at: number;
}

export function insertMyNewTableRow(
  db: Database,
  row: { id: string; sessionId: string | null; content: string }
): void {
  db.prepare(`
    INSERT INTO my_new_table (id, session_id, content)
    VALUES (@id, @sessionId, @content)
  `).run(row);
}

export function getMyNewTableBySession(
  db: Database,
  sessionId: string
): MyNewTableRow[] {
  return db.prepare(`
    SELECT * FROM my_new_table
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId) as MyNewTableRow[];
}
```

All SQL lives in the appropriate query modules — never inline SQL strings in MCP handlers or business logic.

### 3. Update schema constants

Open `packages/myco/src/db/schema-ddl.ts` and update the relevant constants:

| Constant | Add the table if… |
|---|---|
| `TABLE_DDLS` | Always add new table DDL definition |
| `FTS_TABLES` | Table is FTS5-indexed and searchable |
| `SECONDARY_INDEXES` | Table has custom indexes beyond primary key |

Review the schema-ddl.ts file to identify other table registration constants that may apply to your new table. Look for patterns like how existing tables (sessions, spores, etc.) are registered and follow the same registration approach.

Find all places a similar table name appears to avoid missing any registration point:

```bash
grep -r "prompt_batches" packages/myco/src/config/ packages/myco/src/db/ --include="*.ts" -l
```

### 4. Wire the MCP surface (if needed)

If the table should be queryable via the MCP server, add a tool or resource in the appropriate MCP handler file, following the existing pattern for similar tables.

## Procedure B: Evolving an Existing Table (ALTER TABLE)

Use `ALTER TABLE` for additive changes (new columns). SQLite does not support dropping or renaming columns without a full table rebuild — avoid both on a live vault.

### Adding a column

```typescript
// v10 — add supersedes column to skill_candidates
if (currentVersion < 10) {
  db.exec(`ALTER TABLE skill_candidates ADD COLUMN supersedes TEXT;`);
  // Backfill: give existing rows a safe default before any code relies on the column
  db.exec(`UPDATE skill_candidates SET supersedes = '[]' WHERE supersedes IS NULL;`);
  db.pragma('user_version = 10');
}
```

Rules:
- **Never add `NOT NULL` without a `DEFAULT`** — existing rows fail the constraint on open.
- **Backfill in the same version block**, before bumping `user_version`. This keeps the migration atomic: either both the schema change and the backfill succeed, or the whole block retries.
- **One conceptual change per version block** — keep each version atomic and describable in a single sentence.
- Update the query functions' INSERT and SELECT statements and the TypeScript row interface to include the new column.

### What never to do

- `DROP COLUMN` — SQLite requires a full table rebuild; it will corrupt existing vaults that have been opened with the old schema.
- `RENAME COLUMN` — same constraint.
- Two unrelated `ALTER TABLE` statements in one version block — if one fails, the retry will attempt both again, and the first may now throw "duplicate column."

## Procedure C: D1/Cloud Schema Alignment

Cloudflare D1 mirrors the local SQLite schema for team sync. Its critical behavioural difference: **D1 migrations apply lazily on the first request after deploy, not at deploy time.** A table added in a Workers deployment does not exist on D1 until that first request triggers migration.

### Maintaining the D1 migration file

Keep a parallel migration file in the Workers project (e.g., in the team package migrations directory):

```sql
-- 0009_add_my_new_table.sql
CREATE TABLE IF NOT EXISTS my_new_table (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_my_new_table_session
  ON my_new_table(session_id);
```

Use the same version number as the local migration. Apply via:

```bash
wrangler d1 migrations apply <db-name> --env staging
```

Verify the migration ran before promoting to production.

### Mitigating the lazy-migration gotcha

Because the table doesn't exist until the first request, a cloud handler that assumes the table is present can throw on the very first post-deploy request. Three mitigations (use the one that fits your deployment process):

1. **Explicit migration endpoint** — expose `POST /migrate` that runs all pending DDL. Call it from your deploy script immediately after `wrangler deploy`.
2. **Defensive `IF NOT EXISTS` everywhere** — this is already required; never use bare `CREATE TABLE` on D1.
3. **Dead-letter row pattern** — for high-value writes where silent loss is unacceptable, catch the "no such table" error and store the payload in a `dead_letter` table for replay once the schema is ready.

### ALTER TABLE on D1

`ALTER TABLE` on D1 is safe: it applies on the next request with no table lock and no downtime. The column simply doesn't exist on D1 until that request fires. Plan reads against the new column accordingly — guard with `IS NOT NULL` or a fallback until you know migration has run.

## Procedure D: FTS5 Index Creation and Maintenance

Tables that the intelligence agent keyword-searches need FTS5 virtual tables with auto-sync triggers.

### Creating the FTS5 virtual table and triggers

Add both in the same migration block as the source table:

```typescript
if (currentVersion < 9) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS my_new_table (
      id      TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Content-table FTS5: reads from source table, stays in sync via triggers
    CREATE VIRTUAL TABLE IF NOT EXISTS my_new_table_fts
      USING fts5(
        content,
        content='my_new_table',
        content_rowid='rowid'
      );

    CREATE TRIGGER IF NOT EXISTS my_new_table_fts_insert
      AFTER INSERT ON my_new_table BEGIN
        INSERT INTO my_new_table_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;

    CREATE TRIGGER IF NOT EXISTS my_new_table_fts_delete
      BEFORE DELETE ON my_new_table BEGIN
        INSERT INTO my_new_table_fts(my_new_table_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;

    CREATE TRIGGER IF NOT EXISTS my_new_table_fts_update
      AFTER UPDATE ON my_new_table BEGIN
        INSERT INTO my_new_table_fts(my_new_table_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO my_new_table_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;
  `);
  db.pragma('user_version = 9');
}
```

`CREATE TRIGGER IF NOT EXISTS` is mandatory — without it, re-opening the DB after a partial migration creates duplicate triggers and corrupts the FTS index.

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

If FTS is added to a table that already has rows, populate the index in the migration block before bumping the version:

```typescript
if (currentVersion < 10) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS my_new_table_fts
      USING fts5(content, content='my_new_table', content_rowid='rowid');
    INSERT INTO my_new_table_fts(rowid, content)
      SELECT rowid, content FROM my_new_table;
  `);
  db.pragma('user_version = 10');
}
```

## Procedure E: Migration Testing and Conflict Resolution

For complex migrations involving data transformations or potential conflicts, implement test-driven migration patterns.

### Migration Test Patterns

Include test functions in the migration module for complex data transformations:

```typescript
// Migration v20 example with collision resolution
if (currentVersion < 20) {
  // Complex plan identity collision resolution
  const collisions = db.prepare(`
    SELECT logical_key, COUNT(*) as count 
    FROM plans 
    GROUP BY logical_key 
    HAVING count > 1
  `).all();
  
  if (collisions.length > 0) {
    resolveV20PlanIdentityCollisionsForTest(db, collisions);
  }
  
  db.pragma('user_version = 20');
}

export function resolveV20PlanIdentityCollisionsForTest(
  db: Database, 
  collisions: Array<{logical_key: string, count: number}>
): void {
  for (const collision of collisions) {
    // Implement collision resolution logic
    const duplicates = db.prepare(`
      SELECT id, created_at FROM plans 
      WHERE logical_key = ?
      ORDER BY created_at ASC
    `).all(collision.logical_key);
    
    // Keep first, remove rest
    for (let i = 1; i < duplicates.length; i++) {
      db.prepare(`DELETE FROM plans WHERE id = ?`).run(duplicates[i].id);
    }
  }
}
```

This pattern allows for complex migration logic to be tested in isolation and provides visibility into the migration process.

### Idempotent Migration Guards

Always design migrations to be re-runnable safely:

```typescript
// Check if migration already applied before making changes
if (currentVersion < 21) {
  const columnExists = db.prepare(`
    SELECT COUNT(*) as count 
    FROM pragma_table_info('my_table') 
    WHERE name = 'new_column'
  `).get() as {count: number};
  
  if (columnExists.count === 0) {
    db.exec(`ALTER TABLE my_table ADD COLUMN new_column TEXT;`);
  }
  
  db.pragma('user_version = 21');
}
```

## Procedure F: Query Pattern Selection and Optimization

Choose the right pattern upfront — post-filter in JS is a performance trap that compounds as the table grows. The Myco vault is accessed by both the daemon and MCP tool handlers, which can be called in tight loops by agent pipelines. Small query inefficiencies compound quickly.

### Pattern 1: Use `json_each` for Variable-Length List Filters

**Problem:** `WHERE id IN (?, ?, ?)` creates a new statement shape for every list length. SQLite cannot cache the query plan, so every call re-parses and re-plans.

**Solution:** Pass a JSON array and use `json_each(json(?))` to produce a stable, cacheable query shape.

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

This pattern was applied to `hydrateSearchResults`, which was previously re-prepared on every invocation and used an uncacheable `IN` shape.

### Pattern 2: Filter in SQL, Not in JavaScript

**Problem:** Fetching all rows and filtering by a condition in application code is O(n) memory allocation plus a full-table read. SQLite's query planner can use indexes; JavaScript cannot.

```typescript
// ❌ Load everything, filter in memory
const all = db.prepare('SELECT * FROM edges').all();
const relevant = all.filter(e => ids.includes(e.source_id));

// ✅ Push the filter into SQL
db.prepare(`
  SELECT * FROM edges
  WHERE source_id IN (SELECT value FROM json_each(json(?)))
`).all(JSON.stringify(ids));
```

Both `hydrateSearchResults` and the graph edge query were rewritten using this pattern. If you find yourself writing `.filter()` or `.find()` on a database result set, that's a signal to push the condition into SQL.

### Pattern 3: Add Indexes at Schema Definition Time

**Problem:** Adding an index to a populated table requires a full table scan to build the index. Deferring index creation is a common source of production slowdowns.

**Rule:** Add covering indexes for all primary query shapes in the same `CREATE TABLE` migration. Typical patterns:

```sql
-- For any table with agent-scoped queries:
CREATE INDEX IF NOT EXISTS idx_my_table_agent_status
  ON my_table (agent_id, status);

-- For join/lookup columns (e.g., outbox FK queries):
CREATE INDEX IF NOT EXISTS idx_team_outbox_table_row
  ON team_outbox (table_name, row_id);
```

The `(agent_id, status)` composite was added to `skill_candidates` and `skill_records`. The `(table_name, row_id)` index was needed for the `NOT EXISTS` outbox backfill query on team sync.

### Pattern 4: Pre-Compile Prepared Statements and Regex at Module Scope

**Problem:** `db.prepare(sql)` inside a function body re-compiles the statement on every call. A regex literal inside a function body is reconstructed on every call.

```typescript
// ❌ Compiled fresh on every invocation
export function getSpore(db, id) {
  return db.prepare('SELECT * FROM spores WHERE id = ?').get(id);
}

// ✅ Compiled once at module load
const GET_SPORE = (db: Database) =>
  db.prepare('SELECT * FROM spores WHERE id = ?');

// Or, if db is module-level:
const getSporeStmt = db.prepare('SELECT * FROM spores WHERE id = ?');

// Same for regex:
// ❌ New RegExp on every call
function validate(val: string) {
  return /^[a-z_]+$/.test(val); // recreated every call
}

// ✅ Module-scope constant
const VALID_NAME = /^[a-z_]+$/;
function validate(val: string) {
  return VALID_NAME.test(val);
}
```

This matters most for MCP tool handlers called in agent loops.

### Pattern 5: Combined `listWithCount` — Never Two Round-Trips for Pagination

When a list endpoint needs both a page of rows and a total count, issue both queries in the same function call (not two separate exported functions called sequentially).

```typescript
export function listSpores(db, agentId, opts) {
  const rows = db.prepare(`
    SELECT * FROM spores WHERE agent_id = ? AND status = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(agentId, opts.status, opts.limit, opts.offset);

  const { total } = db.prepare(`
    SELECT COUNT(*) as total FROM spores
    WHERE agent_id = ? AND status = ?
  `).get(agentId, opts.status) as { total: number };

  return { rows, total };
}
```

The anti-pattern is calling `list()` then `count()` separately in the handler — that's two SQLite round-trips for one logical operation. The update handler for skill records was refactored away from this pattern.

### Hydration joins (avoid N+1)

```typescript
// ❌ N+1: one query per batch to fetch its session
const batches = db.prepare('SELECT * FROM prompt_batches').all();
for (const b of batches) {
  b.session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
}

// ✓ Single JOIN
const rows = db.prepare(`
  SELECT b.*, s.title AS session_title, s.status AS session_status
  FROM prompt_batches b
  LEFT JOIN sessions s ON b.session_id = s.id
  ORDER BY b.id ASC
`).all();
```

### Cursor-based pagination (avoid OFFSET)

OFFSET degrades linearly with table size — it scans and discards N rows on every page. Use a keyset cursor instead:

```typescript
export function getSporesAfter(
  db: Database,
  afterId: string | null,
  limit = 50
): SporeRow[] {
  if (afterId) {
    return db.prepare(`
      SELECT * FROM spores
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId, limit) as SporeRow[];
  }
  return db.prepare(`
    SELECT * FROM spores
    ORDER BY id ASC
    LIMIT ?
  `).all(limit) as SporeRow[];
}
```

Return the last row's `id` as `next_cursor` in API responses. Clients pass it back as `after_id`.

### Index gaps to watch for

SQLite does not auto-index foreign keys. After adding any table, explicitly verify indexes exist for:

- All foreign key columns (`session_id`, `entity_id`, …)
- Columns used in `WHERE` or `ORDER BY` in high-frequency queries
- `created_at` if the table is filtered or sorted by time

```typescript
// Example: idx_sessions_created_at was missing, causing full-table scans
// on session list queries. Add it explicitly:
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_created_at
    ON sessions(created_at DESC);
`);
```

After adding an index to production, verify the query plan with `EXPLAIN QUERY PLAN`:

```bash
sqlite3 .myco/myco.db "EXPLAIN QUERY PLAN SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50;"
# Should show "USING INDEX idx_sessions_created_at", not "SCAN sessions"
```

### Query Optimization Quick Reference

| Situation | Pattern |
|---|---|
| `WHERE id IN (dynamic list)` | `json_each(json(?))` |
| JavaScript `.filter()` on DB results | Push condition into SQL |
| New table creation | Add `(agent_id, status)` index immediately |
| Pagination endpoint | `listWithCount` combined query |
| `db.prepare()` inside function | Move to module scope |
| `/regex/` inside function | Move to module scope |

## File Layout Reference

```
packages/myco/
  src/
    db/
      migrations.ts            # All versioned migration blocks, in order
      schema-ddl.ts            # Table DDL definitions and constants
packages/myco-team/
  migrations/                  # Parallel D1 SQL migration files
    0009_add_my_new_table.sql
```

## Cross-Cutting Gotchas

- **`IF NOT EXISTS` is mandatory everywhere** — on both `CREATE TABLE` and `CREATE TRIGGER`. Migrations run at every startup; a bare `CREATE TABLE` throws on the second run.
- **Bump `user_version` last** — partial migrations retry on next startup. This is the correct recovery path.
- **D1 ALTER TABLE is lazy** — the column does not exist on D1 until the first post-deploy request triggers migration. Guard reads against new columns until you know migration has run.
- **FTS triggers must use `IF NOT EXISTS`** — duplicate triggers corrupt the index silently.
- **Never post-filter in JS what SQL can filter** — use `json_each` for dynamic ID sets, JOIN for related data, and keyset cursors for pagination.
- **All SQL lives in the appropriate query modules** — no inline SQL in MCP handlers or business logic. This keeps it grep-able, testable, and refactorable.
- **Scan `packages/myco/src/db/schema-ddl.ts` after every new table** — missing a registration in `TABLE_DDLS` or `FTS_TABLES` silently limits the feature surface.
- **Review schema-ddl.ts for table registration constants after every new table** — missing registrations in various table arrays silently limits the feature surface.
- **Migration test functions for complex transformations** — include test helpers like `resolveV20PlanIdentityCollisionsForTest` for migrations that involve data conflicts or complex transformations.