import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteEnv } from './fixtures.js';

/** Prepared extraction SQL may use the flag only through its owner or historical data carriers. */
export function assertExtractionSql(sql: string): void {
  let remaining = sql;
  if (remaining.startsWith('WITH admission')) remaining = remaining
    .replace(/'\$\.processed', "processed"/g, '')
    .replace(/6 \* COALESCE\(octet_length\("processed"\), 0\)/g, '');
  remaining = remaining.replace(/'(?:[^']|'')*'/g, '');
  const historicalDdl = [
    'ALTER TABLE prompt_batches ADD COLUMN processed INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS idx_prompt_batches_unprocessed ON prompt_batches (project_id, processed, created_at, prompt_id)',
  ];
  if (historicalDdl.includes(remaining)) return;
  remaining = remaining.replace(/UPDATE OF project_id,session_id,processed,origin(?:,prompt_id)? ON prompt_batches/g, '');
  remaining = remaining.replace(/INSERT(?: OR IGNORE)? INTO prompt_batches\s*\([^)]*\)/g, header => header.replace(/\bprocessed\b/g, ''));
  const flag = remaining.search(/\bprocessed\b/);
  if (flag >= 0) throw new Error(`Extraction SQL bypassed its coverage owner: ${remaining.slice(Math.max(0, flag - 60), flag + 80)}`);
}

/** Every prepare is recorded and checked before the underlying store receives it. */
export function extractionSqlStore(store: RelationalStore) {
  const prepared: string[] = [];
  const queries: { sql: string; binds: unknown[] }[] = [];
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement, query: { sql: string; binds: unknown[] }): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind(...values) { query.binds = values; return wrap(statement.bind(...values), query); },
      first: <T,>() => statement.first<T>(), all: <T,>() => statement.all<T>(), run: () => statement.run(),
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const db: RelationalStore = {
    prepare(sql) {
      prepared.push(sql); assertExtractionSql(sql);
      const query = { sql, binds: [] as unknown[] };
      queries.push(query);
      return wrap(store.prepare(sql), query);
    },
    batch: statements => store.batch(statements.map(statement => {
      const original = originals.get(statement);
      if (original === undefined) throw new Error('extraction batch received a foreign statement');
      return original;
    })),
  };
  return { db, prepared, queries };
}

export function extractionSqlEnv(options?: Parameters<typeof sqliteEnv>[0]) {
  const fixture = sqliteEnv(options);
  const tracked = extractionSqlStore(fixture.db);
  fixture.db = tracked.db;
  fixture.env.MYCO_DB = tracked.db;
  return { ...fixture, prepared: tracked.prepared };
}
