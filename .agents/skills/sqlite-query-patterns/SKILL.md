---
name: myco:sqlite-query-patterns
description: |
  Apply this skill when writing or reviewing SQLite queries in the Myco vault codebase (src/db/). Activates for tasks involving variable-length list filtering, hydration queries, full-text search result joining, or any query that currently filters results in JavaScript after fetching from the database. Also applies when diagnosing slow queries, reviewing new db modules, or writing team-sync outbox queries. Use this skill even if the user doesn't explicitly ask about query optimization — any time you're writing a WHERE clause with a dynamic list, a hydration loop, or a pagination query, these patterns apply.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# SQLite Query Optimization Patterns for the Myco Vault

The Myco vault is a single embedded SQLite database accessed by both the daemon and MCP tool handlers, which can be called in tight loops by agent pipelines. Small query inefficiencies compound quickly. This skill is a pattern catalog — apply the relevant rule when you encounter the corresponding situation.

## Pattern 1: Use `json_each` for Variable-Length List Filters

**Problem:** `WHERE id IN (?, ?, ?)` creates a new statement shape for every list length. SQLite cannot cache the query plan, so every call re-parses and re-plans.

**Solution:** Pass a JSON array and use `json_each(json(?))` to produce a stable, cacheable query shape.

```ts
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

## Pattern 2: Filter in SQL, Not in JavaScript

**Problem:** Fetching all rows and filtering by a condition in application code is O(n) memory allocation plus a full-table read. SQLite's query planner can use indexes; JavaScript cannot.

```ts
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

## Pattern 3: Add Indexes at Schema Definition Time

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

See the `add-vault-table` skill for how this fits into the full schema migration workflow.

## Pattern 4: Pre-Compile Prepared Statements and Regex at Module Scope

**Problem:** `db.prepare(sql)` inside a function body re-compiles the statement on every call. A regex literal inside a function body is reconstructed on every call.

```ts
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

## Pattern 5: Combined `listWithCount` — Never Two Round-Trips for Pagination

When a list endpoint needs both a page of rows and a total count, issue both queries in the same function call (not two separate exported functions called sequentially).

```ts
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

## Quick Reference

| Situation | Pattern |
|---|---|
| `WHERE id IN (dynamic list)` | `json_each(json(?))` |
| JavaScript `.filter()` on DB results | Push condition into SQL |
| New table creation | Add `(agent_id, status)` index immediately |
| Pagination endpoint | `listWithCount` combined query |
| `db.prepare()` inside function | Move to module scope |
| `/regex/` inside function | Move to module scope |
