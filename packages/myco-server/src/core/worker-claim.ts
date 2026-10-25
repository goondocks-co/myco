import { mintInsert, NO_RUNTIME_CLAIMS, revokeCredentialOfMember } from '../auth/tokens.js';
import { ensureMemberStatement } from '../auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { ensureAgentStatement } from './runs.js';
import { readDispatchLimits } from './limits.js';
import type { ServerEnv } from './adapters.js';
import type { RelationalStore } from './adapters.js';
import type { WorkerPrincipal } from './worker-lease.js';
import { leaseOwnerColumns } from './worker-lease.js';
import { workerContactStatement, runnerContactStatement } from './worker-contacts.js';
import { isExecutionProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { workerClaimPredicate, workerClaimAdmission, runnerClaimGate, claimedInputStatement, type ClaimCandidate, type ClaimedRunRow, type ClaimedInput, type WriteAdmission } from './runs.js';
import { recordPricedAttempt as recordAttemptStatement } from './attempt-accounting.js';
import { estimateForClaim } from './budget-estimates.js';
import { budgetActivation } from '../db/budget-activation.js';
import { capabilityOf } from './worker-selection.js';

/** The worker claim writes its lease, attempt and owner contact in one guarded batch. */
export async function claimWorkerRun(
  env: Pick<ServerEnv,'db'|'fleet'>,
  candidate: ClaimCandidate,
  claim: { worker: WorkerPrincipal; leaseExpiresAt: number; harness: string; now: number; profile: ExecutionProfile; input?: ClaimedInput; settingsGuard?: {sql:string;params:unknown[]} },
): Promise<{row:ClaimedRunRow;issued:Awaited<ReturnType<typeof mintInsert>>['issued']} | null> {
  const {db}=env;
  if (!isExecutionProfile(claim.profile)) throw new Error('a worker claim requires a resolved execution profile');
  const price = await estimateForClaim(db,candidate.projectId,candidate.task,claim.harness,claim.profile);
  const capability=capabilityOf(candidate.task);
  const admission: WriteAdmission = {limits:await readDispatchLimits(env),now:claim.now,...(capability===null?{}:{capability}),
    budget:{...price,active:(await budgetActivation(db)).active},settingsGuard:claim.settingsGuard};
  const mint=await mintInsert(db,{memberId:HARNESS_MEMBER_ID,machineId:'harness'},claim.now,null,NO_RUNTIME_CLAIMS,{rotates:false,gate:workerClaimAdmission(candidate,admission,claim.worker,claim.now)});
  const dispatchedBy=mint.issued.tokenId;
  const setup=[ensureMemberStatement(db,HARNESS_MEMBER_ID,claim.now,'member',undefined,'harness runtime'),
    ensureAgentStatement(db,{id:'myco-agent',name:'myco-agent',provider:claim.harness,model:null,enabled:true},claim.now),mint.statement];
  const authority = workerClaimPredicate(candidate, admission);
  const owner = leaseOwnerColumns(claim.worker);
  const gate = runnerClaimGate(claim.worker, claim.now);
  const lease = { projectId: candidate.projectId, runId: candidate.id, attemptId: dispatchedBy };
  const contact = claim.worker.kind === 'member'
    ? await workerContactStatement(db, { credentialId: claim.worker.tokenId, machineId: claim.worker.machineId, reason: 'claimed', now: claim.now }, lease)
    : runnerContactStatement(db, { runnerId: claim.worker.runnerId, reason: 'claimed', now: claim.now }, lease, claim.worker);
  const results = await db.batch([...setup, db.prepare(
    `UPDATE agent_runs
        SET status = 'running', started_at = ?, dispatched_by = ?, leased_by = ?, leased_runner_id = ?, leased_runner_credential_id = ?,
            lease_expires_at = ?, harness = ?, held_by = NULL,
            reasoning_level = ?, model = ?, execution_overrides = ?
      WHERE project_id = ? AND id = ? AND ${authority.sql} AND ${gate.sql}
      RETURNING project_id AS projectId, id, task, instruction, run_context AS runContext, dry_run AS dryRun`,
  ).bind(
    claim.now, dispatchedBy, owner.leasedBy, owner.runnerId, owner.runnerCredentialId, claim.leaseExpiresAt, claim.harness,
    claim.profile.tier, claim.profile.model,
    JSON.stringify({ requested: claim.profile, harness: claim.harness }),
    candidate.projectId, candidate.id,
    ...authority.params, ...gate.params,
  ), recordAttemptStatement(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.worker, claim.now, admission.budget),
    ...(claim.input === undefined ? [] : [claimedInputStatement(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.input)]),
    ...(contact === null ? [] : [contact]),
    ...(claim.worker.kind === 'runner' ? [db.prepare(`UPDATE runners SET last_assigned_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND leased_runner_id = runners.id AND dispatched_by = ?)`)
      .bind(claim.now, claim.worker.runnerId, candidate.projectId, candidate.id, dispatchedBy)] : []),
  ]);
  const row=results[setup.length]?.results[0] as ClaimedRunRow|undefined;
  if(row===undefined) { await revokeCredentialOfMember(db,HARNESS_MEMBER_ID,dispatchedBy,claim.now);return null; }
  return {row,issued:mint.issued};
}
