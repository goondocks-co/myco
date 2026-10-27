import { FACT_MATERIALS, type MaterialKind } from '../db/view-tables.js';

interface SqlValue {
  sql: string;
  params: readonly unknown[];
}
/** One JSON parameter carries a fragment's values into a scalar SQL expression. */
export function bindMaterialSql(fragment: SqlValue): SqlValue {
  let index = 0,
    suffix = 0;
  while (fragment.sql.includes('__material_parameters_' + suffix)) suffix++;
  const parameters = '__material_parameters_' + suffix;
  const sql = fragment.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) =>
    token === '?' ? `json_extract((SELECT doc FROM ${parameters}),'$[${index++}]')` : token,
  );
  if (index !== fragment.params.length) throw new Error('material_parameters_invalid');
  return { sql: `WITH ${parameters} AS(SELECT ? doc) SELECT (${sql})`, params: [JSON.stringify(fragment.params)] };
}
export interface MaterialAssignment extends SqlValue {
  column: string;
}
export interface PreparedMaterialEffect {
  kind: MaterialKind;
  table: (typeof FACT_MATERIALS)[MaterialKind]['fact'];
  keyColumn: string;
  recordId: string;
  postimage: SqlValue;
  newBodies?: Readonly<Record<string, string>>;
  skipLegacy?: boolean;
}

const identifier = /^[a-z_][a-z_0-9]*$/i;

/** Bound incoming fields retain the column declarations of their operation. */
export function materialFields<T extends Record<string, unknown>>(
  values: T,
  integers: readonly (keyof T)[],
): Record<string, SqlValue> {
  if (integers.some((column) => values[column] !== null && !Number.isSafeInteger(values[column])))
    throw new Error('material_integer_invalid');
  const integerColumns = new Set<PropertyKey>(integers);
  return Object.fromEntries(
    Object.entries(values).map(([column, value]) => [
      column,
      { sql: integerColumns.has(column) ? 'CAST(? AS INTEGER)' : '?', params: [value] },
    ]),
  );
}

/** One set of assignment expressions defines the committed merge and its guarded postimage. */
type MergeTarget<Kind extends MaterialKind> = {
  kind: Kind;
  table: (typeof FACT_MATERIALS)[NoInfer<Kind>]['fact'];
  keyColumn: (typeof FACT_MATERIALS)[NoInfer<Kind>]['id'];
};

/** An update's postimage uses the same assignment expression as its committed statement. */
export function materialUpdate<Kind extends MaterialKind>(
  definition: MergeTarget<Kind> & {
    project: string;
    recordId: string;
    columns: readonly string[];
    assignments: readonly MaterialAssignment[];
    postimageAssignments?: readonly MaterialAssignment[];
    alias?: string;
    when?: SqlValue;
    session?: string;
  },
) {
  const { table, keyColumn, columns, assignments } = definition;
  const alias = definition.alias ?? table;
  const target = FACT_MATERIALS[definition.kind];
  if (
    [alias, keyColumn, ...columns, ...assignments.map((item) => item.column)].some(
      (column) => !identifier.test(column),
    ) ||
    table !== target.fact ||
    keyColumn !== target.id ||
    (definition.kind === 'session-record' && definition.session === undefined) ||
    new Set(columns).size !== columns.length ||
    assignments.some((item) => !columns.includes(item.column))
  )
    throw new Error('material_update_definition_invalid');
  const postimageAssignments = definition.postimageAssignments ?? assignments;
  if (
    postimageAssignments.length !== assignments.length ||
    postimageAssignments.some((item, i) => item.column !== assignments[i]?.column)
  )
    throw new Error('material_update_definition_invalid');
  const updates = new Map(postimageAssignments.map((item) => [item.column, item]));
  const postimage = {
    sql: `SELECT json_object(${columns.map((column) => `'${column}',${updates.get(column)?.sql ?? `${alias}.${column}`}`).join(',')})
    FROM ${table} ${alias} WHERE ${alias}.project_id=? AND ${alias}.${keyColumn}=?${definition.session === undefined ? '' : ` AND ${alias}.session_id=?`}${definition.when ? ` AND (${definition.when.sql})` : ''}`,
    params: [
      ...columns.flatMap((column) => updates.get(column)?.params ?? []),
      definition.project,
      definition.recordId,
      ...(definition.session === undefined ? [] : [definition.session]),
      ...(definition.when?.params ?? []),
    ],
  };
  const effect: PreparedMaterialEffect = {
    kind: definition.kind,
    table,
    keyColumn,
    recordId: definition.recordId,
    postimage: bindMaterialSql(postimage),
  };
  return {
    update: {
      sql: assignments.map((item) => `${item.column} = ${item.sql}`).join(', '),
      params: assignments.flatMap((item) => item.params),
    },
    effect,
  };
}

