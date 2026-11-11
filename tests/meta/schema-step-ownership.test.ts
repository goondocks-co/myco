import { V723 } from '@myco-server-worker/db/schema-v723.js';
import { V727 } from '@myco-server-worker/db/schema-v727.js';
import { NEXT_S6 } from '@myco-server-worker/db/schema-vNEXT-s6.js';
import { NEXT_S1C } from '@myco-server-worker/db/schema-vNEXT-s1c.js';
import { headSchemaStatements } from '@myco-server-worker/db/runners/heads.js';
import { lineageHeadSchemaStatements } from '@myco-server-worker/db/identity/lineage-heads.js';
import { storageUsageSchemaStatements } from '@myco-server-worker/db/storage/usage.js';
import { SESSION_LIFECYCLE_STEPS, V730 } from '@myco-server-worker/db/schema-v728.js';
import { NEXT_S6B } from '@myco-server-worker/db/schema-vNEXT-s6b.js';
import { authorityRetentionSchemaStatements } from '@myco-server-worker/db/identity/authority-retention.js';
import { SESSION_LIFECYCLE_EVENTS_INDEX, sessionLifecycleSchema } from '@myco-server-worker/db/documents/lifecycle.js';
import { publicationPinSchema } from '@myco-server-worker/db/documents/pin-schema.js';
import { publicationFailureSchema } from '@myco-server-worker/db/documents/failure-head.js';
import { publicationRebuildSchema } from '@myco-server-worker/db/documents/rebuild.js';
import { publicationContributionSchema } from '@myco-server-worker/db/documents/contributions.js';
import { calibrationTriggers } from '@myco-server-worker/db/embeddings/calibration.js';
import { passedOverTriggers } from '@myco-server-worker/db/embeddings/passed-over.js';
import { sourceStateTriggers } from '@myco-server-worker/db/embeddings/state.js';
import { kpiTriggers } from '@myco-server-worker/db/insights/kpi-reconcile.js';
import { planCountSchemaStatements } from '@myco-server-worker/db/plans/counts.js';
import { spendSchemaStatements, spendTriggers } from '@myco-server-worker/db/runs/admission.js';
import { workSchemaStatements, workTriggers } from '@myco-server-worker/db/runs/history-schema.js';
import { liveSchemaStatements, liveTriggers } from '@myco-server-worker/db/runs/live.js';
import { sporeCountSchemaStatements } from '@myco-server-worker/db/spores/counts.js';
import { V711 } from '@myco-server-worker/db/schema-v711.js';
import { V712 } from '@myco-server-worker/db/schema-v712.js';
import { V714 } from '@myco-server-worker/db/schema-v714.js';
import { NEXT_PLAN_CURATION } from '@myco-server-worker/db/schema-vNEXT-plan-curation.js';
import { V716 } from '@myco-server-worker/db/schema-v716.js';
import { V717 } from '@myco-server-worker/db/schema-v717.js';
import { V719 } from '@myco-server-worker/db/schema-v719.js';
import { V721 } from '@myco-server-worker/db/schema-v721.js';
import { V722 } from '@myco-server-worker/db/schema-v722.js';
import { V724 } from '@myco-server-worker/db/schema-v724.js';
import { readdirSync } from 'node:fs';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { changing, reaching, retiring, type SchemaStep } from '@myco-server-worker/db/schema-step.js';

/**
 * From step 100 a schema step indexes, triggers and searches only tables it creates. Anything else it does to a table
 * an earlier step created is declared on the step itself with `reaches`, one entry per table. A build (an index, trigger
 * or search over the table, or rebuilding one of its indexes or triggers) needs the entry's `reason`; a change (an
 * ALTER, a row write, or dropping the table) needs its `changes` too, so a reason given for a build never admits a
 * change. A drop the step declares in `retires` needs neither, and tables named with a leading underscore are a
 * migration's working state. A statement the rules cannot place fails as unclassifiable.
 */
