/** Canonical fact and instance storage for each material kind. */
export const MATERIALS = {
  prompt:{ kind:'prompt',fact:'prompt_batches',table:'view_prompts',id:'prompt_id',blobs:['blob_key'],fts:['text'] },
  response:{ kind:'response',fact:'responses',table:'view_responses',id:'response_id',blobs:['blob_key'],fts:['text'] },
  tool:{ kind:'tool',fact:'tool_calls',table:'view_tool_calls',id:'tool_call_id',blobs:['input_blob_key','output_blob_key'],fts:[] },
  plan:{ kind:'plan',fact:'plans',table:'view_plans',id:'plan_key',blobs:['blob_key'],fts:['title','content'] },
} as const;
export const VIEW_MATERIALS=Object.freeze(Object.values(MATERIALS));

/** Authoritative material identities include delivered context and raw hook records. */
export const FACT_MATERIALS={
  ...MATERIALS,
  attachment:{kind:'attachment',fact:'attachments',id:'attachment_id'},
  injection:{kind:'injection',fact:'spore_injections',id:'id'},
  answer:{kind:'answer',fact:'prompt_context_answers',id:'id'},
  'session-record':{kind:'session-record',fact:'session_injections',id:'kind'},
  event:{kind:'event',fact:'events',id:'event_id'},
} as const;
export type MaterialKind=keyof typeof FACT_MATERIALS;

export const CONTEXT_MATERIAL_COLUMNS={
  injection:['id','prompt_id','scope_reason','ask_protocol','asked_at','prompt_hash','spore_ids','plan_ids','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  answer:['id','prompt_id','scope_reason','ask_protocol','asked_at','receipt_id','outcome','context_chars','parts','skipped','failures','selection','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  'session-record':['kind','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  attachment:['attachment_id','prompt_id','blob_key','media_type','byte_size','description','origin_path','created_at'],
  event:['event_id','kind','payload','created_at'],
} as const;

export const MATERIAL_COLUMNS={
  prompt:['prompt_id','parent_prompt_id','thread_id','thread_label','origin','prompt_kind','text','blob_key','content_hash','created_at','updated_at','ended_at','received_at','claim','source_key','source_thread','source_record','prompt_key_hash'],
  response:['response_id','prompt_id','text','blob_key','content_hash','created_at','received_at'],
  tool:['tool_call_id','prompt_id','tool_name','myco_tool','myco_op','input','input_blob_key','input_bytes','output_preview','output_blob_key','success','error_message','result_reason','duration_ms','files_affected','canopy_injection_tokens','created_at','received_at','call_source','outcome_source'],
  plan:['plan_key','prompt_id','title','content','blob_key','content_hash','status','origin_path','source','created_at','updated_at','received_at','source_tag','source_coordinate','tags_json'],
} satisfies Record<keyof typeof MATERIALS,readonly string[]>;

/** Session-owned rows in child-before-header deletion order. */
export const VIEW_SESSION_TABLES = [
  'view_publication_material', 'view_legacy_ack_feed', 'view_build_work', 'view_work_samples', 'material_versions', 'learning_sessions',
  'view_visible', 'session_views', 'view_checkpoint_chunks', 'view_checkpoints', 'view_key_owners',
  ...VIEW_MATERIALS.map(material => material.table), 'view_content_proofs', 'view_findings',
  'fact_classes', 'plan_promotions', 'view_instances',
] as const;

/** Additive facts survive regeneration of an instance. */
export const VIEW_FACT_TABLES = ['fact_classes', 'plan_promotions'] as const;
export const VIEW_GLOBAL_TABLES=['view_flip_calibrations'] as const;

export const VIEW_DURABLE_TABLES = ['learning_sessions', 'material_versions'] as const;

/** Regenerable instance storage is excluded from additive artifacts. */
export const VIEW_REGENERABLE_TABLES = [...VIEW_SESSION_TABLES.filter(table =>
  !(VIEW_FACT_TABLES as readonly string[]).includes(table) && !(VIEW_DURABLE_TABLES as readonly string[]).includes(table)),...VIEW_GLOBAL_TABLES];

export const VIEW_FTS_TABLES = VIEW_MATERIALS.filter(material => material.fts.length > 0)
  .map(material => `${material.table}_fts`);

export const VIEW_BLOB_REFERENCES = [
  ...VIEW_MATERIALS.flatMap(material => material.blobs.map(column => ({ table: material.table, column }))),
  { table: 'view_content_proofs', column: 'blob_key' },
];
