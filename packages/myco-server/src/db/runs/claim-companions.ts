import { LEARNING_RETRY_KEY } from '../run-context.js';
import { TOKEN_LIVE } from '../identity/capture-credential.js';
import { write, type Bound } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import type { RelationalStore } from '../../core/adapters.js';
const ROTATING_PREDECESSOR = 'EXISTS (SELECT 1 FROM member_credentials WHERE id = ? AND rotates = 1)';

export const prepareClaimCompanion = (db: RelationalStore, bound: Bound) => prepareBound(db, bound);
export const CREDENTIAL_INSERT_SQL = `INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at, runtime_label, runtime_kind, rotates)
              SELECT ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?, ?, ?
               WHERE (? IS NULL OR (${TOKEN_LIVE} AND ${ROTATING_PREDECESSOR}))`;
export const credentialInsert = write<readonly unknown[]>({name:'claim.credentialInsert',sql:CREDENTIAL_INSERT_SQL+' RETURNING id'});
export const pricedAttemptInsert = [false,true].map(runner => write<readonly unknown[]>({name:`claim.pricedAttempt${runner ? 'Runner' : 'Member'}`,sql:`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,machine_id,claimed_at,owner_kind,runner_id,estimate_usd,profile_json)
    SELECT project_id,id,dispatched_by,?,?,?,?,?,?,? FROM agent_runs
    WHERE project_id=? AND id=? AND status='running' AND dispatched_by=?
    AND ${runner ? 'leased_runner_id=? AND leased_runner_credential_id=?' : 'leased_by=?'}
    ON CONFLICT(project_id,run_id,attempt_id) DO NOTHING`}));
export const learningRetryWrite = write<readonly unknown[]>({name:'claim.learningRetryWrite',sql:`UPDATE agent_runs SET run_context = json_set(run_context, '$.${LEARNING_RETRY_KEY}',
      json((SELECT json_object('attemptId', ?, 'failures', failures, 'eligibleAt', eligible_at,
        'cardFailures', card_failures, 'cardRetryAt', card_retry_at, 'revision', revision,
        'turns', json((SELECT json_group_array(json_object('turnKey', turn_key, 'changes', changes, 'dueAt', due_at))
          FROM turn_cards c WHERE c.project_id = l.project_id AND c.session_id = l.session_id AND c.state = 'pending'
            AND c.turn_key IN (SELECT json_extract(value, '$.turnKey') FROM json_each(agent_runs.run_context, '$.assignment.turns')))))
        FROM learning_sessions l WHERE l.project_id = ? AND l.session_id = ?)))
    WHERE project_id = ? AND id = ? AND dispatched_by = ? AND status = 'running'`});
export const learningBackoffWrite = write<readonly unknown[]>({name:'claim.learningBackoffWrite',sql:`UPDATE learning_sessions SET fresh_admitted = CASE WHEN source_activity_at > ? THEN 1 ELSE fresh_admitted END,
      failures = failures + 1,
      eligible_at = ? + CASE WHEN failures = 0 THEN 0 WHEN failures = 1 THEN ? WHEN failures = 2 THEN ? ELSE ? END
    WHERE project_id = ? AND session_id = ? AND eligible_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = learning_sessions.project_id AND r.id = ? AND r.dispatched_by = ?)`});
export const cardBackoffWrite = write<readonly unknown[]>({name:'claim.cardBackoffWrite',sql:`UPDATE learning_sessions SET fresh_admitted = CASE WHEN source_activity_at > ? THEN 1 ELSE fresh_admitted END,
      card_failures = card_failures + 1,
      card_retry_at = ? + CASE WHEN card_failures = 0 THEN ? WHEN card_failures = 1 THEN ? ELSE ? END
    WHERE project_id = ? AND session_id = ?
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = learning_sessions.project_id AND r.id = ? AND r.dispatched_by = ?)`});
export const cardDueWrite = write<readonly unknown[]>({name:'claim.cardDueWrite',sql:`UPDATE turn_cards SET due_at = ? WHERE project_id = ? AND session_id = ? AND state = 'pending'
      AND turn_key IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = turn_cards.project_id AND r.id = ? AND r.dispatched_by = ?)`});
export const curationClaimWrite = write<readonly unknown[]>({name:'claim.curationClaimWrite',sql:`UPDATE spore_curation_work SET first_started_at=CASE WHEN failures=0 THEN ? ELSE first_started_at END,failures=failures+1,searches=0,write_refusal=NULL,read_bytes=?,
      due_at=? + CASE WHEN failures=0 THEN ? WHEN failures=1 THEN ? ELSE ? END,run_id=?
      WHERE project_id=? AND cluster_key=? AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id=? AND id=? AND dispatched_by=?)`});
export const curationDirtyWrite = write<readonly unknown[]>({name:'claim.curationDirtyWrite',sql:`UPDATE spore_curation_changes SET dirty=1 WHERE project_id=? AND dirty=0
        AND EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=? AND cluster_key=? AND run_id=?)`});
export const curationCandidateWrite = write<readonly unknown[]>({name:'claim.curationCandidateWrite',sql:`INSERT OR IGNORE INTO spore_curation_candidates(project_id,run_id,spore_id,revision,read)
        SELECT ?,?,?,?,1 WHERE EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=? AND cluster_key=? AND run_id=?)`});
