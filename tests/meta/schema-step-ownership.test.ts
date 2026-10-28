import { readdirSync } from 'node:fs';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';

interface Exception {
  step: number;
  object: string;
  table: string;
  reason: string;
}
const EXCEPTIONS: readonly Exception[] = [
  {step:106,object:'prompt_batches_legacy_class_insert',table:'prompt_batches',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'prompt_batches_legacy_class_update',table:'prompt_batches',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'responses_legacy_class_insert',table:'responses',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'responses_legacy_class_update',table:'responses',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'tool_calls_legacy_class_insert',table:'tool_calls',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'tool_calls_legacy_class_update',table:'tool_calls',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'plans_legacy_class_insert',table:'plans',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'plans_legacy_class_update',table:'plans',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'tags_plan_legacy_class_insert',table:'tags',reason:'A tag edit is plan edit evidence and reclassifies the plan.'},
  {step:106,object:'tags_plan_legacy_class_delete',table:'tags',reason:'A tag removal is plan edit evidence and reclassifies the plan.'},
  {step:103,object:'agent_attempt_settled_insert',table:'agent_run_attempts',reason:'New known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settled_update',table:'agent_run_attempts',reason:'Newly known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settlement_fixed',table:'agent_run_attempts',reason:'Settlement order remains stable for incremental estimate seeks.'},
  {step:103,object:'agent_attempt_cost_fixed',table:'agent_run_attempts',reason:'Settled attempt prices and known sources are immutable.'},
  {step:103,object:'agent_attempt_machine_fixed',table:'agent_run_attempts',reason:'Known attempt claim machine attribution is immutable.'},
  {step:103,object:'agent_runs_origin_insert',table:'agent_runs',reason:'Omitted dispatch origins must be classified before queue-head admission.'},
  {step:103,object:'agent_runs_origin_fixed',table:'agent_runs',reason:'Persisted dispatch origin is immutable.'},
  {step:103,object:'agent_attempt_claim_fixed',table:'agent_run_attempts',reason:'Claim time, estimate and profile are immutable attempt evidence.'},

  ...['prompts', 'responses', 'tool_calls', 'plans'].map((kind) => ({
    step: 105,
    object: 'idx_view_' + kind + '_identity',
    table: 'view_' + kind,
    reason: 'The writer extension requires empty instance storage.',
  })),
  {
    step: 105,
    object: 'idx_view_active_leases',
    table: 'view_instances',
    reason: 'Build slot admission indexes empty instance storage.',
  },
  {
    step: 105,
    object: 'idx_view_stale',
    table: 'view_instances',
    reason: 'Stale generation admission indexes empty instance storage.',
  },
  {
    step: 105,
    object: 'idx_view_promotions_pending',
    table: 'plan_promotions',
    reason: 'Publication admission indexes empty promotion storage.',
  },
  {
    step: 105,
    object: 'idx_view_prompt_source',
    table: 'view_prompts',
    reason: 'Coverage counterpart admission indexes empty material storage.',
  },
  {
    step: 107,
    object: 'idx_view_prompts_source_range',
    table: 'view_prompts',
    reason: 'Source-range acknowledgement indexes prompt storage of at most one row per captured prompt.',
  },
];
interface StatementException {
  step: number;
  sql: string;
  reason: string;
}
const STATEMENT_EXCEPTIONS: readonly StatementException[] = [
  {
    step: 105,
    sql: 'INSERT INTO _v105_empty SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM view_instances) THEN 1 ELSE 0 END',
    reason: 'Writer extensions require empty instance storage.',
  },
  { step: 105, sql: 'DROP TABLE IF EXISTS _v105_empty', reason: 'The admission table is temporary.' },
  ...['view_prompts', 'view_responses', 'view_tool_calls', 'view_plans'].flatMap((table) =>
    [
      'material_seq INTEGER CHECK(material_seq IS NULL OR material_seq>0)',
      'view_content_hash TEXT',
      'hash_scheme TEXT',
      'canonical_identity TEXT',
    ].map((column) => ({
      step: 105,
      sql: 'ALTER TABLE ' + table + ' ADD COLUMN ' + column,
      reason: 'Empty material storage carries publication identity and sequence.',
    })),
  ),
  ...['outcome_source TEXT', 'call_source TEXT'].map((column) => ({
    step: 105,
    sql: 'ALTER TABLE view_tool_calls ADD COLUMN ' + column,
    reason: 'Tool assembly persists canonical source order in empty storage.',
  })),
  {
    step: 105,
    sql: "ALTER TABLE view_plans ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
    reason: 'Empty plan storage retains the complete logical tag set.',
  },
  ...[
    'parsed_at INTEGER',
    'parser_version INTEGER',
    'fidelity TEXT',
    'parse_segment_lines INTEGER',
    'prompt_generation INTEGER',
    'parse_failed_at INTEGER',
  ].map((column) => ({
    step: 105,
    sql: 'ALTER TABLE view_checkpoints ADD COLUMN ' + column,
    reason: 'Empty checkpoints carry the complete live frontier.',
  })),
  {
    step: 101,
    sql: 'ALTER TABLE spores ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
    reason: 'Each existing spore carries its revision.',
  },
  {
    step: 101,
    sql: `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('guard_enabled_at', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
    reason: 'The Deployment records its revision-guard dispatch boundary.',
  },
  {
    step: 102,
    sql: `INSERT OR IGNORE INTO retired_deployment_settings (leaf,value,updated_at,updated_by,retired_at)
    SELECT 'agent.tasks.extract-curate.schedule',value,updated_at,updated_by,unixepoch()*1000
    FROM deployment_settings WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN json_type(value, '$."extract-curate".schedule') IS NOT NULL ELSE 1 END`,
    reason: 'The Deployment retains the original extraction schedule preferences.',
  },
  {
    step: 102,
    sql: `INSERT INTO _v102_guard_learning_settings(ok) SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM deployment_settings live WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN json_type(value, '$."extract-curate".schedule') IS NOT NULL ELSE 1 END
    AND NOT EXISTS (SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf='agent.tasks.extract-curate.schedule'
      AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by)
    ) THEN 1 ELSE 0 END`,
    reason: 'The settings guard requires the complete retired preference record.',
  },
  {
    step: 102,
    sql: `DROP TABLE _v102_guard_learning_settings`,
    reason: 'The temporary settings guard is released after admission.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings
    SET value=json_set(value, '$."extract-curate".enabled', json(value -> '$."extract-curate".schedule.enabled')),
      write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object'
      AND json_type(value, '$."extract-curate".schedule.enabled') IS NOT NULL
      AND json_type(value, '$."extract-curate".enabled') IS NULL ELSE 0 END`,
    reason: 'The extraction enabled preference retains its stored value.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings
    SET value=json_set(value, '$."extract-curate".memberRunsPerDay', json(value -> '$."extract-curate".schedule.memberRunsPerDay')),
      write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object'
      AND json_type(value, '$."extract-curate".schedule.memberRunsPerDay') IS NOT NULL
      AND json_type(value, '$."extract-curate".memberRunsPerDay') IS NULL ELSE 0 END`,
    reason: 'The extraction member allowance retains its stored value.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings SET value=json_remove(value, '$."extract-curate".schedule'),write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object' ELSE 0 END`,
    reason: 'The extraction task uses flat preferences.',
  },
  {
    step: 102,
    sql: `INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('learning_paused_at',CAST(unixepoch()*1000 AS TEXT))`,
    reason: 'The Deployment records its learning pause boundary.',
  },
  {
    step: 102,
    sql: `UPDATE member_credentials SET revoked_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
      revoked_by='mem_harness'
    WHERE member_id='mem_harness' AND revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM agent_runs WHERE status='queued' AND task='extract-curate' AND dispatched_by=member_credentials.id)`,
    reason: 'Queued extraction credentials are revoked at the pause boundary.',
  },
  {
    step: 102,
    sql: `UPDATE agent_runs SET status='skipped',
    completed_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
    run_context='{"reason":"learning_paused"}',held_by=NULL,dispatch_spec=NULL
    WHERE status='queued' AND task='extract-curate'`,
    reason: 'Queued extraction attempts close with their learning pause reason.' },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN estimate_usd REAL CHECK(estimate_usd IS NULL OR estimate_usd>=0)",
    reason: "Attempts retain the forecast recorded at claim time." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd>=0)",
    reason: "Attempts retain their settled price." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN cost_source TEXT",
    reason: "Attempts retain their settled price source." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN profile_json TEXT",
    reason: "Attempts retain their immutable model and harness profile." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN settled_seq INTEGER CHECK(settled_seq IS NULL OR settled_seq>0)",
    reason: "Known attempt costs retain Deployment-local settlement order." },
  { step: 103, sql: "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('budget.settlement_sequence','0')",
    reason: "The Deployment records its monotonic settlement sequence." },
  { step: 103, sql: "ALTER TABLE agent_runs ADD COLUMN origin TEXT CHECK(origin IN ('manual','automatic'))",
    reason: "Dispatches retain their automatic or manual origin." },
  { step: 103, sql: "UPDATE agent_runs SET origin=COALESCE(origin,CASE WHEN CASE WHEN json_valid(dispatch_spec) THEN CASE WHEN json_type(dispatch_spec, '$.actor') = 'text' THEN NULLIF(json_extract(dispatch_spec, '$.actor'), '') END END IN ('clock','backfill','deployment') THEN 'automatic' ELSE 'manual' END) WHERE status IN ('pending', 'running', 'queued') AND origin IS NULL",
    reason: "Live dispatches receive the origin fixed by their persisted actor." },
  { step: 104, sql: `INSERT INTO _v104_guard_thin_learning(pause_required,not_drained)
    SELECT CASE WHEN refusal='thin_learning_pause_required' THEN 1 ELSE 0 END,
      CASE WHEN refusal='thin_learning_not_drained' THEN 1 ELSE 0 END FROM (WITH thin_learning_runs AS (SELECT task,status,queued_at,started_at FROM agent_runs) SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='learning_paused_at' AND typeof(value)='text' AND length(value)>0
  AND value NOT GLOB '*[^0-9]*' AND CAST(value AS INTEGER)>0
  AND CAST(value AS INTEGER)<=9007199254740991
  AND CAST(CAST(value AS INTEGER) AS TEXT)=value) THEN 'thin_learning_pause_required'
    WHEN EXISTS (SELECT 1 FROM thin_learning_runs WHERE task='extract-curate' AND status IN ('pending', 'running', 'queued')
      AND (COALESCE(queued_at,started_at) IS NULL
        OR typeof(COALESCE(queued_at,started_at))!='integer'
        OR COALESCE(queued_at,started_at)<=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at')))
      THEN 'thin_learning_not_drained'
    ELSE NULL END AS refusal)`,
    reason: 'Activation requires a valid pause boundary and drained thin extraction dispatches.' },
  { step: 104, sql: 'DROP TABLE _v104_guard_thin_learning',
    reason: 'The temporary admission guard is released after validation.' },
];
const IDENTIFIER = '(?:[a-zA-Z_][a-zA-Z_0-9]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const QUALIFIED_IDENTIFIER = `(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`;
const name = (value: string) => value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
const createTable = new RegExp(
  `^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})(?:\\s|\\()`,
  'i',
);
const createIndex = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s*\\(`,
  'i',
);
const createTrigger = new RegExp(
  `^CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+(?:INSERT|DELETE|UPDATE(?:\\s+OF\\s+${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*)?)\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s`,
  'i',
);

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

function ownershipViolations(
  steps: readonly SchemaStep[],
  exceptions = EXCEPTIONS,
  statementExceptions = STATEMENT_EXCEPTIONS,
): string[] {
  const errors: string[] = [];
  for (const exception of exceptions) {
    if (!exception.reason.trim())
      errors.push(`step ${exception.step}: ${exception.object} requires an exception reason`);
  }
  for (const exception of statementExceptions) {
    if (!exception.reason.trim()) errors.push(`step ${exception.step}: statement requires an exception reason`);
  }
  const createdBefore = new Set<string>();
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    const statements = step.statements.map((sql) => withoutLeadingComments(sql));
    const declared = statements.flatMap((sql) => {
      const match = sql === null ? null : createTable.exec(sql);
      return match ? [name(match[1]!)] : [];
    });
    const tables = new Set(declared.filter((table) => !createdBefore.has(table)));
    for (const table of declared) createdBefore.add(table);
    if (step.version < 100) continue;
    const check = (object: string, table: string) => {
      if (
        !tables.has(table) &&
        !exceptions.some(
          (exception) =>
            exception.step === step.version &&
            exception.object === object &&
            exception.table === table &&
            exception.reason.trim(),
        )
      ) {
        errors.push(`step ${step.version}: ${object} targets existing table ${table}`);
      }
    };
    for (const [index, sql] of statements.entries()) {
      if (sql === `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${step.version}')`) continue;
      if (
        statementExceptions.some(
          (exception) =>
            exception.step === step.version && exception.sql === step.statements[index] && exception.reason.trim(),
        )
      )
        continue;
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
        if (/\bcontent\s*=/i.test(sql) && !content)
          errors.push(`step ${step.version}: unrecognized FTS content: ${sql}`);
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
    expect(
      ownershipViolations([
        {
          version: 101,
          statements: [prefix + 'CREATE TABLE new_rows(id INTEGER)', prefix + 'CREATE INDEX idx_new ON new_rows(id)'],
        },
      ]),
    ).toEqual([]);
  }
  for (const sql of [
    'CREATE /* x */ INDEX idx_probe ON sessions(session_id)',
    'CREATE INDEX idx_probe ON main.sessions(session_id)',
    '/* unterminated',
    '-- comment only',
    'SELECT 1',
    'CREATE INDEX idx_probe ON',
  ]) {
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
  for (const sql of bypasses)
    expect(ownershipViolations([{ version: 101, statements: [create, sql] }])).toHaveLength(1);
  expect(
    ownershipViolations([
      { version: 99, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)'] },
      { version: 101, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)', bypasses[0]!] },
    ]),
  ).toHaveLength(1);
  expect(
    ownershipViolations([
      {
        version: 101,
        statements: [
          create,
          'CREATE INDEX IF NOT EXISTS idx_new_rows ON new_rows (id)',
          'CREATE TRIGGER IF NOT EXISTS new_rows_ai AFTER INSERT ON new_rows BEGIN SELECT 1; END',
          "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='new_rows')",
        ],
      },
    ]),
  ).toEqual([]);
});

