import { jsonKeys } from '../ddl.js';
import { assertion, refusalCode, write, type Bound } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';
import { CLEANLINESS_SQL, latestSourceOf, RELEASE_CHECK_PHASE, RELEASE_PROJECTION, RELEASE_STATE_PHASE, RELEASE_WORK_PHASE } from './schema.js';

/** A stored namespace's canonical form, the table name every writer, join and trigger uses; NULL for one no record carries. */
const canon = (namespace: string) => `CASE ${namespace} WHEN 'session' THEN 'sessions' WHEN 'sessions' THEN 'sessions' WHEN 'spore' THEN 'spores' WHEN 'spores' THEN 'spores' WHEN 'plan' THEN 'plans' WHEN 'plans' THEN 'plans' END`;
const SINGULAR = "('session','spore','plan')";
const PLURAL = "('sessions','spores','plans')";
const identityMatches = (row: string) => `${row}.identity_key=${row}.project_id||':'||${row}.namespace||':'||${row}.record_id`;
const singularOf = (canonical: string) => `substr(${canonical},1,length(${canonical})-1)`;

const stateKeys = `(${jsonKeys(['project_id', 'id'])})`;
const inStatePage = `(project_id,id) IN (SELECT project_id,id FROM ${stateKeys})`;

/** The canonical records the page's rows belong to: every row of those records competes, wherever it sits in key order. */
const pageRecords = `(SELECT DISTINCT k.project_id,${canon('k.namespace')} AS ns,k.record_id FROM ${stateKeys} p CROSS JOIN knowledge_release_state k ON k.project_id=p.project_id AND k.id=p.id
  WHERE ${canon('k.namespace')} IS NOT NULL AND ${identityMatches('k')})`;

/** The row of a record every reader answers today: the latest by checked time, then id. */
const winnerOf = (column: string) => `(SELECT w.${column} FROM knowledge_release_state w INDEXED BY idx_knowledge_release_embedding WHERE w.project_id=g.project_id AND w.namespace IN (g.ns,${singularOf('g.ns')}) AND w.record_id=g.record_id
  AND ${identityMatches('w')} ORDER BY w.checked_at DESC,w.id DESC LIMIT 1)`;

const LOSERS = `FROM ${pageRecords} g CROSS JOIN knowledge_release_state r INDEXED BY idx_knowledge_release_embedding ON r.project_id=g.project_id AND r.namespace IN (g.ns,${singularOf('g.ns')}) AND r.record_id=g.record_id
  WHERE ${identityMatches('r')} AND r.id IS NOT ${winnerOf('id')}`;

const ROW_JSON = `json_object('id',r.id,'identity_key',r.identity_key,'namespace',r.namespace,'record_id',r.record_id,'source_session_id',r.source_session_id,'source_prompt_id',r.source_prompt_id,
  'state',r.state,'confidence',r.confidence,'basis_kind',r.basis_kind,'basis_ref',r.basis_ref,'basis_sha',r.basis_sha,'release_pr_number',r.release_pr_number,'reason',r.reason,
  'evidence_json',r.evidence_json,'checked_at',r.checked_at,'created_at',r.created_at,'updated_at',r.updated_at)`;

const REPORT_COLUMNS = '(project_id,row_id,reason,namespace,record_id,state,winner_id,winner_state,row_json,reported_at)';

const reportDuplicates = write<[keys: string, now: number]>({ name: 'releaseCatchup.reportDuplicates', sql:
  `INSERT INTO release_state_unresolved ${REPORT_COLUMNS}
   SELECT r.project_id,r.id,'duplicate',r.namespace,r.record_id,r.state,${winnerOf('id')},${winnerOf('state')},${ROW_JSON},?2 ${LOSERS}
   ON CONFLICT(project_id,row_id) DO NOTHING` });

const removeLosers = write<[keys: string]>({ name: 'releaseCatchup.removeLosers', sql:
  `DELETE FROM knowledge_release_state WHERE (project_id,id) IN (SELECT r.project_id,r.id ${LOSERS})` });