const IDENTIFIER = '(?:[a-zA-Z_][a-zA-Z_0-9]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const QUALIFIED = `(?:${IDENTIFIER}\\s*\\.\\s*)?(${IDENTIFIER})`;
const pattern = (source: string) => new RegExp(source, 'i');
const createTable = pattern(`^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}(?:\\s|\\()`);
const createIndex = pattern(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+ON\\s+${QUALIFIED}\\s*\\(`);
const createTrigger = pattern(
  `^CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+(?:INSERT|DELETE|UPDATE(?:\\s+OF\\s+${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*)?)\\s+ON\\s+${QUALIFIED}\\s`,
);
const alterTable = pattern(`^ALTER\\s+TABLE\\s+${QUALIFIED}(?:\\s+RENAME\\s+TO\\s+(${IDENTIFIER}))?`);
const writeRows = pattern(
  `^(?:WITH\\b[\\s\\S]*?\\)\\s*)?(?:(?:INSERT|REPLACE)(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${QUALIFIED}`,
);
const dropTable = pattern(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`);
const dropObject = pattern(`^DROP\\s+(INDEX|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`);
const name = (value: string) => value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();

function withoutLeadingComments(sql: string): string | null {
  let rest = sql.trimStart();
  while (rest.startsWith('--') || rest.startsWith('/*')) {
    const line = rest.startsWith('--');
    const end = line ? rest.indexOf('\n') : rest.indexOf('*/', 2);
    if (end === -1) return line ? '' : null;
    rest = rest.slice(end + (line ? 1 : 2)).trimStart();
  }
  return rest;
}

function ownershipViolations(steps: readonly SchemaStep[]): string[] {
  const errors: string[] = [];
  const tables = new Set<string>();
  const objectTables = new Map<string, string>();
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    const checked = step.version >= 100;
    const owned = new Set<string>();
    const reached = new Set<string>();
    const changed = new Set<string>();
    const reach = (table: string, what: string, change = false) => {
      if (!checked || owned.has(table) || table.startsWith('_')) return;
      const declared = step.reaches?.find((r) => r.table === table);
      if (!declared?.reason.trim()) {
        errors.push(`step ${step.version}: ${what} reaches existing table ${table}; declare why on the step: reaches: ${change ? 'changing' : 'reaching'}(['${table}'], '<reason>')`);
        return;
      }
      reached.add(table);
      if (!change) return;
      if (declared.changes?.trim()) changed.add(table);
      else errors.push(`step ${step.version}: ${what} changes existing table ${table}, and its reach gives no reason for a change; declare it: reaches: changing(['${table}'], '<reason>')`);
    };
    const retired = (kind: 'table' | 'index' | 'trigger', object: string) => step.retires?.some((r) => r.kind === kind && r.name === object) ?? false;
    for (const original of step.statements) {
      if (original === `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${step.version}')`) continue;
      const sql = withoutLeadingComments(original);
      if (sql === null) {
        if (checked) errors.push(`step ${step.version}: unclassifiable statement: ${original}`);
        continue;
      }
      const created = createTable.exec(sql);
      if (created) {
        const table = name(created[1]!);
        if (!tables.has(table)) owned.add(table);
        tables.add(table);
        if (/\bUSING\s+fts5\s*\(/i.test(sql) && /\bcontent\s*=/i.test(sql)) {
          const content = /\bcontent\s*=\s*(['"])(.*?)\1/i.exec(sql);
          if (!content) errors.push(`step ${step.version}: unrecognized FTS content: ${sql}`);
          else if (content[2]) reach(name(content[2]), `search ${table}`);
        }
        continue;
      }
      const object = createIndex.exec(sql) ?? createTrigger.exec(sql);
      if (object) {
        objectTables.set(name(object[1]!), name(object[2]!));
        reach(name(object[2]!), name(object[1]!));
        continue;
      }
      if (/^CREATE\b/i.test(sql)) {
        if (checked) errors.push(`step ${step.version}: unrecognized create: ${sql}`);
        continue;
      }
      if (/^SELECT\b/i.test(sql)) continue;
      const altered = alterTable.exec(sql);
      const written = altered ? null : writeRows.exec(sql);
      const droppedTable = altered || written ? null : dropTable.exec(sql);
      const dropped = altered || written || droppedTable ? null : dropObject.exec(sql);
      if (altered) {
        if (altered[2]) tables.add(name(altered[2]));
        reach(name(altered[1]!), 'ALTER TABLE', true);
      } else if (written) reach(name(written[1]!), 'a row write', true);
      else if (droppedTable) {
        if (!retired('table', name(droppedTable[1]!))) reach(name(droppedTable[1]!), 'DROP TABLE', true);
      } else if (dropped) {
        const kind = dropped[1]!.toLowerCase() as 'index' | 'trigger';
        const table = objectTables.get(name(dropped[2]!));
        if (table === undefined) {
          if (checked) errors.push(`step ${step.version}: drops ${kind} ${name(dropped[2]!)}, which no earlier statement created`);
        } else if (!retired(kind, name(dropped[2]!))) reach(table, `DROP ${kind.toUpperCase()} ${name(dropped[2]!)}`);
      } else if (checked) errors.push(`step ${step.version}: unclassifiable statement: ${sql}`);
    }
    for (const declared of step.reaches ?? []) {
      if (!reached.has(declared.table)) errors.push(`step ${step.version}: declares a reach on ${declared.table} that none of its statements makes; remove it`);
      else if (declared.changes !== undefined && !changed.has(declared.table))
        errors.push(`step ${step.version}: declares a change to ${declared.table} that none of its statements makes; declare it with reaching instead`);
    }
  }
  return errors;
}

it('schema steps from 100 index, trigger and search only tables they create, and declare why they reach any other', () => {
  expect(ownershipViolations(SCHEMA_STEPS)).toEqual([]);
});

it('a new step that reaches an existing table passes by its own declaration and fails without it', () => {
  const next = SCHEMA_STEPS.at(-1)!.version + 1;
  const statements = ['CREATE INDEX IF NOT EXISTS idx_probe ON sessions (project_id, session_id)'];
  const reason = 'A probe page seeks sessions by key.';
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements, reaches: reaching(['sessions'], reason) }])).toEqual([]);
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements }])).toEqual([
    `step ${next}: idx_probe reaches existing table sessions; declare why on the step: reaches: reaching(['sessions'], '<reason>')`,
  ]);
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements, reaches: reaching(['sessions'], ' ') }])).toHaveLength(2);
  // A second build rides on the same reason; a row write does not.
  const more = [...statements, 'CREATE INDEX IF NOT EXISTS idx_probe_two ON sessions (project_id)'];
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements: more, reaches: reaching(['sessions'], reason) }])).toEqual([]);
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements: [...more, 'DELETE FROM sessions'], reaches: reaching(['sessions'], reason) }])).toEqual([
    `step ${next}: a row write changes existing table sessions, and its reach gives no reason for a change; declare it: reaches: changing(['sessions'], '<reason>')`,
  ]);
  expect(ownershipViolations([...SCHEMA_STEPS, { version: next, statements: [...more, 'DELETE FROM sessions'], reaches: changing(['sessions'], reason) }])).toEqual([]);
});

