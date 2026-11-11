const FACT_MATERIALS = {
  plan:{fact:'plans',id:'plan_key'},
  attachment:{fact:'attachments',id:'attachment_id'},
  injection:{fact:'spore_injections',id:'id'},
  answer:{fact:'prompt_context_answers',id:'id'},
  'session-record':{fact:'session_injections',id:'kind'},
  event:{fact:'events',id:'event_id'},
} as const;
type MaterialKind = keyof typeof FACT_MATERIALS;

interface SqlValue {
  sql: string;
  params: readonly unknown[];
}
export interface MaterialAssignment extends SqlValue {
  column: string;
}
const identifier = /^[a-z_][a-z_0-9]*$/i;

/** Each kind names one relational target and canonical key. */
type MergeTarget<Kind extends MaterialKind> = {
  kind: Kind;
  table: (typeof FACT_MATERIALS)[NoInfer<Kind>]['fact'];
  keyColumn: (typeof FACT_MATERIALS)[NoInfer<Kind>]['id'];
};

/** A validated target and assignment list define one relational update. */
export function materialUpdate<Kind extends MaterialKind>(
  definition: MergeTarget<Kind> & {
    columns: readonly string[];
    assignments: readonly MaterialAssignment[];
    session?: string;
  },
) {
  const { table, keyColumn, columns, assignments } = definition;
  const target = FACT_MATERIALS[definition.kind];
  if (
    [keyColumn, ...columns, ...assignments.map((item) => item.column)].some(
      (column) => !identifier.test(column),
    ) ||
    table !== target.fact ||
    keyColumn !== target.id ||
    (definition.kind === 'session-record' && definition.session === undefined) ||
    new Set(columns).size !== columns.length ||
    assignments.some((item) => !columns.includes(item.column))
  )
    throw new Error('material_update_definition_invalid');
  return {
    update: {
      sql: assignments.map((item) => `${item.column} = ${item.sql}`).join(', '),
      params: assignments.flatMap((item) => item.params),
    },
  };
}
