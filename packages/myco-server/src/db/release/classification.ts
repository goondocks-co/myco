import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commitNamed, read, refusalCode, refused, write, type Bound } from '../index.js';
import type { ReleaseClaim } from './due.js';

/** Every column a release state row is written with, in the order the insert statements select them. */
export const RELEASE_WRITE_COLUMNS = `(project_id,id,identity_key,namespace,record_id,source_session_id,state,confidence,basis_kind,basis_ref,basis_sha,release_pr_number,reason,evidence_json,checked_at,created_at,source_key,config_revision,refs_fingerprint,paths_mark,canonical)`;

/** A released row keeps its state unless the session's evidence moved to another source, and every other change records the state it replaced. */
export const RELEASE_UPSERT = `ON CONFLICT(project_id,identity_key) DO UPDATE SET source_session_id=excluded.source_session_id,state=excluded.state,confidence=excluded.confidence,
    basis_kind=excluded.basis_kind,basis_ref=excluded.basis_ref,basis_sha=excluded.basis_sha,release_pr_number=excluded.release_pr_number,reason=excluded.reason,
    evidence_json=CASE WHEN knowledge_release_state.state IS excluded.state AND knowledge_release_state.source_key IS excluded.source_key
      THEN json_set(excluded.evidence_json,'$.previous',json(COALESCE(json_extract(knowledge_release_state.evidence_json,'$.previous'),'null')))
      ELSE json_set(excluded.evidence_json,'$.previous',json_object('state',knowledge_release_state.state,'source',knowledge_release_state.source_key,
        'basis_ref',knowledge_release_state.basis_ref,'checked_at',knowledge_release_state.checked_at)) END,
    checked_at=excluded.checked_at,updated_at=excluded.checked_at,source_key=excluded.source_key,config_revision=excluded.config_revision,refs_fingerprint=excluded.refs_fingerprint,paths_mark=excluded.paths_mark,canonical=1
  WHERE knowledge_release_state.state<>'released' OR (knowledge_release_state.source_key IS NOT NULL AND knowledge_release_state.source_key IS NOT excluded.source_key)`;

const CLAIM_LOST = refusalCode('release_claim_lost');

const claimHeld = assertion<[project: string, lease: string, revision: string]>({ name: 'releaseClassification.claimHeld', refusal: CLAIM_LOST,
  when: 'EXISTS (SELECT 1 FROM release_check_due WHERE project_id=?1 AND lease_id=?2 AND revision=?3)' });

const SOURCE_STILL = 'EXISTS (SELECT 1 FROM release_work_due w WHERE w.project_id=?1 AND w.session_id=?2 AND w.source_revision=?3)';

const prior = read<[project: string, identity: string], { state: string }>({ name: 'releaseClassification.prior', sql:
  'SELECT state FROM knowledge_release_state WHERE project_id=?1 AND identity_key=?2' });

type StateParams = [project: string, session: string, sourceRevision: number, id: string, identity: string, state: string, confidence: string, basisKind: string, basisRef: string | null, basisSha: string | null,
  prNumber: number | null, reason: string, evidence: string, checkedAt: number, source: string, configRevision: string, fingerprint: string | null, pathsMark: number | null];

const sessionState = write<StateParams, { state: string }>({ name: 'releaseClassification.session', sql:
  `INSERT INTO knowledge_release_state ${RELEASE_WRITE_COLUMNS}
   SELECT ?1,?4,?5,'sessions',?2,?2,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?15,?16,?17,?18,1 WHERE ${SOURCE_STILL} ${RELEASE_UPSERT} RETURNING state` });

const settle = write<[project: string, session: string, sourceRevision: number, generation: number, identity: string, source: string], { settled: number }>({ name: 'releaseClassification.settle', sql:
  `UPDATE release_work_due SET settled_generation=?4,final=COALESCE((SELECT k.state='released' AND (k.source_key IS NULL OR k.source_key=?6) FROM knowledge_release_state k WHERE k.project_id=?1 AND k.identity_key=?5),0)
   WHERE project_id=?1 AND session_id=?2 AND source_revision=?3 RETURNING 1 AS settled` });

/**
 * Queues the session's records when this commit changes the session's answer. It runs before the write: a stored row
 * with the same answer, or a released row the write will keep, queues nothing.
 */
