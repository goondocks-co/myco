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
import { workerClaimPredicate, pulledClaimPredicate, runnerClaimGate, claimedInputStatement, type ClaimCandidate, type ClaimedRunRow, type ClaimedInput, type PulledCandidate, type WriteAdmission } from './runs.js';
import { recordPricedAttempt as recordAttemptStatement } from './attempt-accounting.js';
import { estimateForClaim } from './budget-estimates.js';
import { budgetActivation } from '../db/budget-activation.js';
import { capabilityOf } from './worker-selection.js';
import { IN_FLIGHT_RUN_STATUSES } from '../db/run-statuses.js';

/** What a claim takes: a queued row it moves to `running`, or a pulled item it creates the running row for. */
export type ClaimForm = { kind: 'queued'; candidate: ClaimCandidate } | { kind: 'pulled'; pull: PulledCandidate };
type WorkerClaim = { worker: WorkerPrincipal; leaseExpiresAt: number; harness: string; now: number; profile: ExecutionProfile; input?: ClaimedInput; settingsGuard?: {sql:string;params:unknown[]} };
type ClaimResult = {row:ClaimedRunRow;issued:Awaited<ReturnType<typeof mintInsert>>['issued']} | null;

/** Move one queued row to `running` through the claim capability. */
export const claimQueuedRun = (env: Pick<ServerEnv,'db'|'fleet'>, candidate: ClaimCandidate, claim: WorkerClaim): Promise<ClaimResult> =>
  claimWorkerRun(env, { kind: 'queued', candidate }, claim);

/** Create one pulled run, already `running`, through the claim capability. */
export const claimPulledRun = (env: Pick<ServerEnv,'db'|'fleet'>, pull: PulledCandidate, claim: Omit<WorkerClaim,'input'>): Promise<ClaimResult> =>
  claimWorkerRun(env, { kind: 'pulled', pull }, { ...claim, input: pull.input });

/**
 * The one claim write. Both forms share the credential mint gated by the complete admission, the runner gate, the
 * lease, owner and profile columns, the priced attempt, the contact and the runner's assignment stamp; only the first
 * statement differs. Every statement after it is conditioned on the run row this batch wrote, so a refused claim
 * leaves no usable credential, attempt or lease.
 */
