/** Physical storage of parser instances, including sources that are not visible. */
export const VIEW_MATERIALS = [
  { table: 'view_prompts', id: 'prompt_id', blobs: ['blob_key'], fts: ['text'] },
  { table: 'view_responses', id: 'response_id', blobs: ['blob_key'], fts: ['text'] },
  { table: 'view_tool_calls', id: 'tool_call_id', blobs: ['input_blob_key', 'output_blob_key'], fts: [] },
  { table: 'view_plans', id: 'plan_key', blobs: ['blob_key'], fts: ['title', 'content'] },
] as const;

/** Session-owned rows in child-before-header deletion order. */
export const VIEW_SESSION_TABLES = [
  'view_visible', 'session_views', 'view_checkpoint_chunks', 'view_checkpoints', 'view_key_owners',
  ...VIEW_MATERIALS.map(material => material.table), 'view_content_proofs', 'view_findings',
  'fact_classes', 'plan_promotions', 'view_instances',
] as const;

/** Additive facts survive regeneration of an instance. */
export const VIEW_FACT_TABLES = ['fact_classes', 'plan_promotions'] as const;

/** Regenerable storage is excluded from additive artifacts. */
export const VIEW_REGENERABLE_TABLES = VIEW_SESSION_TABLES.filter(table =>
  !(VIEW_FACT_TABLES as readonly string[]).includes(table));

export const VIEW_FTS_TABLES = VIEW_MATERIALS.filter(material => material.fts.length > 0)
  .map(material => `${material.table}_fts`);

export const VIEW_BLOB_REFERENCES = [
  ...VIEW_MATERIALS.flatMap(material => material.blobs.map(column => ({ table: material.table, column }))),
  { table: 'view_content_proofs', column: 'blob_key' },
];
