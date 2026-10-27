import { sqlTokens, type StatementEvent } from './statement-recorder.js';

export const MATERIAL_TABLES = [
  'prompt_batches',
  'responses',
  'tool_calls',
  'plans',
  'view_prompts',
  'view_responses',
  'view_tool_calls',
  'view_plans',
  'attachments',
  'spore_injections',
  'prompt_context_answers',
  'session_injections',
  'events',
] as const;
export const DYNAMIC_MATERIAL_TARGET = '__dynamic_material_target__';
export interface MaterialWriteClass {
  file: string;
  owner: string;
  expression: string;
  table: string;
  operation: string;
  mode: 'versioned' | 'representation-only' | 'out-of-scope' | 'schema' | 'legacy';
  targets: readonly string[];
  adapter: string | null;
  witness: { file: string; test: string };
  fields: string;
  moduleOperation?: string;
}

export const PHYSICAL_MATERIAL_RESTORES: readonly MaterialWriteClass[] = [
  {
    file: 'packages/myco/src/server/sql-dump.ts',
    owner: 'runOneStatement',
    expression: 'sql',
    table: DYNAMIC_MATERIAL_TARGET,
    operation: 'INSERT',
    mode: 'legacy',
    targets: MATERIAL_TABLES,
    adapter: null,
    witness: {
      file: 'tests/server/view-read-operators.test.ts',
      test: 'local recovery materializes real staging and records the actual maintenance reads',
    },
    fields: 'Physical recovery imports admitted snapshot rows into an isolated destination before serving.',
  },
];
export function materialWriteMode(value: string): MaterialWriteClass['mode'] {
  if (
    value === 'versioned' ||
    value === 'representation-only' ||
    value === 'out-of-scope' ||
    value === 'schema' ||
    value === 'legacy'
  )
    return value;
  throw new Error('material_write_class_invalid');
}

export function materialWriteTargets(
  sql: string,
  includeDynamic = false,
  origin?: StatementEvent['origin'],
): { table: string; operation: string }[] {
  const tokens = sqlTokens(sql),
    found: { table: string; operation: string }[] = [];
  if (!includeDynamic && tokens[0]?.toUpperCase() === 'EXPLAIN') return found;
  if (
    !includeDynamic &&
    origin?.kind === 'exception' &&
    (origin.phase === 'H' || origin.phase === 'P') &&
    tokens[0]?.toUpperCase() === 'CREATE' &&
    tokens.slice(1,4).some(token=>token.toUpperCase()==='TRIGGER')
  )
    return found;
  const name = (at: number) =>
    (tokens[tokens[at + 1] === '.' ? at + 2 : at] ?? '').replace(/^quoted:/, '').toLowerCase();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.toUpperCase();
    let table = '';
    if (token === 'UPDATE') table = name(tokens[i + 1]?.toUpperCase() === 'OR' ? i + 3 : i + 1);
    if (
      token === 'INTO' &&
      tokens.slice(Math.max(0, i - 3), i).some((value) => ['INSERT', 'REPLACE'].includes(value.toUpperCase()))
    )
      table = name(i + 1);
    if ((MATERIAL_TABLES as readonly string[]).includes(table) || (includeDynamic && table === DYNAMIC_MATERIAL_TARGET))
      found.push({ table, operation: token === 'UPDATE' ? 'UPDATE' : 'INSERT' });
  }
  return found;
}

/** Unknown material preparations remain violations even when their caller catches the refusal. */
export function materialWriteBoundary(classes: readonly MaterialWriteClass[]) {
  const violations: StatementEvent[] = [];
  return {
    violations,
    check(event: StatementEvent) {
      if (event.kind !== 'prepare') return;
      const origin = event.origin;
      const targets = materialWriteTargets(event.sql, false, origin);
      if (targets.length === 0) return;
      if (origin?.kind === 'exception' && (origin.phase === 'T' || origin.phase === 'H')) return;
      const moduleOperation=/^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(event.sql)?.[1];
      const matching = origin?.kind==='module' ? classes.filter(row=>row.moduleOperation!==undefined&&row.moduleOperation===moduleOperation) :
        origin?.kind === 'exception'
          ? [...classes, ...(origin.phase === 'P' ? PHYSICAL_MATERIAL_RESTORES : [])].filter(
              (row) => row.moduleOperation===undefined&&row.file === origin.file && row.owner === origin.owner && row.expression === origin.expression,
            )
          : [];
      if (
        targets.every((target) =>
          matching.some(
            (row) =>
              row.mode !== 'out-of-scope' && row.operation === target.operation && row.targets.includes(target.table),
          ),
        )
      )
        return;
      violations.push(event);
      throw new Error(
        'material_write_unclassified: ' + targets.map((row) => row.table).join(',') + '/' + event.operation,
      );
    },
  };
}
