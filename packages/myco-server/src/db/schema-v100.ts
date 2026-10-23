import { MAX_PAYLOAD_BYTES } from '../ingest/envelope.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { VIEW_MATERIALS } from './view-tables.js';

const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;
const instanceOwner = `FOREIGN KEY (project_id, session_id, instance_id)
       REFERENCES view_instances(project_id, session_id, instance_id)`;
const sessionOwner = `FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id)`;
const source = `source_transcript_id TEXT, source_offset INTEGER, source_end INTEGER,
     source_key TEXT, source_thread TEXT, source_record TEXT,
     CHECK (source_offset IS NULL OR source_offset >= 0),
     CHECK (source_end IS NULL OR source_end > source_offset)`;

function instanceTable(table: string, columns: string, key: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
     ${project}, instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
     ${columns}, PRIMARY KEY (project_id, instance_id, ${key}), ${instanceOwner})`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_session ON ${table} (project_id, session_id, instance_id)`,
  ];
}

const materialColumns = {
  view_prompts: `prompt_id TEXT NOT NULL, event_id TEXT, parent_prompt_id TEXT, thread_id TEXT, thread_label TEXT,
     origin TEXT NOT NULL, prompt_kind TEXT, text TEXT, blob_key TEXT, content_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER, token_id TEXT,
     received_at INTEGER NOT NULL, prompt_key_hash TEXT,
     claim TEXT CHECK (claim IN ('owner','reused','sibling','context'))`,
  view_responses: `response_id TEXT NOT NULL, prompt_id TEXT, event_id TEXT, text TEXT, blob_key TEXT,
     content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, token_id TEXT, received_at INTEGER NOT NULL`,
  view_tool_calls: `tool_call_id TEXT NOT NULL, prompt_id TEXT, event_id TEXT, tool_name TEXT NOT NULL,
     myco_tool TEXT, myco_op TEXT, input TEXT, input_blob_key TEXT, output_preview TEXT, output_blob_key TEXT,
     success INTEGER NOT NULL, error_message TEXT, duration_ms INTEGER, files_affected TEXT,
     canopy_injection_tokens INTEGER, created_at INTEGER NOT NULL, token_id TEXT, received_at INTEGER NOT NULL,
     input_bytes INTEGER, content_revision INTEGER NOT NULL DEFAULT 0, input_bundle_id INTEGER,
     input_bundle_entry INTEGER, result_reason TEXT`,
  view_plans: `plan_key TEXT NOT NULL, prompt_id TEXT, event_id TEXT, machine_id TEXT, title TEXT, content TEXT,
     blob_key TEXT, content_hash TEXT NOT NULL, status TEXT NOT NULL, origin_path TEXT, source TEXT,
     updated_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, token_id TEXT,
     received_at INTEGER NOT NULL, source_tag TEXT, source_coordinate TEXT`,
} as const;

