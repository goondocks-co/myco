import type { PreparedStatement, RelationalStore } from './adapters.js';
import type { ContextWrite } from './context-writes.js';
import { FACT_MATERIALS } from '../db/view-tables.js';
import { materialFields, materialMerge } from '../ingest/material-mutation.js';
import type { Fragment } from '../ingest/projections.js';
import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';
import { TURN_KIND } from '@goondocks/myco-shared/member-protocol';

const identifier = /^[a-z_][a-z_0-9]*$/i;
const definitions = Object.values(FACT_MATERIALS);
interface Column {
  name: string;
  type: string;
  dflt_value: string | null;
  pk: number;
}
const schemas = new WeakMap<RelationalStore, Map<string, Promise<readonly Column[]>>>();
export const isMaterialFactTable = (table: string) => definitions.some((definition) => definition.fact === table);

/** Additive material restoration shares its canonical statement and its schema-defaulted postimage. */
export async function prepareMaterialRestore(
  db: RelationalStore,
  table: string,
  row: Record<string, unknown>,
  when: Fragment = { sql: '1', params: [] },
): Promise<{
  statement: PreparedStatement;
  write: ContextWrite | null;
}> {
  const definition = definitions.find((item) => item.fact === table);
  if (definition === undefined) throw new Error('material_restore_table_invalid');
  const columns = Object.keys(row);
  if (
    columns.some((column) => !identifier.test(column)) ||
    typeof row.project_id !== 'string' ||
    typeof row[definition.id] !== 'string'
  )
    throw new Error('material_restore_row_invalid');
  let schema = schemas.get(db);
  if (schema === undefined) {
    schema = new Map();
    schemas.set(db, schema);
  }
  let loaded = schema.get(table);
  if (loaded === undefined) {
    const cache = schema;
    loaded = db
      .prepare(`PRAGMA table_info(${table})`)
      .all<Column>()
      .then((value) => value.results)
      .catch((error) => {
        cache.delete(table);
        throw error;
      });
    schema.set(table, loaded);
  }
  const held = await loaded;
  if (columns.some((column) => !held.some((field) => field.name === column)))
    throw new Error('material_restore_column_invalid');
  const session = typeof row.session_id === 'string' ? row.session_id : null;
  const admission =
    session === null
      ? when
      : { sql: `(${when.sql}) AND (${NOT_TOMBSTONED_PARAMS})`, params: [...when.params, row.project_id, session] };
  const statement = db
    .prepare(
      `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}
   WHERE ${admission.sql} RETURNING rowid`,
    )
    .bind(...columns.map((column) => row[column] ?? null), ...admission.params);
  if (
    session === null ||
    (definition.kind === 'event' && ![TURN_KIND, 'subagent.start', 'subagent.stop'].includes(String(row.kind)))
  )
    return { statement, write: null };
  const supplied = materialFields(
    row,
    held.filter((column) => /INT/i.test(column.type) && column.name in row).map((column) => column.name),
  );
  const incoming = Object.fromEntries(
    held.map((column) => [column.name, supplied[column.name] ?? { sql: column.dflt_value ?? 'NULL', params: [] }]),
  );
  const merged = materialMerge({
    kind: definition.kind,
    table: definition.fact,
    keyColumn: definition.id,
    recordId: String(row[definition.id]),
    incoming,
    assignments: [],
    sessionKey: held.some((column) => column.name === 'session_id' && column.pk > 0),
  });
  const effect =
    definition.kind === 'plan'
      ? {
          ...merged.effect,
          postimage: {
            sql: `SELECT json_set((${merged.effect.postimage.sql}),'$.tags',json((SELECT json_group_array(tag) FROM(
    SELECT tag FROM tags WHERE project_id=? AND entity_kind='plan' AND entity_id=? ORDER BY tag))))`,
            params: [...merged.effect.postimage.params, row.project_id, row[definition.id]],
          },
        }
      : merged.effect;
  return {
    statement,
    write: {
      statements: [statement],
      material: { project: row.project_id, effects: [effect], admission, opportunity: { sql: '1', params: [] } },
    },
  };
}