export async function claimWorkerRun(env: Pick<ServerEnv,'db'|'fleet'>, form: ClaimForm, claim: WorkerClaim): Promise<ClaimResult> {
  const {db}=env;
  if (!isExecutionProfile(claim.profile)) throw new Error('a worker claim requires a resolved execution profile');
  const candidate: ClaimCandidate = form.kind === 'queued' ? form.candidate
    : { projectId: form.pull.projectId, id: form.pull.id, task: form.pull.task, instruction: form.pull.input.instruction, dispatchSpec: null };
  const price = await estimateForClaim(db,candidate.projectId,candidate.task,claim.harness,claim.profile);
  const capability=capabilityOf(candidate.task);
  const admission: WriteAdmission = {limits:await readDispatchLimits(env),now:claim.now,...(capability===null?{}:{capability}),
    budget:{...price,active:(await budgetActivation(db)).active},settingsGuard:claim.settingsGuard};
  const authority = form.kind === 'queued' ? workerClaimPredicate(candidate, admission) : pulledClaimPredicate(form.pull, admission);
  const gate = runnerClaimGate(claim.worker, claim.now);
  const mint=await mintInsert(db,{memberId:HARNESS_MEMBER_ID,machineId:'harness'},claim.now,null,NO_RUNTIME_CLAIMS,{rotates:false,gate:{sql:`${authority.sql} AND ${gate.sql}`,params:[...authority.params,...gate.params]}});
  const dispatchedBy=mint.issued.tokenId;
  const setup=[ensureMemberStatement(db,HARNESS_MEMBER_ID,claim.now,'member',undefined,'harness runtime'),
    ensureAgentStatement(db,{id:'myco-agent',name:'myco-agent',provider:claim.harness,model:null,enabled:true},claim.now),mint.statement];
  const owner = leaseOwnerColumns(claim.worker);
  const lease = { projectId: candidate.projectId, runId: candidate.id, attemptId: dispatchedBy };
  const contact = claim.worker.kind === 'member'
    ? await workerContactStatement(db, { credentialId: claim.worker.tokenId, machineId: claim.worker.machineId, reason: 'claimed', now: claim.now }, lease)
    : runnerContactStatement(db, { runnerId: claim.worker.runnerId, reason: 'claimed', now: claim.now }, lease, claim.worker);
  // A queued row whose built input names a subject takes it at its claim, with single flight on it.
  const subject = form.kind === 'queued' ? claim.input?.subject ?? null : null;
  const profileColumns = [claim.profile.tier, claim.profile.model, JSON.stringify({ requested: claim.profile, harness: claim.harness })];
  const claimStatement = form.kind === 'queued' ? db.prepare(
    `UPDATE agent_runs
        SET status = 'running', started_at = ?, dispatched_by = ?, leased_by = ?, leased_runner_id = ?, leased_runner_credential_id = ?,
            lease_expires_at = ?, harness = ?, held_by = NULL,
            reasoning_level = ?, model = ?, execution_overrides = ?, subject = COALESCE(?, subject)
      WHERE project_id = ? AND id = ? AND ${authority.sql} AND ${gate.sql}
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs flight INDEXED BY idx_agent_runs_task_live
          WHERE flight.task = agent_runs.task AND flight.${IN_FLIGHT_RUN_STATUSES} AND flight.subject = ? AND flight.id != agent_runs.id))
      RETURNING project_id AS projectId, id, task, instruction, run_context AS runContext, dry_run AS dryRun`,
  ).bind(
    claim.now, dispatchedBy, owner.leasedBy, owner.runnerId, owner.runnerCredentialId, claim.leaseExpiresAt, claim.harness,
    ...profileColumns, subject, candidate.projectId, candidate.id, ...authority.params, ...gate.params, subject, subject,
  ) : db.prepare(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject, dispatch_spec, started_at, dispatched_by,
        leased_by, leased_runner_id, leased_runner_credential_id, lease_expires_at, harness, reasoning_level, model, execution_overrides)
      SELECT ?, ?, 'myco-agent', ?, 'running', 'automatic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${authority.sql} AND ${gate.sql}
      RETURNING project_id AS projectId, id, task, instruction, run_context AS runContext, dry_run AS dryRun`,
  ).bind(
    candidate.projectId, candidate.id, candidate.task, form.pull.subject, JSON.stringify({ actor: 'deployment' }), claim.now, dispatchedBy,
    owner.leasedBy, owner.runnerId, owner.runnerCredentialId, claim.leaseExpiresAt, claim.harness, ...profileColumns,
    ...authority.params, ...gate.params,
  );
  const results = await db.batch([...setup, claimStatement, recordAttemptStatement(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.worker, claim.now, admission.budget),
    ...(claim.input === undefined ? [] : [claimedInputStatement(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.input)]),
    ...(form.kind === 'pulled' ? form.pull.claimed?.(dispatchedBy) ?? [] : []),
    ...(contact === null ? [] : [contact]),
    ...(claim.worker.kind === 'runner' ? [db.prepare(`UPDATE runners SET last_assigned_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND leased_runner_id = runners.id AND dispatched_by = ?)`)
      .bind(claim.now, claim.worker.runnerId, candidate.projectId, candidate.id, dispatchedBy)] : []),
  ]);
  const row=results[setup.length]?.results[0] as ClaimedRunRow|undefined;
  if(row===undefined) { await revokeCredentialOfMember(db,HARNESS_MEMBER_ID,dispatchedBy,claim.now);return null; }
  return {row,issued:mint.issued};
}
