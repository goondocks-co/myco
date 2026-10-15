import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { PROJECT_ID } from './harness.ts';

export function schemaObjects(db: Database): Array<{ type: string; name: string; sql: string }> {
  return db.query(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'd1_migrations' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string }>;
}

const sqlIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export class UpgradeStateMismatchError extends Error {}

export function expectedSchema(files: ReturnType<typeof renderMigrationFiles>): ReturnType<typeof schemaObjects> {
  const db = new Database(':memory:');
  try {
    for (const file of files) db.exec(file.sql);
    return schemaObjects(db);
  } finally { db.close(); }
}

export function tableRows(db: Database, tables: string[]): Record<string, string> {
  return Object.fromEntries(tables.map((table) => {
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return [table, '<absent>'];
    const rows = db.query(`SELECT * FROM ${sqlIdentifier(table)}`).all().map((row) => JSON.stringify(row)).sort();
    return [table, JSON.stringify(rows)];
  }));
}

export function assertUpgradeState(databaseFile: string, version: number, expected: ReturnType<typeof schemaObjects>, expectedRows: Record<string, string>): void {
  const db = new Database(databaseFile);
  try {
    const actualVersion = Number((db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value);
    if (actualVersion !== version) throw new UpgradeStateMismatchError(`D1 upgrade fixture expected schema ${version}, got ${actualVersion}`);
    const applied = Number((db.query('SELECT COUNT(*) AS count FROM d1_migrations').get() as { count: number }).count);
    if (applied !== version) throw new UpgradeStateMismatchError(`D1 upgrade fixture expected ${version} applied Wrangler migrations, got ${applied}`);
    const actual = schemaObjects(db);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const first = actual.findIndex((item, index) => JSON.stringify(item) !== JSON.stringify(expected[index]));
      throw new UpgradeStateMismatchError(`D1 upgrade fixture schema objects differ at version ${version}: ${JSON.stringify({ actual: actual[first], expected: expected[first], actualCount: actual.length, expectedCount: expected.length })}`);
    }
    const foreignKeys = db.query('PRAGMA foreign_key_check').all();
    if (foreignKeys.length !== 0) throw new UpgradeStateMismatchError(`D1 upgrade fixture has FK violations: ${JSON.stringify(foreignKeys)}`);
    for (const [table, rows] of Object.entries(expectedRows)) {
      const actualRows = tableRows(db, [table])[table];
      if (actualRows !== rows) throw new UpgradeStateMismatchError(`D1 upgrade fixture rows differ in ${table}: ${JSON.stringify({ actual: actualRows, expected: rows })}`);
    }
    // D1 refuses integrity_check; the closed local D1 file permits the full SQLite check.
    const integrity = db.query('PRAGMA integrity_check').all();
    if (JSON.stringify(integrity) !== JSON.stringify([{ integrity_check: 'ok' }])) throw new UpgradeStateMismatchError(`D1 upgrade fixture failed integrity_check: ${JSON.stringify(integrity)}`);
  } finally { db.close(); }
}

export async function probeForeignKeyAssertion(databaseFile: string, query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<void> {
  const db = new Database(databaseFile);
  try {
    db.exec(`PRAGMA foreign_keys = OFF; INSERT INTO agent_run_events (project_id, run_id, event_type, recorded_at) VALUES ('proj_parity', 'missing_upgrade_run', 'orphan', 1)`);
  } finally { db.close(); }
  try {
    if ((await query('PRAGMA foreign_key_check')).length === 0) throw new Error('FK orphan mutation escaped workerd foreign_key_check');
  } finally {
    const cleanup = new Database(databaseFile);
    try { cleanup.exec("DELETE FROM agent_run_events WHERE run_id = 'missing_upgrade_run'"); }
    finally { cleanup.close(); }
  }
}

export function localD1File(persistDir: string): string {
  const dir = path.join(persistDir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`Cloudflare parity target has ${files.length} local D1 database files`);
  return path.join(dir, files[0]!);
}

function sqlIdentifiers(statement: string): string[] {
  const tokens = statement.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])*\]|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return tokens.flatMap((token) => {
    if (token.startsWith('--') || token.startsWith('/*') || token.startsWith("'")) return [];
    if (token.startsWith('"')) return [token.slice(1, -1).replaceAll('""', '"')];
    if (token.startsWith('`')) return [token.slice(1, -1).replaceAll('``', '`')];
    if (token.startsWith('[')) return [token.slice(1, -1).replaceAll(']]', ']')];
    return [token];
  });
}

export function referencedExistingTables(db: Database, statements: readonly string[]): string[] {
  const objects = db.query("SELECT name, tbl_name, type FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')").all() as Array<{ name: string; tbl_name: string; type: string }>;
  const tableNames = new Set(objects.filter((item) => item.type === 'table').map((item) => item.name.toLowerCase()));
  const owners = new Map(objects.map((item) => [item.name.toLowerCase(), item.tbl_name]));
  const tables = new Set<string>();
  for (const statement of statements) {
    const resolved = sqlIdentifiers(statement).map((name) => owners.get(name.toLowerCase()))
      .filter((owner): owner is string => owner !== undefined && tableNames.has(owner.toLowerCase())
        && owner !== 'schema_meta' && owner !== 'd1_migrations' && !owner.startsWith('_cf_'));
    if (resolved.length === 0 && /^\s*(?:DROP\s+(?:INDEX|TRIGGER)|ALTER\s+TABLE|UPDATE|DELETE\s+FROM)/i.test(statement)) {
      throw new Error(`unsupported D1 upgrade fixture: no previous object resolves for ${statement.slice(0, 100)}`);
    }
    for (const owner of resolved) tables.add(owner);
  }
  return [...tables];
}

