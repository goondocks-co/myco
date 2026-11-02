/**
 * The content tables retired at step 117 leave the store in bounded transactions. Their triggers go first, so a
 * delete writes nothing beyond the row it removes; each secondary index goes before the rows it covers; rows leave in
 * fixed rowid ranges recorded once, the last range open-ended; the search tables, the emptied tables and the small
 * tables drop last, children ahead of the parents they reference. A hosted transaction frees pages at a bounded rate
 * (gotcha-c7fd7e06), so each step frees a fraction of the largest table.
 */
export const DROPPED_CONTENT_TABLES = [
  'prompt_batches', 'tool_calls', 'responses', 'transcript_parser_state_chunks', 'prompt_key_owners',
  'view_visible', 'view_checkpoint_chunks', 'view_checkpoints', 'view_key_owners', 'view_prompts', 'view_responses', 'view_tool_calls',
  'view_plans', 'view_content_proofs', 'view_findings', 'fact_classes', 'plan_promotions',
  'view_prompts_fts', 'view_responses_fts', 'view_plans_fts', 'material_versions', 'view_publication_material', 'view_build_work',
  'view_legacy_ack_feed', 'view_flip_calibrations', 'view_work_samples', 'learning_init_queue', 'cutover_progress',
  'prompt_batches_fts', 'responses_fts', 'session_views', 'view_instances',
] as const;

/** Every trigger standing on a dropped table at step 264. */
const DROPPED_CONTENT_TRIGGERS: readonly string[] = [
  'prompt_batches_fts_ad', 'prompt_batches_fts_ai', 'prompt_batches_fts_au', 'prompt_batches_legacy_class_insert', 'prompt_batches_legacy_class_update',
  'prompt_batches_search_blob_ai', 'prompt_batches_search_blob_au', 'prompt_batches_session_read_delete', 'prompt_batches_session_read_insert',
  'prompt_batches_session_read_update', 'prompt_processed_reference_delete', 'prompt_processed_reference_insert', 'prompt_processed_reference_update',
  'response_processed_reference_delete', 'response_processed_reference_insert', 'response_processed_reference_update',
  'responses_fts_ad', 'responses_fts_ai', 'responses_fts_au', 'responses_legacy_class_insert', 'responses_legacy_class_update',
  'responses_search_blob_ai', 'responses_search_blob_au', 'tool_calls_bundle_cleanup_queue', 'tool_calls_cleanup_queue', 'tool_calls_content_revision',
  'tool_calls_legacy_class_insert', 'tool_calls_legacy_class_update', 'tool_input_processed_reference_delete', 'tool_input_processed_reference_insert',
  'tool_input_processed_reference_update', 'tool_output_processed_reference_delete', 'tool_output_processed_reference_insert',
  'tool_output_processed_reference_update', 'view_plans_fts_ad', 'view_plans_fts_ai', 'view_plans_fts_au', 'view_prompts_fts_ad', 'view_prompts_fts_ai',
  'view_prompts_fts_au', 'view_responses_fts_ad', 'view_responses_fts_ai', 'view_responses_fts_au',
];

/** Every secondary index on a dropped table at step 264, by table; the two widest tables lose one index per step. */
const DROPPED_CONTENT_INDEXES: Readonly<Record<string, readonly string[]>> = {
  tool_calls: ['idx_tool_calls_activity', 'idx_tool_calls_input_blob_key', 'idx_tool_calls_output_blob_key', 'idx_tool_calls_prompt', 'idx_tool_calls_session', 'idx_tool_calls_tool'],
  view_tool_calls: ['idx_view_tool_calls_bundle', 'idx_view_tool_calls_created', 'idx_view_tool_calls_identity', 'idx_view_tool_calls_input_blob_key',
    'idx_view_tool_calls_output_blob_key', 'idx_view_tool_calls_prompt', 'idx_view_tool_calls_record', 'idx_view_tool_calls_session', 'idx_view_tool_calls_tool', 'idx_view_tool_calls_window'],
  prompt_batches: ['idx_prompt_batches_blob_key', 'idx_prompt_batches_claimed', 'idx_prompt_batches_first', 'idx_prompt_batches_parent', 'idx_prompt_batches_search_blob',
    'idx_prompt_batches_session', 'idx_prompt_batches_turns', 'idx_prompt_batches_unprocessed', 'idx_prompt_batches_user_received'],
  responses: ['idx_responses_blob_key', 'idx_responses_prompt', 'idx_responses_search_blob', 'idx_responses_session'],
  view_prompts: ['idx_view_prompt_source', 'idx_view_prompts_blob_key', 'idx_view_prompts_children', 'idx_view_prompts_claimed', 'idx_view_prompts_created', 'idx_view_prompts_identity',
    'idx_view_prompts_origin', 'idx_view_prompts_prompt', 'idx_view_prompts_received', 'idx_view_prompts_record', 'idx_view_prompts_session', 'idx_view_prompts_source_range', 'idx_view_prompts_window'],
  view_responses: ['idx_view_responses_blob_key', 'idx_view_responses_created', 'idx_view_responses_identity', 'idx_view_responses_prompt', 'idx_view_responses_record', 'idx_view_responses_session'],
  view_plans: ['idx_view_plans_blob_key', 'idx_view_plans_created', 'idx_view_plans_identity', 'idx_view_plans_project_updated', 'idx_view_plans_prompt', 'idx_view_plans_prompt_updated',
    'idx_view_plans_record', 'idx_view_plans_session', 'idx_view_plans_updated', 'idx_view_plans_updated_deployment'],
  view_instances: ['idx_view_active_leases', 'idx_view_instances_parent', 'idx_view_instances_retired', 'idx_view_stale'],
  session_views: ['idx_session_views_building', 'idx_session_views_live'],
  view_visible: ['idx_view_visible_session'],
  view_checkpoints: ['idx_view_checkpoints_ordinal', 'idx_view_checkpoints_session'],
  view_checkpoint_chunks: ['idx_view_checkpoint_chunks_session'],
  view_key_owners: ['idx_view_key_owners_session'],
  view_content_proofs: ['idx_view_content_proofs_blob', 'idx_view_content_proofs_session'],
  view_findings: ['idx_view_findings_session'],
  fact_classes: ['idx_fact_classes_session'],
  plan_promotions: ['idx_plan_promotions_session', 'idx_view_promotions_pending'],
  material_versions: ['idx_material_versions_fact_record'],
  view_legacy_ack_feed: ['idx_view_ack_tail'],
  view_build_work: ['idx_view_aging', 'idx_view_build_instance', 'idx_view_due', 'idx_view_ready', 'idx_view_yielded'],
};
const ONE_INDEX_PER_STEP = ['tool_calls', 'view_tool_calls'];
const ONE_TABLE_PER_STEP = ['prompt_batches', 'responses', 'view_prompts', 'view_responses', 'view_plans'];

