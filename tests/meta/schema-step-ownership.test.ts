import { expect, it } from 'bun:test';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';

interface Exception { step: number; object: string; table: string; reason: string }
const EXCEPTIONS: readonly Exception[] = [];
interface StatementException { step: number; sql: string; reason: string }
const STATEMENT_EXCEPTIONS: readonly StatementException[] = [
  { step: 101, sql: 'ALTER TABLE spores ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
    reason: 'Each existing spore carries its revision.' },
  { step: 101, sql: `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('guard_enabled_at', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
    reason: 'The Deployment records its revision-guard dispatch boundary.' },
];
const IDENTIFIER = '(?:[a-zA-Z_][a-zA-Z_0-9]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const QUALIFIED_IDENTIFIER = `(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`;
const name = (value: string) => value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
const createTable = new RegExp(`^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})(?:\\s|\\()`, 'i');
const createIndex = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s*\\(`, 'i');
const createTrigger = new RegExp(`^CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+(?:INSERT|DELETE|UPDATE(?:\\s+OF\\s+${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*)?)\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s`, 'i');

function withoutLeadingComments(sql: string): string | null {
  let rest = sql.trimStart();
  while (rest.startsWith('--') || rest.startsWith('/*')) {
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      rest = end === -1 ? '' : rest.slice(end + 1).trimStart();
    } else {
      const end = rest.indexOf('*/', 2);
      if (end === -1) return null;
      rest = rest.slice(end + 2).trimStart();
    }
  }
  return rest;
}

function ownershipViolations(steps: readonly SchemaStep[], exceptions = EXCEPTIONS, statementExceptions = STATEMENT_EXCEPTIONS): string[] {
  const errors: string[] = [];
  for (const exception of exceptions) {
    if (!exception.reason.trim()) errors.push(`step ${exception.step}: ${exception.object} requires an exception reason`);
  }
  for (const exception of statementExceptions) {
    if (!exception.reason.trim()) errors.push(`step ${exception.step}: statement requires an exception reason`);
  }
  const createdBefore = new Set<string>();
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    const statements = step.statements.map(sql => withoutLeadingComments(sql));
    const declared = statements.flatMap(sql => {
      const match = sql === null ? null : createTable.exec(sql);
      return match ? [name(match[1]!)] : [];
    });
    const tables = new Set(declared.filter(table => !createdBefore.has(table)));
    for (const table of declared) createdBefore.add(table);
    if (step.version < 100) continue;
    const check = (object: string, table: string) => {
      if (!tables.has(table) && !exceptions.some(exception => exception.step === step.version &&
        exception.object === object && exception.table === table && exception.reason.trim())) {
        errors.push(`step ${step.version}: ${object} targets existing table ${table}`);
      }
    };
    for (const [index, sql] of statements.entries()) {
      if (sql === `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${step.version}')`) continue;
      if (statementExceptions.some(exception => exception.step === step.version && exception.sql === step.statements[index] && exception.reason.trim())) continue;
      if (sql === null || (!createTable.test(sql) && !/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b/i.test(sql))) {
        errors.push(`step ${step.version}: unclassifiable statement: ${sql}`);
        continue;
      }
      if (/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b/i.test(sql)) {
        const match = createIndex.exec(sql) ?? createTrigger.exec(sql);
        if (!match) errors.push(`step ${step.version}: unrecognized index or trigger: ${sql}`);
        else check(name(match[1]!), name(match[2]!.split('.').at(-1)!.trim()));
      }
      if (/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql) && /\bUSING\s+fts5\s*\(/i.test(sql)) {
        const table = createTable.exec(sql);
        const content = /\bcontent\s*=\s*(['"])(.*?)\1/i.exec(sql);
        if (/\bcontent\s*=/i.test(sql) && !content) errors.push(`step ${step.version}: unrecognized FTS content: ${sql}`);
        else if (content?.[2]) check(name(table![1]!), name(content[2]));
      }
    }
  }
  return errors;
}

it('schema steps from 100 index, trigger and search only tables they create', () => {
  expect(ownershipViolations(SCHEMA_STEPS)).toEqual([]);
});

it('ownership classifies every later statement after leading comments and rejects unresolved targets', () => {
  const index = 'CREATE INDEX idx_probe ON sessions (session_id)';
  for (const prefix of ['', '-- x\n', '/* x */', '\n -- x\n /* y */ -- z\n']) {
    expect(ownershipViolations([{ version: 101, statements: [prefix + index] }])).toHaveLength(1);
    expect(ownershipViolations([{ version: 101, statements: [prefix + 'CREATE TABLE new_rows(id INTEGER)',
      prefix + 'CREATE INDEX idx_new ON new_rows(id)'] }])).toEqual([]);
  }
  for (const sql of ['CREATE /* x */ INDEX idx_probe ON sessions(session_id)',
    'CREATE INDEX idx_probe ON main.sessions(session_id)', '/* unterminated', '-- comment only',
    'SELECT 1', 'CREATE INDEX idx_probe ON']) {
    expect(ownershipViolations([{ version: 101, statements: [sql] }])).toHaveLength(1);
  }
});

it('ownership rejects index, trigger and FTS bypasses in later schema steps', () => {
  const create = 'CREATE TABLE IF NOT EXISTS new_rows (id INTEGER PRIMARY KEY)';
  const bypasses = [
    'CREATE INDEX IF NOT EXISTS idx_sessions_m1_probe ON sessions (project_id, ended_at, session_id)',
    'CREATE TRIGGER IF NOT EXISTS old_rows_ai AFTER INSERT ON sessions BEGIN SELECT 1; END',
    "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='sessions')",
  ];
  for (const sql of bypasses) expect(ownershipViolations([{ version: 101, statements: [create, sql] }])).toHaveLength(1);
  expect(ownershipViolations([
    { version: 99, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)'] },
    { version: 101, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)', bypasses[0]!] },
  ])).toHaveLength(1);
  expect(ownershipViolations([{ version: 101, statements: [create,
    'CREATE INDEX IF NOT EXISTS idx_new_rows ON new_rows (id)',
    'CREATE TRIGGER IF NOT EXISTS new_rows_ai AFTER INSERT ON new_rows BEGIN SELECT 1; END',
    "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='new_rows')",
  ] }])).toEqual([]);
});

it('existing-table exceptions name their step, object, table and reason', () => {
  const step = { version: 101, statements: ['CREATE INDEX IF NOT EXISTS idx_old ON sessions (session_id)'] };
  const exception = { step: 101, object: 'idx_old', table: 'sessions', reason: 'Explicitly admitted existing-table maintenance.' };
  expect(ownershipViolations([step], [exception])).toEqual([]);
  expect(ownershipViolations([step], [{ ...exception, reason: '' }])).toHaveLength(2);
  expect(ownershipViolations([{ ...step, version: 102 }], [exception])).toHaveLength(1);
});

it('maintenance statement exceptions pin the step, exact SQL and reason', () => {
  for (const exception of STATEMENT_EXCEPTIONS) {
    const step = { version: exception.step, statements: [exception.sql] };
    expect(ownershipViolations([step], [], [exception])).toEqual([]);
    expect(ownershipViolations([{ ...step, version: 102 }], [], [exception])).toHaveLength(1);
    for (const sql of [exception.sql + ' ', ' ' + exception.sql, '-- x\n' + exception.sql, '/* x */' + exception.sql]) {
      expect(ownershipViolations([{ ...step, statements: [sql] }], [], [exception])).toHaveLength(1);
    }
    expect(ownershipViolations([step], [], [{ ...exception, reason: '' }])).toHaveLength(2);
  }
});