const rewriteSingular = write<[keys: string]>({ name: 'releaseCatchup.rewriteSingular', sql:
  `UPDATE knowledge_release_state SET namespace=${canon('namespace')},identity_key=project_id||':'||${canon('namespace')}||':'||record_id
   WHERE ${inStatePage} AND namespace IN ${SINGULAR} AND ${identityMatches('knowledge_release_state')}
     AND NOT EXISTS (SELECT 1 FROM knowledge_release_state o WHERE o.project_id=knowledge_release_state.project_id AND o.id<>knowledge_release_state.id
       AND o.identity_key=knowledge_release_state.project_id||':'||${canon('knowledge_release_state.namespace')}||':'||knowledge_release_state.record_id)` });

/** What could not be placed stays as it is, outside the unique current key, and is named here rather than guessed at. */
const reportUnresolved = write<[keys: string, now: number]>({ name: 'releaseCatchup.reportUnresolved', sql:
  `INSERT INTO release_state_unresolved ${REPORT_COLUMNS}
   SELECT r.project_id,r.id,CASE WHEN ${canon('r.namespace')} IS NULL THEN 'unknown_namespace' WHEN NOT (${identityMatches('r')}) THEN 'identity_mismatch' ELSE 'identity_taken' END,
     r.namespace,r.record_id,r.state,NULL,NULL,${ROW_JSON},?2
   FROM ${stateKeys} p CROSS JOIN knowledge_release_state r ON r.project_id=p.project_id AND r.id=p.id
   WHERE ${canon('r.namespace')} IS NULL OR NOT (${identityMatches('r')}) OR r.namespace IN ${SINGULAR}
   ON CONFLICT(project_id,row_id) DO NOTHING` });

const evidenceSource = (row: string) => `CASE WHEN json_valid(${row}.evidence_json) THEN json_extract(${row}.evidence_json,'$.source') END`;
const evidenceField = (field: string) => `CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json,'$.${field}') END`;
const markCurrent = write<[keys: string]>({ name: 'releaseCatchup.markCurrent', sql:
  `UPDATE knowledge_release_state SET canonical=1,source_key=${evidenceField('source')},refs_fingerprint=${evidenceField('refs_fingerprint')},paths_mark=${evidenceField('paths_mark')}
   WHERE ${inStatePage} AND namespace IN ${PLURAL} AND ${identityMatches('knowledge_release_state')}` });

/** A record of session `k` whose row the session's answer would rewrite: none yet, or one that differs and is not a kept release. */
const carries = (table: string, alias: string, key: string, namespace: string) => `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${alias}.project_id=k.project_id AND ${alias}.session_id=k.record_id
  AND NOT EXISTS (SELECT 1 FROM knowledge_release_state d WHERE d.project_id=k.project_id AND d.identity_key=k.project_id||':${namespace}:'||${alias}.${key}
    AND ((d.state IS k.state AND d.confidence IS k.confidence AND d.basis_kind IS k.basis_kind AND d.basis_ref IS k.basis_ref AND d.basis_sha IS k.basis_sha
        AND d.release_pr_number IS k.release_pr_number AND COALESCE(d.source_key,${evidenceSource('d')}) IS k.source_key)
      OR (d.state='released' AND (COALESCE(d.source_key,${evidenceSource('d')}) IS NULL OR COALESCE(d.source_key,${evidenceSource('d')}) IS k.source_key)))))`;

const queuePropagation = write<[keys: string, now: number]>({ name: 'releaseCatchup.queuePropagation', sql:
  `INSERT INTO release_propagation_due(project_id,session_id,queued_at)
   SELECT k.project_id,k.record_id,?2 FROM ${stateKeys} p CROSS JOIN knowledge_release_state k ON k.project_id=p.project_id AND k.id=p.id
   WHERE k.namespace='sessions' AND k.canonical=1 AND (${carries('spores', 's', 'id', 'spores')} OR ${carries('plans', 'l', 'plan_key', 'plans')})
   ON CONFLICT(project_id,session_id) DO NOTHING` });

const bindKeys = (statement: { bind(keys: string): Bound }) => ({ bind: (keys: string) => statement.bind(keys) });
const bindKeysAt = (statement: { bind(keys: string, now: number): Bound }) => ({ bindAt: (keys: string, now: number) => statement.bind(keys, now) });

const workKeys = `(${jsonKeys(['project_id', 'session_id'])})`;
const SOURCE_TEXT = "g.capture_point||':'||g.head_sha||':'||" + CLEANLINESS_SQL;

