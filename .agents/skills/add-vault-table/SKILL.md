---
name: myco:add-vault-table
description: Full pattern for adding a new feature table to the Myco vault — migration with correct error handling, query module, constants, FTS5 index, MCP tool surface, and table exclusion tracking.
managed_by: myco
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

# Add a New Table to the Myco Vault Schema

## Prerequisites

- Existing migration files in `src/db/migrations/` to reference for numbering and pattern
- Schema version constant in `src/config/constants.ts` (increment by 1)
- Understanding of whether the new table needs FTS5 keyword search

## Steps

### 1. Write the Migration File

Create `src/db/migrations/v<N>_<table-name>.ts`. Migration files must:

1. **Create the table** in a `try/catch` that only swallows "no such table" errors
2. **Re-throw unexpected errors** — silent swallowing leaves the DB partially migrated with no indication
3. **Check exclusion status** — some tables have special ALTER TABLE exclusion requirements

**Correct migration catch pattern:**

```typescript
export async function migrate(db: Database): Promise<void> {
  // Create the new table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS my_new_table (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  } catch (err: any) {
    // Only swallow "no such table" — expected on fresh installs
    // Re-throw everything else: constraint violations, syntax errors, etc.
    if (!err.message?.includes('no such table')) throw err;
  }

  // Add indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_my_new_table_agent
    ON my_new_table(agent_id)
  `);
}
```

> **Critical:** Do NOT write a bare `catch (err) { /* ignore */ }`. The v7 migration made this mistake — it silently swallowed all errors, leaving the DB in a partially-migrated state with no diagnostic output. Only catch errors you explicitly expect.

**Why "no such table" appears:** On a fresh install with no prior vault, `ALTER TABLE` or `DROP TABLE` statements in migrations may reference tables that don't exist yet. That specific error is safe to swallow. All other errors indicate real problems.

### 2. Check Table Exclusion Status

Before writing any `ALTER TABLE` statements that touch existing tables, check whether those existing tables have special exclusion status.

**Currently excluded tables** (must never be targeted by `ALTER TABLE` in new migrations):
- `entity_mentions` — excluded from schema-wide ALTER operations
- `team_outbox` — same exclusion pattern

When you add a new table, decide upfront: **does this table need exclusion treatment?** If the table:
- Is managed by a sync process that may not be present on all machines, OR
- Has schema that diverges between local and remote installations

...then document it in the exclusion list comment in `src/db/migrations/` and apply the same exclusion pattern as `entity_mentions`.

**Pattern to detect exclusion need:**

```typescript
// At the top of migration files that do schema-wide ALTER TABLE:
const EXCLUDED_TABLES = ['entity_mentions', 'team_outbox'];

for (const tableName of allTables) {
  if (EXCLUDED_TABLES.includes(tableName)) continue;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ...`);
}
```

### 3. Register the Migration

In `src/db/index.ts` (or wherever migrations are registered), add the new migration in version order:

```typescript
import { migrate as v7 } from './migrations/v7_my_new_table';

const MIGRATIONS = [
  // ... existing
  { version: 7, run: v7 },
];
```

Bump `SCHEMA_VERSION` in `src/config/constants.ts` to match.

### 4. Write the Query Module

Create `src/db/<table-name>.ts`. Follow the existing module pattern:

```typescript
import type { Database } from 'better-sqlite3';

export interface MyNewRecord {
  id: string;
  agent_id: string;
  content: string;
  created_at: number;
}

export function insertMyNewRecord(
  db: Database,
  record: Omit<MyNewRecord, 'id'>
): MyNewRecord {
  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO my_new_table (id, agent_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, record.agent_id, record.content, record.created_at);
  return { id, ...record };
}

export function listMyNewRecords(
  db: Database,
  agentId: string
): MyNewRecord[] {
  return db
    .prepare(`SELECT * FROM my_new_table WHERE agent_id = ? ORDER BY created_at DESC`)
    .all(agentId) as MyNewRecord[];
}
```

### 5. Add FTS5 Index (If Keyword-Searchable)

If the table's content should appear in `vault_search_fts` results, add an FTS5 virtual table to the migration:

```typescript
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS my_new_table_fts
  USING fts5(
    id UNINDEXED,
    content,
    content='my_new_table',
    content_rowid='rowid'
  )
`);

// Triggers to keep FTS in sync
db.exec(`
  CREATE TRIGGER IF NOT EXISTS my_new_table_ai
  AFTER INSERT ON my_new_table BEGIN
    INSERT INTO my_new_table_fts(rowid, id, content)
    VALUES (new.rowid, new.id, new.content);
  END
`);
```

Register the FTS table in `src/db/search.ts` so `vault_search_fts` includes it.

### 6. Add Constants

In `src/config/constants.ts`, add:

```typescript
export const MY_NEW_TABLE = 'my_new_table' as const;
export const MY_NEW_TABLE_FTS = 'my_new_table_fts' as const;
```

Never inline table name strings in queries — always reference constants so renames are safe.

### 7. Write the MCP Tool

Create `src/mcp/tools/my-new-table.ts`:

```typescript
import { z } from 'zod';
import type { McpTool } from '../types';

export const myNewTableTool: McpTool = {
  name: 'vault_my_new_table',
  description: 'List or create records in my_new_table.',
  inputSchema: z.object({
    action: z.enum(['list', 'create']),
    content: z.string().optional(),
  }),
  handler: async ({ action, content }, { db, agentId }) => {
    if (action === 'list') {
      const records = listMyNewRecords(db, agentId);
      return { content: [{ type: 'text', text: JSON.stringify(records) }] };
    }
    // ... create path
  },
};
```

**MCP response format is non-negotiable:** always return `{ content: [{ type: 'text', text: string }] }`. Returning raw objects causes silent failures in the MCP layer.

### 8. Register the Tool in server.ts

In `src/mcp/server.ts`, add the tool to the tool registry in two places:

1. **Import** the tool handler
2. **Register** it in the `tools` array passed to the MCP server constructor

Both steps are required. Missing either causes the tool to be invisible to agents even though no error is thrown.

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Silent catch in migration | DB partially migrated, no error, wrong behavior later | Catch only `'no such table'`, re-throw everything else |
| Forgetting exclusion check | New migration breaks excluded tables | Check EXCLUDED_TABLES list before any schema-wide ALTER |
| Inlined table name strings | Rename breaks queries in non-obvious places | Use constants from `src/config/constants.ts` |
| Missing FTS triggers | Records inserted but never appear in search | Add AFTER INSERT / AFTER UPDATE / AFTER DELETE triggers |
| Tool registered in tools array only | Tool works in testing but invisible to agent | Must also import and register in server.ts constructor |
| Raw object returned from MCP handler | Silent failure — agent receives no content | Always wrap in `{ content: [{ type: 'text', text: ... }] }` |
| SCHEMA_VERSION not bumped | Migration runs but version check fails or skips | Always increment `SCHEMA_VERSION` constant to match migration number |
