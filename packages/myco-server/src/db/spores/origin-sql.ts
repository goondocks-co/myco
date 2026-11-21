/**
 * How a spore came to be, as SQL over a spore row `row`: whether an editorial operation (a curation answer or a
 * consolidation) wrote it, and how many spores that operation wrote it from. Spore reads answer these, and the origin
 * facts the filtered list and its totals read are derived from the same two expressions.
 */

/** A Project's active embedding models, apart from the inactive ones it retains. */
export const ACTIVE_MODELS_INDEX = 'idx_embedding_models_active';
export const ACTIVE_MODELS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${ACTIVE_MODELS_INDEX} ON embedding_models(project_id,model_key) WHERE active=1`;

/** The members of one operation, by their primary key: seeking an operation's own members, never every output of its Project. */
export const UNIT_MEMBERS = 'sqlite_autoindex_spore_curation_unit_members_1';

/** The output membership of the operation that wrote `row`, read through the unique output index. */
const outputOf = (row: string): string => `spore_curation_unit_members o INDEXED BY idx_curation_unit_output
  WHERE o.project_id=${row}.project_id AND o.spore_id=${row}.id AND o.role='output'`;

/** 1 when a curation answer or a consolidation wrote `row`, else 0: one output-index seek. */
export const sporeCuratedSql = (row: string): string => `EXISTS (SELECT 1 FROM ${outputOf(row)})`;

/**
 * How many spores the operation that wrote `row` wrote it from: that operation's sources whose recorded events name
 * `row`. A spore linked to it later is not one it was written from. One output-index seek and the members of that one
 * operation, each with the events it recorded.
 */
export const sporeSourcesSql = (row: string): string => `(SELECT COUNT(*) FROM spore_curation_unit_members o INDEXED BY idx_curation_unit_output
    CROSS JOIN spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} ON m.project_id=o.project_id AND m.unit_id=o.unit_id AND m.role='source'
  WHERE o.project_id=${row}.project_id AND o.spore_id=${row}.id AND o.role='output' AND EXISTS (SELECT 1 FROM json_each(m.event_ids) j
    CROSS JOIN resolution_events e ON e.project_id=m.project_id AND e.id=j.value WHERE e.new_spore_id=${row}.id))`;