export const DROP_RANGES_TABLE = '_v265_drop_ranges';
/** Rows leave in `parts` rowid ranges of the MAX(rowid) recorded at step 265. */
const RANGE_SOURCES = [
  { table: 'tool_calls', parts: 64 }, { table: 'view_tool_calls', parts: 64 }, { table: 'responses', parts: 8 }, { table: 'prompt_batches', parts: 4 },
  { table: 'view_prompts', parts: 4 }, { table: 'view_responses', parts: 4 }, { table: 'fact_classes', parts: 4 }, { table: 'material_versions', parts: 4 },
] as const;
const range = (table: string, parts: number, partition: number) => {
  const limit = `(SELECT high FROM ${DROP_RANGES_TABLE} WHERE source='${table}')`;
  return `rowid > (${limit} / ${parts}) * ${partition}${partition === parts - 1 ? '' : ` AND rowid <= (${limit} / ${parts}) * ${partition + 1}`}`;
};
const SEARCH_TABLES = ['prompt_batches_fts', 'responses_fts', 'view_prompts_fts', 'view_responses_fts', 'view_plans_fts'];
const EMPTIED_TABLES = [...RANGE_SOURCES.map(({ table }) => table), 'view_content_proofs'];
/** The small tables, each ahead of every table it references; `view_instances` last. */
const SMALL_TABLES = [
  'transcript_parser_state_chunks', 'prompt_key_owners', 'plan_promotions', 'view_publication_material', 'view_legacy_ack_feed', 'view_flip_calibrations',
  'view_work_samples', 'learning_init_queue', 'cutover_progress', 'view_visible', 'view_checkpoint_chunks', 'view_checkpoints', 'view_key_owners',
  'view_plans', 'view_findings', 'view_build_work', 'session_views', 'view_instances',
];
const dropIndexes = (tables: readonly string[]) => tables.flatMap((table) => DROPPED_CONTENT_INDEXES[table]!.map((index) => `DROP INDEX IF EXISTS ${index}`));
const dropTables = (tables: readonly string[]) => tables.map((table) => `DROP TABLE IF EXISTS ${table}`);

const steps: readonly (readonly string[])[] = [
  [
    ...DROPPED_CONTENT_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name}`),
    `CREATE TABLE IF NOT EXISTS ${DROP_RANGES_TABLE} (source TEXT PRIMARY KEY,high INTEGER NOT NULL) WITHOUT ROWID`,
    ...RANGE_SOURCES.map(({ table }) => `INSERT INTO ${DROP_RANGES_TABLE} SELECT '${table}',COALESCE(MAX(rowid),0) FROM ${table}`),
  ],
  ...ONE_INDEX_PER_STEP.flatMap((table) => dropIndexes([table]).map((sql) => [sql])),
  ...ONE_TABLE_PER_STEP.map((table) => dropIndexes([table])),
  dropIndexes(Object.keys(DROPPED_CONTENT_INDEXES).filter((table) => !ONE_INDEX_PER_STEP.includes(table) && !ONE_TABLE_PER_STEP.includes(table))),
  ...RANGE_SOURCES.flatMap(({ table, parts }) => Array.from({ length: parts }, (_, partition) => [`DELETE FROM ${table} WHERE ${range(table, parts, partition)}`])),
  ...SEARCH_TABLES.map((table) => dropTables([table])),
  ...EMPTIED_TABLES.map((table) => dropTables([table])),
  [...dropTables(SMALL_TABLES), `DROP TABLE IF EXISTS ${DROP_RANGES_TABLE}`],
];

export const DROP_CONTENT_SCHEMA_STEPS = steps.map((statements, index) => ({ version: 265 + index, statements }));
