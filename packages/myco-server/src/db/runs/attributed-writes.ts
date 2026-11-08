import { attributedStatement, attributedUpdate } from './attribution.js';
import { renewingLeaseAuthority, type LeaseHolder } from '../../core/worker-lease.js';

const canopyAdmitted = `EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?10 AND id=?11 AND status='running' AND dispatched_by=?12)
  AND EXISTS(SELECT 1 FROM project_repositories WHERE project_id=?13 AND url=?14 AND branch=?15)
  AND (?16 IS NULL OR EXISTS(SELECT 1 FROM canopy_maps WHERE project_id=?17 AND revision=?18))
  AND NOT EXISTS(SELECT 1 FROM canopy_maps WHERE project_id=?1 AND revision IS NOT ?19)`;
export const canopyMapWrite = attributedStatement<readonly unknown[]>('runs.canopyMapWrite', `INSERT INTO canopy_maps
  (project_id,revision,artifact,input_hash,repository_url,repository_branch,repository_commit,source_run_id,generated_at)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE ${canopyAdmitted}
  ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,artifact=excluded.artifact,input_hash=excluded.input_hash,
    repository_url=excluded.repository_url,repository_branch=excluded.repository_branch,repository_commit=excluded.repository_commit,
    source_run_id=excluded.source_run_id,generated_at=excluded.generated_at RETURNING project_id`, canopyAdmitted, `EXISTS(SELECT 1 FROM canopy_maps WHERE project_id=?1 AND revision=?2)`);

const remainingCardsSql = `FROM json_each(?3) j
  LEFT JOIN turn_cards c ON c.project_id=?4 AND c.session_id=?5 AND c.turn_key=json_extract(j.value,'$.turnKey')
  WHERE c.changes=json_extract(j.value,'$.changes') AND (c.run_id IS NOT ?6 OR c.state<>'carded')`;
export const cardsWritten = attributedUpdate<[string,string,string,string,string,string]>('runs.cardsWritten',
  'learning_sessions', 'carded_seq=carded_seq',
  `project_id=?1 AND session_id=?2 AND NOT EXISTS(SELECT 1 ${remainingCardsSql})`, 'session_id',
  `project_id=?1 AND session_id=?2 AND NOT EXISTS(SELECT 1 ${remainingCardsSql})`);

const surviving = `FROM json_each(?1) j CROSS JOIN turn_cards c ON c.turn_key=json_extract(j.value,'$.turnKey')
  AND c.input_hash=json_extract(j.value,'$.inputHash') WHERE c.project_id=?2 AND c.session_id=?3 AND c.state='carded'`;
const nothing = `(SELECT COUNT(*) ${surviving})=0`;
export const learningCompleted = attributedUpdate<[string,string,string,string,number,string,number]>('runs.learningCompleted', 'learning_sessions',
  `revision=revision+1,handoff=CASE WHEN ${nothing} THEN handoff ELSE ?4 END,
    last_completed_at=?5,last_completed_run=?6,last_completed_reason='completed',
    failures=CASE WHEN ${nothing} THEN failures ELSE 0 END,
    eligible_at=CASE WHEN ${nothing} THEN eligible_at ELSE NULL END,
    learned_seq=MAX(learned_seq,COALESCE((SELECT MAX(c.last_seq) ${surviving}),learned_seq))`,
  'project_id=?2 AND session_id=?3 AND revision=?7', `(SELECT COUNT(*) ${surviving}) AS covered`,
  'project_id=?2 AND session_id=?3 AND revision=?7+1 AND last_completed_run=?6');

const knowledgeWrites = (['legacy','runner'] as const).map(kind => {
  const worker: LeaseHolder = kind === 'runner'
    ? { kind: 'runner', runnerId: '', credentialId: '' } : { kind: 'member', tokenId: '' };
  const authority = renewingLeaseAuthority(worker, 0, '', true);
  let slot = 4;
  const predicate = authority.sql.replace(/\?/g, () => `?${++slot}`);
  return attributedUpdate<readonly unknown[]>(`runs.knowledgeUnavailable${kind === 'runner' ? 'Runner' : 'Legacy'}`, 'agent_runs',
    "instruction=?1,run_context=json_remove(run_context,'$.checkout')",
    `project_id=?2 AND id=?3 AND instruction IS ?4 AND json_type(run_context,'$.checkout')='object' AND ${predicate}`, 'id',
    "project_id=?2 AND id=?3 AND instruction IS ?1 AND json_type(run_context,'$.checkout') IS NULL");
});
export function knowledgeUnavailable(worker: LeaseHolder, instruction: string, projectId: string, runId: string, observed: string | null, now: number, attemptId: string) {
  return knowledgeWrites[worker.kind === 'runner' ? 1 : 0]!.bind(instruction,projectId,runId,observed,
    ...renewingLeaseAuthority(worker,now,attemptId,true).params);
}