const existing: SchemaStep = { version: 99, statements: ['CREATE TABLE IF NOT EXISTS sessions (project_id TEXT, session_id TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_old ON sessions (session_id)'] };
const later = (...statements: string[]): SchemaStep[] => [existing, { version: 101, statements }];

it('ownership places every later statement after leading comments and refuses what it cannot place', () => {
  for (const prefix of ['', '-- x\n', '/* x */', '\n -- x\n /* y */ -- z\n']) {
    expect(ownershipViolations(later(prefix + 'CREATE INDEX idx_probe ON sessions (session_id)'))).toHaveLength(1);
    expect(ownershipViolations(later(prefix + 'CREATE TABLE new_rows(id INTEGER)', prefix + 'CREATE INDEX idx_new ON new_rows(id)'))).toEqual([]);
  }
  for (const sql of ['CREATE /* x */ INDEX idx_probe ON sessions(session_id)', 'CREATE INDEX idx_probe ON main.sessions(session_id)',
    '/* unterminated', '-- comment only', 'VACUUM', 'CREATE INDEX idx_probe ON', 'DROP INDEX IF EXISTS idx_never_built'])
    expect(ownershipViolations(later(sql))).toHaveLength(1);
});

it('ownership refuses an undeclared build on an existing table, and a change declared only with a build reason', () => {
  const create = 'CREATE TABLE IF NOT EXISTS new_rows (id INTEGER PRIMARY KEY)';
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_sessions_probe ON sessions (project_id, session_id)',
    'CREATE TRIGGER IF NOT EXISTS old_rows_ai AFTER INSERT ON sessions BEGIN SELECT 1; END',
    "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='sessions')",
    'DROP INDEX IF EXISTS idx_sessions_old',
  ]) {
    expect(ownershipViolations(later(create, sql))).toHaveLength(1);
    expect(ownershipViolations([existing, { version: 101, statements: [create, sql], reaches: reaching(['sessions'], 'Declared.') }])).toEqual([]);
  }
  for (const sql of [
    'ALTER TABLE sessions ADD COLUMN probe TEXT',
    "UPDATE sessions SET session_id='x'",
    'WITH gone AS (SELECT 1) DELETE FROM sessions',
    'INSERT OR IGNORE INTO sessions (session_id) SELECT id FROM new_rows',
    "INSERT INTO sessions (session_id) VALUES ('x')",
    'DROP TABLE sessions',
  ]) {
    expect(ownershipViolations(later(create, sql))).toHaveLength(1);
    expect(ownershipViolations([existing, { version: 101, statements: [create, sql], reaches: reaching(['sessions'], 'A build reason.') }])).toHaveLength(1);
    expect(ownershipViolations([existing, { version: 101, statements: [create, sql], reaches: changing(['sessions'], 'Declared.') }])).toEqual([]);
  }
  expect(ownershipViolations(later('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)', 'CREATE INDEX idx_probe ON sessions (session_id)'))).toHaveLength(1);
  expect(ownershipViolations(later(create, 'CREATE INDEX IF NOT EXISTS idx_new_rows ON new_rows (id)',
    'CREATE TRIGGER IF NOT EXISTS new_rows_ai AFTER INSERT ON new_rows BEGIN SELECT 1; END',
    "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='new_rows')", 'INSERT INTO new_rows (id) VALUES (1)',
    'CREATE TABLE _probe_range (high INTEGER)', 'SELECT COUNT(*) FROM sessions'))).toEqual([]);
});