export function materialMerge<Kind extends MaterialKind>(
  definition: MergeTarget<Kind> & {
    recordId: string;
    incoming: Record<string, SqlValue>;
    assignments: readonly MaterialAssignment[];
    when?: SqlValue;
    retained?: readonly string[];
    sessionKey?: boolean;
    insertWhen?: SqlValue;
    source?: SqlValue;
  },
) {
  const { table, keyColumn, incoming, assignments } = definition;
  const inserted = Object.keys(incoming),
    columns = [...new Set([...inserted, ...(definition.retained ?? [])])];
  const target = FACT_MATERIALS[definition.kind];
  if (
    table !== target.fact ||
    keyColumn !== target.id ||
    !columns.includes('project_id') ||
    !columns.includes(keyColumn) ||
    (definition.kind === 'session-record' && !definition.sessionKey) ||
    [keyColumn, ...columns, ...assignments.map((item) => item.column)].some((column) => !identifier.test(column)) ||
    assignments.some((item) => !columns.includes(item.column)) ||
    new Set(assignments.map((item) => item.column)).size !== assignments.length ||
    (assignments.length === 0 && definition.when !== undefined)
  )
    throw new Error('material_merge_definition_invalid');

  const parameters: unknown[] = [];
  const parameterized = (fragment: SqlValue): string => {
    let index = 0;
    const sql = fragment.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => {
      if (token !== '?') return token;
      parameters.push(fragment.params[index++]);
      return `json_extract((SELECT doc FROM parameters),'$[${parameters.length - 1}]')`;
    });
    if (index !== fragment.params.length) throw new Error('material_merge_parameters_invalid');
    return sql;
  };
  const updates = new Map(assignments.map((item) => [item.column, parameterized(item)]));
  const condition = definition.when ?? { sql: assignments.length === 0 ? '0' : '1', params: [] };
  const when = parameterized(condition);
  const absent = `${table}.${keyColumn} IS NULL`;
  const field = (column: string) => {
    const initial = inserted.includes(column) ? `excluded.${column}` : 'NULL';
    return `CASE WHEN ${absent} THEN ${initial} WHEN (${when}) THEN ${updates.get(column) ?? `${table}.${column}`} ELSE ${table}.${column} END`;
  };
  const postimage = {
    sql: `WITH parameters AS(SELECT ? doc),excluded AS(SELECT ${inserted.map((column) => `${incoming[column]!.sql} AS ${column}`).join(', ')}${definition.source === undefined ? '' : ` ${definition.source.sql}`})
      SELECT json_object('_new',${absent},${columns.map((column) => `'${column}',${field(column)}`).join(',')})
      FROM excluded LEFT JOIN ${table} ON ${table}.project_id=excluded.project_id AND ${table}.${keyColumn}=excluded.${keyColumn}${definition.sessionKey ? ` AND ${table}.session_id=excluded.session_id` : ''}
      WHERE (${absent} OR (${when}))${definition.insertWhen ? ` AND (${definition.insertWhen.sql})` : ''}`,
    params: [
      JSON.stringify(parameters),
      ...inserted.flatMap((column) => incoming[column]!.params),
      ...(definition.source?.params ?? []),
      ...(definition.insertWhen?.params ?? []),
    ],
  };
  const effect: PreparedMaterialEffect = {
    kind: definition.kind,
    table,
    keyColumn,
    recordId: definition.recordId,
    postimage: bindMaterialSql(postimage),
  };
  return {
    insert: {
      columns: inserted,
      sql: inserted.map((column) => incoming[column]!.sql).join(', '),
      params: inserted.flatMap((column) => incoming[column]!.params),
      source: definition.source,
    },
    update: {
      sql: assignments.map((item) => `${item.column} = ${item.sql}`).join(', '),
      params: assignments.flatMap((item) => item.params),
    },
    when: condition,
    effect,
  };
}
