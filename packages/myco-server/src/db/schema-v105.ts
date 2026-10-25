import { VIEW_MATERIALS } from './view-tables.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;
const session = 'FOREIGN KEY(project_id,session_id) REFERENCES sessions(project_id,session_id)';
const projectOwner = 'FOREIGN KEY(project_id) REFERENCES projects(project_id)';

/** Instance storage must be empty before its indexed writer extensions are installed. */
export const V105_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _v105_empty (ok INTEGER NOT NULL CHECK(ok=1))`,
  `INSERT INTO _v105_empty SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM view_instances) THEN 1 ELSE 0 END`,
  ...VIEW_MATERIALS.flatMap(({ table }) => [
    `ALTER TABLE ${table} ADD COLUMN material_seq INTEGER CHECK(material_seq IS NULL OR material_seq>0)`,
    `ALTER TABLE ${table} ADD COLUMN view_content_hash TEXT`,
    `ALTER TABLE ${table} ADD COLUMN hash_scheme TEXT`,
    `ALTER TABLE ${table} ADD COLUMN canonical_identity TEXT`,
  ]),
  `ALTER TABLE view_tool_calls ADD COLUMN outcome_source TEXT`,
  `ALTER TABLE view_tool_calls ADD COLUMN call_source TEXT`,
  `ALTER TABLE view_plans ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`,
  ...[
    'parsed_at INTEGER',
    'parser_version INTEGER',
    'fidelity TEXT',
    'parse_segment_lines INTEGER',
    'prompt_generation INTEGER',
    'parse_failed_at INTEGER',
  ].map((column) => `ALTER TABLE view_checkpoints ADD COLUMN ${column}`),
  `CREATE TABLE IF NOT EXISTS learning_sessions (${project},session_id TEXT NOT NULL,next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq>0),
    max_seq INTEGER NOT NULL DEFAULT 0 CHECK(max_seq>=0),revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,session_id),${projectOwner})`,
  `CREATE TABLE IF NOT EXISTS material_versions (${project},session_id TEXT NOT NULL,kind TEXT NOT NULL,identity TEXT NOT NULL,
    record_id TEXT NOT NULL,content_hash TEXT NOT NULL,hash_scheme TEXT NOT NULL,owner TEXT NOT NULL DEFAULT 'view' CHECK(owner IN ('view','fact')),material_seq INTEGER NOT NULL CHECK(material_seq>0),
    PRIMARY KEY(project_id,session_id,kind,identity),UNIQUE(project_id,session_id,material_seq),${projectOwner})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_material_versions_fact_record ON material_versions(project_id,session_id,kind,record_id) WHERE owner='fact'`,
  `CREATE TABLE IF NOT EXISTS view_publication_material (${project},session_id TEXT NOT NULL,attempt_id TEXT NOT NULL,kind TEXT NOT NULL,
    identity TEXT NOT NULL,record_id TEXT NOT NULL,content_hash TEXT NOT NULL,hash_scheme TEXT NOT NULL,owner TEXT NOT NULL DEFAULT 'view' CHECK(owner IN ('view','fact')),ord INTEGER NOT NULL,
    material_seq INTEGER,PRIMARY KEY(project_id,session_id,attempt_id,kind,identity),${projectOwner})`,
  `CREATE TABLE IF NOT EXISTS view_build_work (${project},session_id TEXT NOT NULL,instance_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready',
    tier INTEGER NOT NULL,recent_until INTEGER NOT NULL DEFAULT 0,session_created_at INTEGER NOT NULL,last_service_at INTEGER NOT NULL DEFAULT 0,
    service_ms INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,classification_complete INTEGER NOT NULL DEFAULT 0,
    coverage_complete INTEGER NOT NULL DEFAULT 0,receipts_complete INTEGER NOT NULL DEFAULT 0,legacy_ack_watermark INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,session_id),FOREIGN KEY(project_id,session_id,instance_id) REFERENCES view_instances(project_id,session_id,instance_id))`,
  `CREATE TABLE IF NOT EXISTS view_legacy_ack_feed (ack_seq INTEGER PRIMARY KEY AUTOINCREMENT,${project},session_id TEXT NOT NULL,
    ack_id TEXT NOT NULL,UNIQUE(project_id,ack_id),${session})`,
  `CREATE TABLE IF NOT EXISTS view_flip_calibrations (store TEXT NOT NULL,profile TEXT NOT NULL,source_digest TEXT NOT NULL,
    source TEXT NOT NULL,observed_at INTEGER NOT NULL,attempt_id TEXT NOT NULL,measurement TEXT NOT NULL,blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
    maximum_wall_ms REAL NOT NULL DEFAULT 0,last_observation TEXT,PRIMARY KEY(store,profile,source_digest))`,
  `CREATE TABLE IF NOT EXISTS view_work_samples (${project},session_id TEXT NOT NULL,instance_id TEXT NOT NULL,
    store TEXT,profile TEXT,started_at INTEGER NOT NULL,observed_at INTEGER,initial_bytes INTEGER NOT NULL,offered_bytes INTEGER NOT NULL,
    useful_bytes INTEGER NOT NULL DEFAULT 0,published_bytes INTEGER NOT NULL DEFAULT 0,published_at INTEGER,
    service_ms REAL NOT NULL DEFAULT 0,wake_ms REAL NOT NULL DEFAULT 0,wakes INTEGER NOT NULL DEFAULT 0,
    statements INTEGER NOT NULL DEFAULT 0,round_trips INTEGER NOT NULL DEFAULT 0,blob_calls INTEGER NOT NULL DEFAULT 0,
    observation_token TEXT,valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)),last_refusal TEXT,
    PRIMARY KEY(project_id,session_id),${session})`,
  `CREATE INDEX IF NOT EXISTS idx_view_ack_tail ON view_legacy_ack_feed(project_id,session_id,ack_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_view_build_instance ON view_build_work(project_id,session_id,instance_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_active_leases ON view_instances(state,lease_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_stale ON view_instances(parser_version,project_id,session_id,instance_id) WHERE state IN ('live','building','failed') AND base<>'frozen'`,
  `CREATE INDEX IF NOT EXISTS idx_view_ready ON view_build_work(state,tier,last_service_at,session_created_at DESC,project_id,session_id,instance_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_due ON view_build_work(state,next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_view_aging ON view_build_work(state,tier,recent_until)`,
  `CREATE INDEX IF NOT EXISTS idx_view_yielded ON view_build_work(state,last_service_at,project_id,session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_promotions_pending ON plan_promotions(project_id,session_id,state)`,
  `CREATE INDEX IF NOT EXISTS idx_view_prompt_source ON view_prompts(project_id,instance_id,claim,source_key,source_thread,source_record)`,
  ...VIEW_MATERIALS.map(
    ({ table }) =>
      `CREATE INDEX IF NOT EXISTS idx_${table}_identity ON ${table}(project_id,instance_id,canonical_identity)`,
  ),
  `DROP TABLE IF EXISTS _v105_empty`,
];
