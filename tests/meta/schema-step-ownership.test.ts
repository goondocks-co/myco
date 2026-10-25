import { expect, it } from 'bun:test';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';

interface Exception { step: number; object: string; table: string; reason: string }
const EXCEPTIONS: readonly Exception[] = [
  {step:103,object:'agent_attempt_settled_insert',table:'agent_run_attempts',reason:'New known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settled_update',table:'agent_run_attempts',reason:'Newly known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settlement_fixed',table:'agent_run_attempts',reason:'Settlement order remains stable for incremental estimate seeks.'},
  {step:103,object:'agent_attempt_cost_fixed',table:'agent_run_attempts',reason:'Settled attempt prices and known sources are immutable.'},
  {step:103,object:'agent_attempt_machine_fixed',table:'agent_run_attempts',reason:'Known attempt claim machine attribution is immutable.'},
  {step:103,object:'agent_runs_origin_insert',table:'agent_runs',reason:'Omitted dispatch origins must be classified before queue-head admission.'},
  {step:103,object:'agent_runs_origin_fixed',table:'agent_runs',reason:'Persisted dispatch origin is immutable.'},
  {step:103,object:'agent_attempt_claim_fixed',table:'agent_run_attempts',reason:'Claim time, estimate and profile are immutable attempt evidence.'},
];
const IDENTIFIER = '(?:[a-zA-Z_][a-zA-Z_0-9]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const name = (value: string) => value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
const createTable = new RegExp(`^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})(?:\\s|\\()`, 'i');
const createObject = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?(?:INDEX|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+[\\s\\S]*?\\bON\\s+(${IDENTIFIER})(?:\\s|\\()`, 'i');

function ownershipViolations(steps: readonly SchemaStep[], exceptions = EXCEPTIONS): string[] {
  const errors: string[] = [];
  for (const exception of exceptions) {
    if (!exception.reason.trim()) errors.push(`step ${exception.step}: ${exception.object} requires an exception reason`);
  }
  const createdBefore = new Set<string>();
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    const statements = step.statements.map(sql => sql.trim());
    const declared = statements.flatMap(sql => {
      const match = createTable.exec(sql);
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
    for (const sql of statements) {
      if (/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b/i.test(sql)) {
        const match = createObject.exec(sql);
        if (!match) errors.push(`step ${step.version}: unrecognized index or trigger: ${sql}`);
        else check(name(match[1]!), name(match[2]!));
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