/** Empty instance storage; only FTS synchronization runs on material writes. */
export const V100_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS view_instances (
     ${project}, instance_id TEXT NOT NULL, session_id TEXT NOT NULL, parser_version INTEGER NOT NULL,
     base TEXT NOT NULL CHECK (base IN ('full','tail','frozen')), parent_instance TEXT,
     state TEXT NOT NULL CHECK (state IN ('building','live','frozen','retired','failed','abandoned')),
     lease_token TEXT, lease_expires_at INTEGER, created_at INTEGER NOT NULL, published_at INTEGER,
     retired_at INTEGER, failure TEXT, PRIMARY KEY (project_id, instance_id),
     UNIQUE (project_id, session_id, instance_id), ${sessionOwner},
     FOREIGN KEY (project_id, session_id, parent_instance)
       REFERENCES view_instances(project_id, session_id, instance_id),
     CHECK ((base = 'tail' AND parent_instance IS NOT NULL) OR (base <> 'tail' AND parent_instance IS NULL)),
     CHECK (parent_instance IS NULL OR parent_instance <> instance_id))`,
  `CREATE INDEX IF NOT EXISTS idx_view_instances_parent ON view_instances (project_id, session_id, parent_instance)`,
  `CREATE INDEX IF NOT EXISTS idx_view_instances_retired ON view_instances (project_id, state, retired_at, instance_id)`,
  `CREATE TABLE IF NOT EXISTS session_views (
     ${project}, session_id TEXT NOT NULL, live_instance TEXT, fence INTEGER NOT NULL DEFAULT 0,
     building_instance TEXT, rebuild_state TEXT NOT NULL DEFAULT 'idle', failures INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER, last_failure TEXT, unrebuildable_reason TEXT,
     legacy TEXT NOT NULL CHECK (legacy IN ('live','converting','published','cleaning','gone')),
     updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id), ${sessionOwner},
     FOREIGN KEY (project_id, session_id, live_instance) REFERENCES view_instances(project_id, session_id, instance_id),
     FOREIGN KEY (project_id, session_id, building_instance) REFERENCES view_instances(project_id, session_id, instance_id))`,
  `CREATE INDEX IF NOT EXISTS idx_session_views_live ON session_views (project_id, session_id, live_instance)`,
  `CREATE INDEX IF NOT EXISTS idx_session_views_building ON session_views (project_id, session_id, building_instance)`,
  `CREATE TABLE IF NOT EXISTS view_visible (
     ${project}, instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('live','parent')), precedence INTEGER NOT NULL,
     PRIMARY KEY (project_id, instance_id), UNIQUE (project_id, session_id, role), ${instanceOwner})`,
  `CREATE INDEX IF NOT EXISTS idx_view_visible_session ON view_visible (project_id, session_id, instance_id)`,
  ...instanceTable('view_checkpoints', `transcript_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
     start_offset INTEGER NOT NULL CHECK (start_offset >= 0), parsed_offset INTEGER NOT NULL CHECK (parsed_offset >= start_offset),
     parser_context TEXT, open_prompt_id TEXT, parsed_through_at INTEGER, parse_error TEXT,
     parse_awaited_size INTEGER, lost_context INTEGER NOT NULL DEFAULT 0 CHECK (lost_context IN (0,1))`, 'transcript_id'),
  `CREATE INDEX IF NOT EXISTS idx_view_checkpoints_ordinal ON view_checkpoints (project_id, instance_id, ordinal, transcript_id)`,
  ...instanceTable('view_checkpoint_chunks', `transcript_id TEXT NOT NULL, cursor_offset INTEGER NOT NULL CHECK (cursor_offset >= 0),
     chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0), chunk_count INTEGER NOT NULL CHECK (chunk_count > chunk_index),
     payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= ${MAX_PAYLOAD_BYTES}),
     FOREIGN KEY (project_id, instance_id, transcript_id) REFERENCES view_checkpoints(project_id, instance_id, transcript_id)`, 'transcript_id, chunk_index'),
  ...instanceTable('view_key_owners', `source_key TEXT NOT NULL, source_thread TEXT NOT NULL, source_record TEXT NOT NULL,
     source_transcript_id TEXT NOT NULL, source_offset INTEGER NOT NULL CHECK (source_offset >= 0), created_at INTEGER NOT NULL`, 'source_key'),
  ...VIEW_MATERIALS.flatMap(material => [
    ...instanceTable(material.table, `${materialColumns[material.table]}, ${source}`, material.id),
    `CREATE INDEX IF NOT EXISTS idx_${material.table}_created ON ${material.table} (project_id, instance_id, created_at, ${material.id})`,
    `CREATE INDEX IF NOT EXISTS idx_${material.table}_prompt ON ${material.table} (project_id, instance_id, prompt_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${material.table}_record ON ${material.table} (project_id, ${material.id})`,
    ...material.blobs.map(column => `CREATE INDEX IF NOT EXISTS idx_${material.table}_${column} ON ${material.table} (project_id, ${column}) WHERE ${column} IS NOT NULL`),
  ]),
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_children ON view_prompts (project_id, instance_id, parent_prompt_id, created_at, prompt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_origin ON view_prompts (project_id, instance_id, origin, created_at, prompt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_received ON view_prompts (project_id, instance_id, origin, received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_window ON view_prompts (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_claimed ON view_prompts (project_id, created_at) WHERE claim IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_view_tool_calls_window ON view_tool_calls (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_tool_calls_tool ON view_tool_calls (project_id, tool_name, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_tool_calls_bundle ON view_tool_calls (project_id, input_bundle_id) WHERE input_bundle_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_view_plans_updated ON view_plans (project_id, instance_id, updated_at, plan_key)`,
  `CREATE INDEX IF NOT EXISTS idx_view_plans_project_updated ON view_plans (project_id, updated_at, plan_key)`,
  `CREATE INDEX IF NOT EXISTS idx_view_plans_updated_deployment ON view_plans (updated_at, plan_key)`,
  `CREATE INDEX IF NOT EXISTS idx_view_plans_prompt_updated ON view_plans (project_id, instance_id, prompt_id, updated_at)`,
  ...instanceTable('view_content_proofs', `kind TEXT NOT NULL CHECK (kind IN ('prompt','response','plan','tool-input','tool-output')),
     record_id TEXT NOT NULL, blob_key TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL CHECK (size >= 0),
     verified_at INTEGER NOT NULL`, 'kind, record_id, blob_key'),
  `CREATE INDEX IF NOT EXISTS idx_view_content_proofs_blob ON view_content_proofs (project_id, blob_key) WHERE blob_key IS NOT NULL`,
  ...instanceTable('view_findings', `kind TEXT NOT NULL CHECK (kind IN ('key_reuse','fact_id_collision','promotion_unmatched','unattributed')),
     record_id TEXT NOT NULL, n INTEGER NOT NULL CHECK (n >= 0), count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0), detail TEXT`, 'kind, record_id, n'),
  `CREATE TABLE IF NOT EXISTS fact_classes (
     ${project}, table_name TEXT NOT NULL CHECK (table_name IN ('prompt_batches','responses','tool_calls','plans')),
     record_id TEXT NOT NULL, session_id TEXT NOT NULL,
     class TEXT NOT NULL CHECK (class IN ('legacy','promoted','unverified')), classified_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, table_name, record_id), ${sessionOwner})`,
  `CREATE INDEX IF NOT EXISTS idx_fact_classes_session ON fact_classes (project_id, session_id)`,
  `CREATE TABLE IF NOT EXISTS plan_promotions (
     ${project}, plan_key TEXT NOT NULL, session_id TEXT NOT NULL, instance_id TEXT,
     source_tag TEXT, source_coordinate TEXT, state TEXT NOT NULL CHECK (state IN ('pending','done')),
     editor TEXT NOT NULL, promoted_at INTEGER NOT NULL, ${source},
     PRIMARY KEY (project_id, plan_key), ${sessionOwner})`,
  `CREATE INDEX IF NOT EXISTS idx_plan_promotions_session ON plan_promotions (project_id, session_id)`,
  ...VIEW_MATERIALS.flatMap(material => {
    if (material.fts.length === 0) return [];
    const table = material.table, fts = `${table}_fts`, columns = material.fts.join(', ');
    const values = (row: string) => material.fts.map(column => `${row}.${column}`).join(', ');
    return [
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(${columns}, content='${table}', content_rowid='rowid')`,
      `CREATE TRIGGER IF NOT EXISTS ${fts}_ai AFTER INSERT ON ${table} BEGIN INSERT INTO ${fts}(rowid, ${columns}) VALUES(new.rowid, ${values('new')}); END`,
      `CREATE TRIGGER IF NOT EXISTS ${fts}_au AFTER UPDATE OF rowid, ${columns} ON ${table} BEGIN INSERT INTO ${fts}(${fts}, rowid, ${columns}) VALUES('delete', old.rowid, ${values('old')}); INSERT INTO ${fts}(rowid, ${columns}) VALUES(new.rowid, ${values('new')}); END`,
      `CREATE TRIGGER IF NOT EXISTS ${fts}_ad AFTER DELETE ON ${table} BEGIN INSERT INTO ${fts}(${fts}, rowid, ${columns}) VALUES('delete', old.rowid, ${values('old')}); END`,
    ];
  }),
];
