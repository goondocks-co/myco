import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { expect } from 'bun:test';
import legacy from '../fixtures/view-read-legacy.json';
import { sqliteEnv } from './fixtures.js';

/** Every page statement seeks data identities; JSON lists drive their data-table joins. */
export async function assertExtractionPlans(db: RelationalStore, queries: { sql: string; binds: unknown[] }[], target: string) {
  for (const { sql, binds } of queries) {
    const details = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map(row => row.detail);
    const plan = details.join('\n');
    for (const detail of details) {
      if (/\bSCAN \w+/i.test(detail)) expect(detail).toMatch(/\bSCAN \w+ VIRTUAL TABLE/i);
      expect(detail).not.toMatch(/\bSEARCH (?:p|prompt_batches)\b.*\(project_id=\?\)$/);
    }
    const bodies = sql.includes('p.text AS text');
    if (bodies) {
      const prompt = details.findIndex(detail => /SEARCH p\b/.test(detail));
      const list = details.findIndex(detail => /SCAN j VIRTUAL TABLE/.test(detail));
      expect(list).toBeGreaterThanOrEqual(0);
      expect(prompt).toBeGreaterThan(list);
      expect(details[prompt]).toMatch(/\(project_id=\? AND prompt_id=\?\)/);
      const sorts = details.filter(detail => /TEMP B-TREE/i.test(detail));
      expect(sorts.length).toBeLessThanOrEqual(1);
      for (const sort of sorts) expect(sort).toMatch(/^USE TEMP B-TREE FOR (?:(?:LAST TERM|RIGHT PART) OF )?ORDER BY$/);
    } else expect(plan).not.toMatch(/TEMP B-TREE/i);
    if (sql.includes('INDEXED BY idx_prompt_batches_turns')) expect(plan).toContain('idx_prompt_batches_turns');
    if (sql.includes('ended_at IS NOT NULL') && (sql.includes('(ended_at, session_id) <') || sql.includes('session_id <'))) expect(plan.replaceAll(' ', '')).toContain('(ended_at,session_id)<(?,?)');
    if (sql.includes('ended_at IS NULL') && sql.includes('session_id <')) expect(plan).toMatch(/ended_at=\? AND session_id<\?/);
    console.info('EXTRACTION_ACCESS_PLAN', { target, plan });
  }
}

/** Prepared extraction SQL may use the flag only through its owner or historical data carriers. */
export function assertExtractionSql(sql: string): void {
  if (sql.replace(/^\/\*vs:[A-Za-z0-9_:]+\*\//, '') === legacy.extraction.acknowledged) return;
  let remaining = sql;
  for (const alias of new Set([...sql.matchAll(/\b(\w+)\.processed\b/g)].map(match => match[1]!))) {
    for (const { sql: predicate } of legacy.extraction.unread) {
      remaining = remaining.split(predicate.replaceAll('__ROW__', alias)).join('');
    }
  }
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
