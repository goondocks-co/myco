/** Canonical note data; embedding progress is independent of editorial state. */
const STATE_FIELDS = [
  ['id','id'], ['agentId','agent_id'], ['sessionId','session_id'], ['promptId','prompt_id'],
  ['observationType','observation_type'], ['status','status'], ['revision','revision'], ['content','content'],
  ['context','context'], ['importance','importance'], ['filePath','file_path'], ['tags','tags'],
  ['contentHash','content_hash'], ['properties','properties'], ['author','author'],
  ['provenanceKind','provenance_kind'], ['provenanceRef','provenance_ref'], ['agentLine','agent_line'],
  ['createdAt','created_at'], ['observedAt','observed_at'], ['updatedAt','updated_at'],
] as const;

const state = (value: (key: string, column: string) => string): string =>
  `json_object(${STATE_FIELDS.flatMap(([key,column]) => [`'${key}'`,value(key,column)]).join(',')})`;

export const sporeStateSql = (row: string): string => state((_key,column) => `${row}.${column}`);
/** Compare stored values independently of the store's JSON number rendering. */
export const sameSporeStateSql = (expected: string, actual: string): string => `(${expected} IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM json_each(${expected}) held WHERE json_type(${actual},'$."'||held.key||'"') IS NULL
    OR json_extract(${actual},'$."'||held.key||'"') IS NOT held.value) AND NOT EXISTS (
  SELECT 1 FROM json_each(${actual}) current WHERE json_type(${expected},'$."'||current.key||'"') IS NULL))`;
const writtenState = (value: string): string => state(key => {
  if (key === 'status') return "'active'";
  if (key === 'revision') return '0';
  if (key === 'importance') return `COALESCE(json_extract(${value},'$.importance'),5)`;
  return `json_extract(${value},'$.${key}')`;
});

const heldSource = sporeStateSql('s');
const legacyRevision = `(SELECT COUNT(*) FROM resolution_events history INDEXED BY idx_resolution_events_spore
  WHERE history.project_id=e.project_id AND history.spore_id=e.spore_id)`;
const originalSource = `json_set(${heldSource},'$.status','active','$.revision',MAX(0,${legacyRevision}-1),'$.updatedAt',NULL)`;
const sourceAt = (role: string, revision: string, at: string) =>
  `json_set(${heldSource},'$.status',CASE WHEN ${role}='retired' THEN 'obsolete' ELSE 'consolidated' END,'$.revision',${revision},'$.updatedAt',${at})`;