/** A session the last check already settled stays settled, so the catch-up costs no GitHub reads for work already done. */
const seedWork = write<[keys: string]>({ name: 'releaseCatchup.seedWork', sql:
  `INSERT INTO release_work_due (project_id,session_id,point,head_sha,cleanliness,captured_at,settled_generation,final)
   SELECT k.project_id,k.session_id,g.capture_point,g.head_sha,${CLEANLINESS_SQL},g.captured_at,
     COALESCE(CASE WHEN st.source_key=${SOURCE_TEXT} AND st.refs_fingerprint=c.check_fingerprint AND (c.package_map='[]' OR st.paths_mark IS COALESCE(d.tool_calls,0)) THEN c.work_generation END,0),
     COALESCE(st.state='released' AND (st.source_key IS NULL OR st.source_key=${SOURCE_TEXT}),0)
   FROM ${workKeys} k CROSS JOIN knowledge_git_provenance g ON ${latestSourceOf('k.project_id', 'k.session_id')}
   LEFT JOIN knowledge_release_state st ON st.project_id=k.project_id AND st.identity_key=k.project_id||':sessions:'||k.session_id
   LEFT JOIN project_release_provenance c ON c.project_id=k.project_id
   LEFT JOIN session_documents d ON d.project_id=k.project_id AND d.session_id=k.session_id
   WHERE true ON CONFLICT(project_id,session_id) DO NOTHING` });

const seedCheck = write<[keys: string, now: number]>({ name: 'releaseCatchup.seedCheck', sql:
  `INSERT INTO release_check_due (project_id,next_at,revision,lease_id,lease_until)
   SELECT c.project_id,CASE WHEN c.check_requested_at>c.check_started_at THEN 0 ELSE COALESCE(c.check_started_at,0) END,c.revision,
     CASE WHEN c.check_run_id IS NOT NULL AND c.check_lease_until>?2 THEN c.check_run_id END,CASE WHEN c.check_run_id IS NOT NULL AND c.check_lease_until>?2 THEN c.check_lease_until END
   FROM (${jsonKeys(['project_id'])}) k JOIN project_release_provenance c ON c.project_id=k.project_id
   WHERE c.enabled=1 AND c.github_repo IS NOT NULL ON CONFLICT(project_id) DO NOTHING` });

const STATES_FIRST = refusalCode('release_states_not_canonical');
const statesCanonical = assertion<[]>({ name: 'releaseCatchup.statesCanonical', refusal: STATES_FIRST,
  when: `EXISTS (SELECT 1 FROM projection_catchup WHERE projection='${RELEASE_PROJECTION}' AND phase='${RELEASE_STATE_PHASE}' AND done=1)` });

const clearChecks = write<[]>({ name: 'releaseCatchup.clearChecks', sql: 'DELETE FROM release_check_due' });
const clearWork = write<[]>({ name: 'releaseCatchup.clearWork', sql: 'DELETE FROM release_work_due' });
const clearPropagation = write<[]>({ name: 'releaseCatchup.clearPropagation', sql: 'DELETE FROM release_propagation_due' });

/**
 * Builds what the reconcile reads, in order: each enabled Project's due row, one current state row per record, then one
 * work row per captured session. A rival row of a record is reported whole before it goes, and the survivor is the one
 * every reader already answers, so canonicalizing changes no answer.
 */
export const RELEASE_PROVENANCE_CATCHUP = {
  projection: RELEASE_PROJECTION,
  phases: {
    [RELEASE_CHECK_PHASE]: { source: { table: 'project_release_provenance', columns: ['project_id'], unique: true }, reconcile: [bindKeysAt(seedCheck)] },
    [RELEASE_STATE_PHASE]: {
      source: { table: 'knowledge_release_state', columns: ['project_id', 'id'], unique: true },
      reconcile: [bindKeysAt(reportDuplicates), bindKeys(removeLosers), bindKeys(rewriteSingular), bindKeysAt(reportUnresolved), bindKeys(markCurrent), bindKeysAt(queuePropagation)],
    },
    [RELEASE_WORK_PHASE]: {
      source: { table: 'knowledge_git_provenance', columns: ['project_id', 'session_id'], where: "session_id IS NOT NULL AND head_sha IS NOT NULL AND capture_point IN ('session_start','session_end')" },
      reconcile: [bindKeys(seedWork)],
      frontier: () => [statesCanonical.bind()],
    },
  },
  reset: (): Bound[] => [clearChecks.bind(), clearWork.bind(), clearPropagation.bind()],
} as const satisfies CatchupFamily;
