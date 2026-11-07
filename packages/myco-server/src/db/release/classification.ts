import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, write } from '../index.js';

/** The check's claim on its Project: the run id and the revision it claimed at. */
export const RELEASE_FENCE = 'EXISTS (SELECT 1 FROM project_release_provenance f WHERE f.project_id = ? AND f.check_run_id = ? AND f.revision = ?)';

const HELD_SOURCE = "json_extract(knowledge_release_state.evidence_json, '$.source')";
const NEW_SOURCE = "json_extract(excluded.evidence_json, '$.source')";

/** A released row keeps its state unless the session's evidence moved to another source. */
export const RELEASE_UPSERT = `ON CONFLICT(project_id, identity_key) DO UPDATE SET source_session_id = excluded.source_session_id, state = excluded.state, confidence = excluded.confidence,
    basis_kind = excluded.basis_kind, basis_ref = excluded.basis_ref, basis_sha = excluded.basis_sha,
    release_pr_number = excluded.release_pr_number, reason = excluded.reason,
    evidence_json = CASE WHEN knowledge_release_state.state IS excluded.state AND ${HELD_SOURCE} IS ${NEW_SOURCE}
      THEN json_set(excluded.evidence_json, '$.previous', json(COALESCE(json_extract(knowledge_release_state.evidence_json, '$.previous'), 'null')))
      ELSE json_set(excluded.evidence_json, '$.previous', json_object('state', knowledge_release_state.state, 'source', ${HELD_SOURCE},
        'basis_ref', knowledge_release_state.basis_ref, 'checked_at', knowledge_release_state.checked_at)) END,
    checked_at = excluded.checked_at, updated_at = excluded.checked_at
  WHERE knowledge_release_state.state <> 'released' OR (${HELD_SOURCE} IS NOT NULL AND ${HELD_SOURCE} IS NOT ${NEW_SOURCE})`;

/** The spores and plans that carry their session's release state. */
export const RELEASE_DERIVED = [['spores', 'spores', 'id'], ['plans', 'plans', 'plan_key']] as const;

type Fence = [project: string, run: string, revision: string];
/** state, confidence, basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at. */
export type ClassificationColumns = [string, string, string, string | null, string | null, number | null, string, string, number];

const prior = read<[project: string, identity: string], { state: string }>({ name: 'releaseClassification.prior', sql:
  'SELECT state FROM knowledge_release_state WHERE project_id = ? AND identity_key = ?' });
const held = read<Fence, { held: number }>({ name: 'releaseClassification.held', sql:
  'SELECT 1 AS held FROM project_release_provenance WHERE project_id = ? AND check_run_id = ? AND revision = ?' });
const session = write<[project: string, id: string, identity: string, record: string, source: string, ...ClassificationColumns, createdAt: number, ...Fence], { state: string }>({
  name: 'releaseClassification.session', sql: `INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id,
      state, confidence, basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT ?, ?, ?, 'sessions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RELEASE_FENCE} ${RELEASE_UPSERT} RETURNING state` });
const derived = RELEASE_DERIVED.map(([namespace, table, key]) => write<[...ClassificationColumns, createdAt: number, project: string, session: string, ...Fence]>({
  name: `releaseClassification.${namespace}`, sql: `INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT project_id, 'rs_' || lower(hex(randomblob(16))), project_id || ':${namespace}:' || ${key}, '${namespace}', ${key}, session_id,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM ${table} WHERE project_id = ? AND session_id = ? AND ${RELEASE_FENCE} ${RELEASE_UPSERT}` }));

/**
 * Writes one session's classification and carries it to the spores and plans the session produced, inside the claim,
 * in one batch. Answers null when the claim is gone, false when the held row kept its state (a released row from the
 * same source), and true or false by whether a write it made changed the session's state.
 */
export async function writeReleaseClassification(db: RelationalStore, identity: { projectId: string; sessionId: string; key: string },
  columns: ClassificationColumns, now: number, fence: Fence): Promise<boolean | null> {
  const { projectId, sessionId, key } = identity;
  const [before, claim, written] = await commit(db,
    prior.bind(projectId, key),
    held.bind(...fence),
    session.bind(projectId, `rs_${crypto.randomUUID().replaceAll('-', '')}`, key, sessionId, sessionId, ...columns, now, ...fence),
    ...derived.map(statement => statement.bind(...columns, now, projectId, sessionId, ...fence)));
  if (claim.results.length === 0) return null;
  if (written.results.length === 0) return false;
  return before.results[0]?.state !== written.results[0]!.state;
}

