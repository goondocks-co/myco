/** Material tables whose parser rows are classified as the legacy derivation. */
export const LEGACY_CLASS_TABLES = [
  { table: 'prompt_batches', id: 'prompt_id' },
  { table: 'responses', id: 'response_id' },
  { table: 'tool_calls', id: 'tool_call_id' },
  { table: 'plans', id: 'plan_key' },
] as const;
type ClassTable = (typeof LEGACY_CLASS_TABLES)[number]['table'];

const parseEvent = (row: string): string =>
  `EXISTS(SELECT 1 FROM events e WHERE e.project_id=${row}.project_id AND e.event_id=${row}.event_id AND e.producer_adapter='transcript-parse')`;

/** A row is the legacy derivation when its current event is a parse event; a plan also carries no edit evidence. */
export function legacyRowSql(table: ClassTable, row: string): string {
  if (table !== 'plans') return parseEvent(row);
  return `${parseEvent(row)} AND ${row}.source='tag' AND ${row}.origin_path LIKE 'transcript:%' AND ${row}.updated_by IS NULL
    AND ${row}.status='active' AND NOT EXISTS(SELECT 1 FROM tags t WHERE t.project_id=${row}.project_id AND t.entity_kind='plan'
      AND t.entity_id=${row}.plan_key AND t.tag<>substr(${row}.origin_path,12))`;
}

/** A row whose event is missing is kept as an unverified fact. */
export function unverifiedRowSql(row: string): string {
  return `NOT EXISTS(SELECT 1 FROM events e WHERE e.project_id=${row}.project_id AND e.event_id=${row}.event_id)`;
}

export const CLASSIFIED_AT_SQL = `CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`;

/** A class row is written only beside its session's row and in place of no other class, so the write cannot fail the material write that fired it. */
const classifiable = (table: ClassTable, id: string): string =>
  ` AND EXISTS(SELECT 1 FROM sessions s WHERE s.project_id=r.project_id AND s.session_id=r.session_id)
      AND NOT EXISTS(SELECT 1 FROM fact_classes f WHERE f.project_id=r.project_id AND f.table_name='${table}' AND f.record_id=r.${id})`;

/** One row's legacy class follows its current state: removed, then written again when it still qualifies. */
function reclassify(table: ClassTable, id: string, project: string, record: string, guarded: boolean): string {
  return `DELETE FROM fact_classes WHERE project_id=${project} AND table_name='${table}' AND record_id=${record} AND class='legacy';
    INSERT OR IGNORE INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
      SELECT r.project_id,'${table}',r.${id},r.session_id,'legacy',${CLASSIFIED_AT_SQL} FROM ${table} r
      WHERE r.project_id=${project} AND r.${id}=${record} AND ${legacyRowSql(table, 'r')}${guarded ? classifiable(table, id) : ''};`;
}

const updatedColumns: Record<ClassTable, string> = {
  prompt_batches: 'event_id',
  responses: 'event_id',
  tool_calls: 'event_id',
  plans: 'event_id,status,updated_by,source,origin_path',
};

/** A published session's classification is final; only unpublished rows follow later edits. */
const unpublished = (project: string, session: string): string =>
  `NOT EXISTS(SELECT 1 FROM session_views sv WHERE sv.project_id=${project} AND sv.session_id=${session}
    AND sv.legacy IN ('published','cleaning','gone'))`;
const planUnpublished = (project: string, key: string): string =>
  `NOT EXISTS(SELECT 1 FROM plans p JOIN session_views sv ON sv.project_id=p.project_id AND sv.session_id=p.session_id
    WHERE p.project_id=${project} AND p.plan_key=${key} AND sv.legacy IN ('published','cleaning','gone'))`;

/** Every parser row classified at insert, and unpublished rows reclassified on any change to their class evidence. */
export function legacyClassTriggers(guarded: boolean): string[] {
  return [
    ...LEGACY_CLASS_TABLES.flatMap(({ table, id }) => [
      `CREATE TRIGGER IF NOT EXISTS ${table}_legacy_class_insert AFTER INSERT ON ${table}
    BEGIN ${reclassify(table, id, 'NEW.project_id', 'NEW.' + id, guarded)} END`,
      `CREATE TRIGGER IF NOT EXISTS ${table}_legacy_class_update AFTER UPDATE OF ${updatedColumns[table]} ON ${table}
    WHEN ${unpublished('NEW.project_id', 'NEW.session_id')} BEGIN ${reclassify(table, id, 'NEW.project_id', 'NEW.' + id, guarded)} END`,
    ]),
    `CREATE TRIGGER IF NOT EXISTS tags_plan_legacy_class_insert AFTER INSERT ON tags
    WHEN NEW.entity_kind='plan' AND ${planUnpublished('NEW.project_id', 'NEW.entity_id')} BEGIN ${reclassify('plans', 'plan_key', 'NEW.project_id', 'NEW.entity_id', guarded)} END`,
    `CREATE TRIGGER IF NOT EXISTS tags_plan_legacy_class_delete AFTER DELETE ON tags
    WHEN OLD.entity_kind='plan' AND ${planUnpublished('OLD.project_id', 'OLD.entity_id')} BEGIN ${reclassify('plans', 'plan_key', 'OLD.project_id', 'OLD.entity_id', guarded)} END`,
  ];
}

/** Cutover progress and the legacy classification triggers. */
export const V106_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cutover_progress (id INTEGER PRIMARY KEY CHECK(id=1),
    classify_stage INTEGER NOT NULL DEFAULT 0 CHECK(classify_stage BETWEEN 0 AND ${LEGACY_CLASS_TABLES.length}),
    classify_after INTEGER NOT NULL DEFAULT 0,classified_at INTEGER,sweep_after INTEGER NOT NULL DEFAULT 0,swept_at INTEGER,
    paused_reason TEXT CHECK(paused_reason IS NULL OR paused_reason='d1_headroom'),database_bytes INTEGER,observed_at INTEGER,
    updated_at INTEGER NOT NULL)`,
  ...legacyClassTriggers(false),
];