export function isLocalMigrationSqlFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !/^wrangler d1 migrations apply exited [1-9]\d*:/m.test(error.message)) return false;
  return /\b(?:SQLITE_ERROR|SQLITE_CONSTRAINT|no such (?:table|column|index)|FOREIGN KEY constraint failed|CHECK constraint failed|syntax error)\b/i.test(error.message);
}

export async function assertMigrationMutationDetected(apply: () => Promise<void>, verify: () => void): Promise<void> {
  let migrationError: unknown;
  try { await apply(); }
  catch (error) {
    if (!isLocalMigrationSqlFailure(error)) throw error;
    migrationError = error;
  }
  try { verify(); }
  catch (error) {
    if (error instanceof UpgradeStateMismatchError) return;
    throw error;
  }
  if (migrationError !== undefined) throw migrationError;
  throw new Error('dropped latest migration statement escaped the D1 upgrade gate');
}

export function seedReferencedTables(db: Database, statements: readonly string[]): string[] {
  const seedTable = (table: string, visiting: Set<string>): void => {
    if (table.includes('\0')) throw new Error(`unsupported D1 upgrade fixture table ${table}`);
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return;
    if ((db.query(`SELECT COUNT(*) AS count FROM ${sqlIdentifier(table)}`).get() as { count: number }).count > 0) return;
    if (visiting.has(table)) throw new Error(`unsupported D1 upgrade fixture FK cycle at ${table}`);
    visiting.add(table);
    const columns = db.query(`PRAGMA table_info(${sqlIdentifier(table)})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    const fks = db.query(`PRAGMA foreign_key_list(${sqlIdentifier(table)})`).all() as Array<{ table: string; from: string; to: string }>;
    const values = new Map<string, string | number>();
    for (const fk of fks) {
      seedTable(fk.table, visiting);
      const parent = db.query(`SELECT * FROM ${sqlIdentifier(fk.table)} LIMIT 1`).get() as Record<string, string | number> | null;
      if (parent === null) throw new Error(`unsupported D1 upgrade fixture missing FK parent ${fk.table}`);
      const parentKey = fk.to || (db.query(`PRAGMA table_info(${sqlIdentifier(fk.table)})`).all() as Array<{ name: string; pk: number }>).find((column) => column.pk > 0)?.name;
      if (parentKey === undefined || parent[parentKey] === undefined) throw new Error(`unsupported D1 upgrade fixture FK ${table}.${fk.from}`);
      values.set(fk.from, parent[parentKey]);
    }
    for (const column of columns.filter((item) => (item.notnull || item.pk) && item.dflt_value === null)) {
      if (values.has(column.name) || (column.pk && /INT/i.test(column.type))) continue;
      const name = column.name;
      const value = name === 'project_id' ? PROJECT_ID : name === 'agent_id' ? 'upgrade_agent'
        : name === 'session_id' ? 'upgrade_session' : name === 'run_id' ? 'upgrade_run'
          : name === 'status' ? 'completed' : name === 'role' ? 'member'
            : name === 'state' ? 'draft' : name === 'confidence' ? 'high'
              : name === 'source' ? 'built-in' : /(?:hash|digest)$/.test(name) ? 'a'.repeat(64)
                : /INT|REAL|NUMERIC/i.test(column.type) ? 1 : `upgrade_${table}`;
      values.set(name, value);
    }
    const names = [...values.keys()];
    try {
      db.query(`INSERT INTO ${sqlIdentifier(table)} (${names.map(sqlIdentifier).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...[...values.values()]);
    } catch (error) { throw new Error(`unsupported D1 upgrade fixture cannot seed ${table}: ${String(error)}`); }
    visiting.delete(table);
  };
  const touched = referencedExistingTables(db, statements);
  for (const table of touched) seedTable(table, new Set());
  const candidateChildren = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`).all() as Array<{ name: string }>;
  const visited = new Set<string>();
  const queue = [...touched];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const { name } of candidateChildren) {
      const parents = db.query(`PRAGMA foreign_key_list(${sqlIdentifier(name)})`).all() as Array<{ table: string }>;
      if (!parents.some((fk) => fk.table === parent)) continue;
      seedTable(name, new Set());
      queue.push(name);
    }
  }
  return [...visited];
}

export function seedPreviousSchema(databaseFile: string, statements: readonly string[]): string[] {
  const db = new Database(databaseFile);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_parity', 'upgrade project', 1);
      INSERT INTO sessions (project_id, session_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_parity', 'upgrade_session', 'upgrade_token', 1, 1);
      INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, producer_adapter) VALUES ('proj_parity', 'upgrade_event', 'upgrade_session', 'upgrade_token', 'prompt', 'import', '{}', 'upgrade_hash', 1, 1, 'claude');
      INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('upgrade_agent', 'upgrade', 'built-in', 1, 1);
      INSERT INTO agent_runs (project_id, id, agent_id, status, started_at) VALUES ('proj_parity', 'upgrade_run', 'upgrade_agent', 'completed', 1);
      INSERT INTO agent_run_events (project_id, run_id, event_type, recorded_at) VALUES ('proj_parity', 'upgrade_run', 'upgrade_child', 1);`);
    return [...new Set(['projects', 'sessions', 'events', 'agents', 'agent_runs', 'agent_run_events', ...seedReferencedTables(db, statements)])];
  } finally { db.close(); }
}