const queue = write<[project: string, session: string, sourceRevision: number, now: number, identity: string, state: string, confidence: string, basisKind: string,
  basisRef: string | null, basisSha: string | null, prNumber: number | null, source: string]>({ name: 'releaseClassification.queue', sql:
  `INSERT INTO release_propagation_due(project_id,session_id,queued_at)
   SELECT ?1,?2,?4 WHERE ${SOURCE_STILL} AND NOT EXISTS (SELECT 1 FROM knowledge_release_state k WHERE k.project_id=?1 AND k.identity_key=?5
       AND ((k.state=?6 AND k.confidence=?7 AND k.basis_kind IS ?8 AND k.basis_ref IS ?9 AND k.basis_sha IS ?10 AND k.release_pr_number IS ?11 AND k.source_key IS ?12)
         OR (k.state='released' AND (k.source_key IS NULL OR k.source_key IS ?12))))
     AND (EXISTS (SELECT 1 FROM spores WHERE project_id=?1 AND session_id=?2) OR EXISTS (SELECT 1 FROM plans WHERE project_id=?1 AND session_id=?2))
   ON CONFLICT(project_id,session_id) DO UPDATE SET generation=generation+1,after_namespace='',after_record='',queued_at=excluded.queued_at` });

/** What one session's classification writes. */
interface ClassificationWrite {
  sessionId: string;
  sourceRevision: number;
  generation: number;
  state: string;
  confidence: string;
  basisKind: string;
  basisRef: string | null;
  basisSha: string | null;
  releasePrNumber: number | null;
  reason: string;
  evidence: string;
  source: string;
  configRevision: string;
  fingerprint: string | null;
  pathsMark: number | null;
  now: number;
}

export type ClassificationOutcome = 'claim_lost' | 'source_moved' | 'changed' | 'unchanged';

const identityOf = (projectId: string, sessionId: string) => `${projectId}:sessions:${sessionId}`;

/** Settles a session whose classification writes no state (an `unknown` the Project does not record), inside the claim. */
export async function settleUnrecorded(db: RelationalStore, claim: ReleaseClaim, write: { sessionId: string; sourceRevision: number; generation: number; source: string }): Promise<boolean> {
  try {
    await commitNamed(db, {
      held: claimHeld.bind(claim.projectId, claim.leaseId, claim.revision),
      settled: settle.bind(claim.projectId, write.sessionId, write.sourceRevision, write.generation, identityOf(claim.projectId, write.sessionId), write.source),
    });
    return true;
  } catch (error) {
    if (refused(error, CLAIM_LOST)) return false;
    throw error;
  }
}

/**
 * One session's classification, inside the claim and only for the capture it read: a lost claim stops the batch, and a
 * source that moved after the read writes nothing and stays due for the commit that replaced it.
 */
export async function commitClassification(db: RelationalStore, claim: ReleaseClaim, row: ClassificationWrite): Promise<ClassificationOutcome> {
  const { projectId } = claim;
  const identity = identityOf(projectId, row.sessionId);
  const id = `rs_${crypto.randomUUID().replaceAll('-', '')}`;
  const statements: { held: Bound; before: Bound<{ state: string }, 'read'>; queued: Bound; written: Bound<{ state: string }, 'write'>; settled: Bound<{ settled: number }, 'write'> } = {
    held: claimHeld.bind(projectId, claim.leaseId, claim.revision),
    before: prior.bind(projectId, identity),
    queued: queue.bind(projectId, row.sessionId, row.sourceRevision, row.now, identity, row.state, row.confidence, row.basisKind, row.basisRef, row.basisSha, row.releasePrNumber, row.source),
    written: sessionState.bind(projectId, row.sessionId, row.sourceRevision, id, identity, row.state, row.confidence, row.basisKind, row.basisRef, row.basisSha, row.releasePrNumber, row.reason, row.evidence, row.now, row.source, row.configRevision, row.fingerprint, row.pathsMark),
    settled: settle.bind(projectId, row.sessionId, row.sourceRevision, row.generation, identity, row.source),
  };
  let outcome: Awaited<ReturnType<typeof commitNamed<typeof statements>>>;
  try { outcome = await commitNamed(db, statements); } catch (error) {
    if (refused(error, CLAIM_LOST)) return 'claim_lost';
    throw error;
  }
  if (outcome.settled.results.length === 0) return 'source_moved';
  const written = outcome.written.results[0];
  return written !== undefined && outcome.before.results[0]?.state !== written.state ? 'changed' : 'unchanged';
}
