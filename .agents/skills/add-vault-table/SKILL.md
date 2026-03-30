---
name: myco:add-vault-table
description: >
  Use this skill when adding a new feature table to the Myco vault SQLite
  database. Activates whenever you need to persist a new data type —
  skill candidates, custom entities, new event types, etc. — and wire it
  up with MCP tools. Apply this skill even if the user doesn't explicitly
  mention schema migration, MCP tools, or the db module — any time a new
  table is needed, this full pattern applies: schema migration, query
  module, constants, FTS5 index (if keyword-searchable), and tool surface.
managed_by: myco
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - MultiEdit
---

# Add a New Table to the Myco Vault Schema

## Prerequisites

- You know the table name (snake_case) and the columns it needs
- You know whether rows in this table need **keyword searchability** (FTS5)
  — if users or agents will search this table by text content, the answer
  is yes
- Existing schema is in `src/db/migrations/` — find the highest-numbered
  file to understand current schema version

## Steps

### Step 1 — Write the migration file

Create `src/db/migrations/<N+1>_add_<table_name>.ts` where `N` is the
current highest migration number.

```typescript
import { Database } from 'better-sqlite3';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS <table_name> (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      -- ... your columns ...
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_<table_name>_agent_id
      ON <table_name>(agent_id);
  `);
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS <table_name>;`);
}
```

**Key rules:**
- Always include `agent_id` — the vault is multi-agent
- Always include `created_at` / `updated_at` as INTEGER (Unix ms)
- Add targeted indexes for every column used in `WHERE` or `ORDER BY`
- Use `CREATE INDEX IF NOT EXISTS` — migrations must be idempotent

### Step 2 — Add FTS5 index (if the table is keyword-searchable)

If rows in this table will be searched by text content, add the FTS5
virtual table **in the same migration file as `CREATE TABLE`**. This is
the schema v6 dual-coverage pattern: exact keyword search (FTS5) plus
semantic similarity (embeddings) in tandem.

```typescript
// Inside the same up() function, after CREATE TABLE:
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS <table_name>_fts
    USING fts5(
      content='<table_name>',
      content_rowid='rowid',
      <col1>, <col2>   -- text columns to index
    );

  -- Backfill existing rows (safe to run even if table is empty)
  INSERT INTO <table_name>_fts(<table_name>_fts) VALUES('rebuild');
`);
```

Add the corresponding `down()` cleanup:

```typescript
db.exec(`
  DROP TABLE IF EXISTS <table_name>_fts;
  DROP TABLE IF EXISTS <table_name>;
`);
```

**Why same commit:** deferring FTS creation risks the table being deployed
without search support, requiring a second migration later. There is no
read-latency cost — FTS5 indexes are updated on write, not on read.

**Naming convention:** `<table_name>_fts` — matches the pattern of
`spores_fts`, `sessions_fts`, `prompt_batches_fts` from schema v6.

### Step 3 — Create the query module

Create `src/db/<table_name>.ts`. This file owns all SQL for the table.

```typescript
import type { Database } from 'better-sqlite3';
import type { <TableRow> } from '../types.js';

export function insert<TableName>(db: Database, row: <TableRow>): void {
  db.prepare(`
    INSERT INTO <table_name> (id, agent_id, ..., created_at, updated_at)
    VALUES (@id, @agent_id, ..., @created_at, @updated_at)
  `).run(row);
}

export function list<TableName>(
  db: Database,
  agentId: string,
  opts: { limit?: number } = {}
): <TableRow>[] {
  return db.prepare(`
    SELECT * FROM <table_name>
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agentId, opts.limit ?? 100) as <TableRow>[];
}

export function get<TableName>(
  db: Database,
  id: string
): <TableRow> | undefined {
  return db.prepare(
    `SELECT * FROM <table_name> WHERE id = ?`
  ).get(id) as <TableRow> | undefined;
}
```

**Query patterns to follow** (from the vault's accumulated wisdom):
- Combine list + count in a single query using `COUNT(*) OVER()` when
  you need pagination metadata — avoids a second round-trip
- Use composite indexes for multi-column WHERE clauses (e.g.,
  `(agent_id, status)`) — SQLite will use only one index per scan
- Write mutations as atomic SQL where possible (INSERT OR REPLACE,
  UPDATE ... WHERE) rather than read-then-write in application code

### Step 4 — Update constants

Add the new table name and any enum values to `src/config/constants.ts`:

```typescript
export const TABLE_<TABLE_NAME> = '<table_name>' as const;
// If the table has status/type enums:
export const <TABLE_NAME>_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const;
```

This prevents magic strings scattered across the codebase.

### Step 5 — Wire MCP tools

Create `src/mcp/tools/<table_name>-tools.ts`. Define the tool shape:

```typescript
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { list<TableName>, insert<TableName> } from '../../db/<table_name>.js';

export const <tableName>Tools = (db: Database) => ({
  vault_list_<table_name>: {
    description: '...',
    inputSchema: z.object({
      agent_id: z.string().optional(),
      limit: z.number().optional(),
    }),
    handler: async (input: ...) => { ... },
  },
  // ... additional CRUD tools as needed
});
```

### Step 6 — Register in server.ts

Open `src/mcp/server.ts` and:

1. Import your new tools: `import { <tableName>Tools } from './tools/<table_name>-tools.js';`
2. Merge into the tool map: `...(<tableName>Tools(db))`
3. Update `VAULT_TOOL_COUNT` to reflect the new total

## Common Pitfalls

- **Missing agent_id scoping** — Every query that reads rows should filter
  by `agent_id`. Without this, one agent sees another's data.

- **Deferring FTS5 to a follow-up migration** — This splits the feature
  across two PRs/deploys and is easy to forget. Add it in the same
  migration. If you're unsure whether FTS is needed, err on the side of
  including it — no performance cost, and removing it later is harder.

- **Enum values in code vs. DB** — If you define status enums as
  TypeScript constants, make sure the string values exactly match what
  gets persisted. A mismatch (e.g., `'in_progress'` vs `'inProgress'`)
  causes silent query failures where rows exist but are never returned.

- **Magic strings in queries** — Use the constants from Step 4. SQL that
  hard-codes `'active'` in five places will eventually drift.

- **Forgetting `VAULT_TOOL_COUNT`** — If the count is wrong, the MCP
  server may fail startup validation or emit confusing warnings.