it('a drop the step declares retired needs no reach, and a reach or change no statement makes is refused', () => {
  expect(ownershipViolations([existing, { version: 101, statements: ['DROP INDEX IF EXISTS idx_sessions_old'],
    retires: retiring('index', ['idx_sessions_old'], 'Nothing reads it.') }])).toEqual([]);
  expect(ownershipViolations([existing, { version: 101, statements: ['CREATE TABLE new_rows (id INTEGER)'],
    reaches: reaching(['sessions'], 'Stale.') }])).toEqual([
    'step 101: declares a reach on sessions that none of its statements makes; remove it',
  ]);
  expect(ownershipViolations([existing, { version: 101, statements: ['CREATE INDEX idx_sessions_probe ON sessions (session_id)'],
    reaches: changing(['sessions'], 'Stale change.') }])).toEqual([
    'step 101: declares a change to sessions that none of its statements makes; declare it with reaching instead',
  ]);
  expect(ownershipViolations([{ ...existing, version: 50 }, { ...existing, version: 51, statements: ['UPDATE sessions SET session_id=1'] }])).toEqual([]);
});

it('a step declares a Deployment-wide index only for an index it creates, once across the steps', () => {
  const declared = SCHEMA_STEPS.flatMap((step) => (step.deploymentIndexes ?? []).map(({ index, read }) => ({ step, index, read })));
  const misplaced = declared.filter(({ step, index, read }) => !read.trim() || !step.statements.some((sql) => {
    const match = withoutLeadingComments(sql)?.match(createIndex);
    return match !== null && match !== undefined && name(match[1]!) === index;
  })).map(({ step, index }) => `step ${step.version}: ${index}`);
  expect(misplaced).toEqual([]);
  expect(declared.map(({ index }) => index).filter((index, at, all) => all.indexOf(index) !== at)).toEqual([]);
});

it('schema steps are contiguous from one through the server version and migration names match exactly', () => {
  expect(SCHEMA_STEPS.map((step) => step.version)).toEqual(
    Array.from({ length: SERVER_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  expect(
    readdirSync('packages/myco-server/migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort(),
  ).toEqual(SCHEMA_STEPS.map(migrationFileName));
});

/**
 * Each generator whose SQL runtime code shares, and the frozen step that holds what it emits: a change to the shared
 * SQL fails here instead of leaving the trigger behind the catch-up that repeats it.
 */
const triggerSql = (triggers: readonly { sql: string }[]) => triggers.map(trigger => trigger.sql);
const GENERATOR_PINS: readonly (readonly [step: number, generated: () => readonly string[]])[] = [
  [NEXT_S6, lineageHeadSchemaStatements],
  [NEXT_S6B + 4, authorityRetentionSchemaStatements],
  [NEXT_S1C, headSchemaStatements],
  [V711, () => triggerSql(kpiTriggers())],
  [V712, () => triggerSql(passedOverTriggers())],
  [V714, spendSchemaStatements],
  [NEXT_PLAN_CURATION, () => triggerSql(spendTriggers())],
  [V716, () => triggerSql(sourceStateTriggers())],
  [V717, publicationContributionSchema],
  [V719, liveSchemaStatements],
  [V719, () => triggerSql(liveTriggers())],
  [V721, planCountSchemaStatements],
  [V721, sporeCountSchemaStatements],
  [V722, () => triggerSql(calibrationTriggers())],
  [V723, publicationPinSchema],
  [V723, publicationFailureSchema],
  [V723, publicationRebuildSchema],
  [V724, workSchemaStatements],
  [V724, () => triggerSql(workTriggers())],
  [V727, storageUsageSchemaStatements],
  [SESSION_LIFECYCLE_STEPS[0]!.version, () => [SESSION_LIFECYCLE_EVENTS_INDEX]],
  [V730, sessionLifecycleSchema],
];

it('every generator the runtime keeps is still verbatim in its frozen step', () => {
  for (const [step, generated] of GENERATOR_PINS) {
    const frozen = SCHEMA_STEPS.find(candidate => candidate.version === step)?.statements ?? [];
    expect({ step, drifted: generated().filter(sql => !frozen.includes(sql)) }).toEqual({ step, drifted: [] });
  }
});