/** Indexed successor links name legacy merge units; checked answers name multi-output units. */
export const CURATION_HISTORY_BACKFILL: readonly string[] = [
  `INSERT INTO spore_curation_units(project_id,id,kind,source_run_id,cluster_key,created_at,member_count,unavailable)
    SELECT a.project_id,a.run_id,'answer',a.run_id,a.cluster_key,COALESCE(w.decided_at,0),json_array_length(a.answer,'$.members')-json_array_length(a.answer,'$.answer.keep')+json_array_length(a.answer,'$.notes'),CASE WHEN w.decided_at IS NULL THEN 'answer_history_missing' END
    FROM spore_curation_answers a LEFT JOIN spore_curation_work w ON w.project_id=a.project_id AND w.cluster_key=a.cluster_key
    WHERE a.applied=1 AND a.answer IS NOT NULL AND (json_array_length(a.answer,'$.notes')>0 OR json_array_length(a.answer,'$.answer.retire')>0)
    ON CONFLICT(project_id,id) DO NOTHING`,
  `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT u.project_id,u.id,json_extract(m.value,'$.id'),
      CASE WHEN EXISTS(SELECT 1 FROM json_each(a.answer,'$.answer.retire') r WHERE json_extract(r.value,'$.id')=json_extract(m.value,'$.id')) THEN 'retired' ELSE 'source' END,
      json_set(${heldSource},'$.status','active','$.revision',json_extract(m.value,'$.revision'),'$.updatedAt',NULL),
      ${sourceAt("CASE WHEN EXISTS(SELECT 1 FROM json_each(a.answer,'$.answer.retire') r WHERE json_extract(r.value,'$.id')=json_extract(m.value,'$.id')) THEN 'retired' ELSE 'source' END", "json_extract(m.value,'$.revision')+1", 'u.created_at')}
    FROM spore_curation_units u JOIN spore_curation_answers a ON a.project_id=u.project_id AND a.run_id=u.id,
      json_each(a.answer,'$.members') m LEFT JOIN spores s ON s.project_id=u.project_id AND s.id=json_extract(m.value,'$.id')
    WHERE u.kind='answer' AND (EXISTS(SELECT 1 FROM json_each(a.answer,'$.answer.retire') r WHERE json_extract(r.value,'$.id')=json_extract(m.value,'$.id'))
      OR EXISTS(SELECT 1 FROM json_each(a.answer,'$.answer.notes') n, json_each(n.value,'$.sources') x WHERE x.value=json_extract(m.value,'$.id')))
    ON CONFLICT(project_id,unit_id,spore_id) DO NOTHING`,
  `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT u.project_id,u.id,json_extract(n.value,'$.id'),'output',NULL,${writtenState('n.value')}
    FROM spore_curation_units u JOIN spore_curation_answers a ON a.project_id=u.project_id AND a.run_id=u.id,
      json_each(a.answer,'$.notes') n WHERE u.kind='answer'
    ON CONFLICT(project_id,unit_id,spore_id) DO NOTHING`,
  `INSERT INTO spore_curation_units(project_id,id,kind,created_at,member_count,unavailable)
    SELECT s.project_id,s.id,'legacy',s.created_at,1+(SELECT COUNT(DISTINCT e.spore_id) FROM resolution_events e INDEXED BY idx_resolution_events_successor WHERE e.project_id=s.project_id AND e.new_spore_id=s.id AND e.action='consolidate'),CASE WHEN s.observed_at IS NOT NULL THEN 'answer_history_missing'
      WHEN s.status='active' AND s.revision=0 AND s.updated_at IS NOT NULL AND s.updated_at<>s.created_at THEN 'legacy_note_changed'
      WHEN EXISTS(SELECT 1 FROM resolution_events e INDEXED BY idx_resolution_events_successor
        JOIN resolution_events other INDEXED BY idx_resolution_events_spore ON other.project_id=e.project_id AND other.spore_id=e.spore_id
        WHERE e.project_id=s.project_id AND e.new_spore_id=s.id AND e.action='consolidate'
          AND other.action='consolidate' AND other.new_spore_id IS NOT s.id) THEN 'legacy_lineage_conflict' END
    FROM spores s WHERE EXISTS(SELECT 1 FROM resolution_events e INDEXED BY idx_resolution_events_successor
      WHERE e.project_id=s.project_id AND e.new_spore_id=s.id AND e.action='consolidate')
      AND NOT EXISTS(SELECT 1 FROM spore_curation_unit_members m WHERE m.project_id=s.project_id AND m.spore_id=s.id AND m.role='output')
    ON CONFLICT(project_id,id) DO NOTHING`,
  `INSERT INTO spore_curation_units(project_id,id,kind,created_at,member_count,unavailable)
    SELECT s.project_id,e.new_spore_id,'legacy',MIN(e.created_at),COUNT(DISTINCT s.id)+1,'output_missing'
    FROM spores s CROSS JOIN resolution_events e INDEXED BY idx_resolution_events_spore ON e.project_id=s.project_id AND e.spore_id=s.id
    WHERE e.action='consolidate' AND e.new_spore_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM spores target WHERE target.project_id=e.project_id AND target.id=e.new_spore_id)
    GROUP BY s.project_id,e.new_spore_id ON CONFLICT(project_id,id) DO NOTHING`,
  `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT u.project_id,u.id,u.id,'output',NULL,json_set(${heldSource},'$.id',u.id,'$.status','active','$.revision',0,'$.updatedAt',CASE WHEN s.status='active' AND s.revision=0 THEN s.updated_at END)
    FROM spore_curation_units u LEFT JOIN spores s ON s.project_id=u.project_id AND s.id=u.id WHERE u.kind='legacy'
    ON CONFLICT(project_id,unit_id,spore_id) DO NOTHING`,
  `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT u.project_id,u.id,e.spore_id,'source',${originalSource},${sourceAt("'source'", legacyRevision, 's.updated_at')}
    FROM spore_curation_units u JOIN resolution_events e INDEXED BY idx_resolution_events_successor ON e.project_id=u.project_id AND e.new_spore_id=u.id
      LEFT JOIN spores s ON s.project_id=e.project_id AND s.id=e.spore_id WHERE u.kind='legacy' AND e.action='consolidate'
    ON CONFLICT(project_id,unit_id,spore_id) DO NOTHING`,
  `UPDATE spore_curation_unit_members AS child SET before_json=(SELECT parent.after_json FROM spore_curation_unit_members parent
      WHERE parent.project_id=child.project_id AND parent.spore_id=child.spore_id AND parent.role='output')
    WHERE child.role<>'output' AND json_extract(child.before_json,'$.updatedAt') IS NULL
      AND EXISTS(SELECT 1 FROM spore_curation_unit_members parent WHERE parent.project_id=child.project_id AND parent.spore_id=child.spore_id
        AND parent.role='output' AND ${sameSporeStateSql("json_remove(child.before_json,'$.updatedAt')", "json_remove(parent.after_json,'$.updatedAt')")})`,
];

/** An undone creator unit no longer replaces its restored source through this edge. */
export const currentCurationEdgeSql = (project: string, source: string, target: string, action: string): string => `(${action}<>'consolidate' OR NOT EXISTS (
  SELECT 1 FROM spore_curation_unit_members o JOIN spore_curation_units u ON u.project_id=o.project_id AND u.id=o.unit_id
  WHERE o.project_id=${project} AND o.spore_id=${target} AND o.role='output' AND u.undone_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM spore_curation_unit_members m WHERE m.project_id=u.project_id AND m.unit_id=u.id AND m.spore_id=${source} AND m.role='source')))`;