it('existing-table exceptions name their step, object, table and reason', () => {
  const step = { version: 101, statements: ['CREATE INDEX IF NOT EXISTS idx_old ON sessions (session_id)'] };
  const exception = {
    step: 101,
    object: 'idx_old',
    table: 'sessions',
    reason: 'Explicitly admitted existing-table maintenance.',
  };
  expect(ownershipViolations([step], [exception])).toEqual([]);
  expect(ownershipViolations([step], [{ ...exception, reason: '' }])).toHaveLength(2);
  expect(ownershipViolations([{ ...step, version: 102 }], [exception])).toHaveLength(1);
});

it('maintenance statement exceptions pin the step, exact SQL and reason', () => {
  for (const exception of STATEMENT_EXCEPTIONS) {
    const step = { version: exception.step, statements: [exception.sql] };
    expect(ownershipViolations([step], [], [exception])).toEqual([]);
    expect(ownershipViolations([{ ...step, version: exception.step + 1 }], [], [exception])).toHaveLength(1);
    for (const sql of [exception.sql + ' ', ' ' + exception.sql, '-- x\n' + exception.sql, '/* x */' + exception.sql]) {
      expect(ownershipViolations([{ ...step, statements: [sql] }], [], [exception])).toHaveLength(1);
    }
    expect(ownershipViolations([step], [], [{ ...exception, reason: '' }])).toHaveLength(2);
  }
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
