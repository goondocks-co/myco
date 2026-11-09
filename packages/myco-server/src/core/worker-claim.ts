import { workerClaimWrite, workerClaimAssertions, workerCredentialGate, runnerAssignmentWrite } from '../db/runs/claim.js';
import { knowledgeInputForExecution } from './knowledge-execution.js';
import { reserveForStage } from './budget-policy.js';
import { mintWrite, NO_RUNTIME_CLAIMS, revokeCredentialOfMember } from '../auth/tokens.js';
import { ensureMemberWrite } from '../auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { ensureAgentWrite, claimedInputWrite, commitWorkerClaim } from '../db/runs/claim.js';
import { readDispatchLimits } from './limits.js';
import type { ServerEnv } from './adapters.js';

import type { WorkerPrincipal } from './worker-lease.js';
import { workerContactWrite, runnerContactWrite } from './worker-contacts.js';
import { isExecutionProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { type ClaimCandidate, type ClaimedRunRow, type ClaimedInput, type PulledCandidate, type WriteAdmission } from './runs.js';
import { recordPricedAttemptWrite as recordAttemptStatement } from './attempt-accounting.js';
import { estimateForClaim } from './budget-estimates.js';
import { budgetActivation } from '../db/meta/budget-activation.js';
import { capabilityOf } from './worker-selection.js';

/** What a claim takes: a queued row it moves to `running`, or a pulled item it creates the running row for. */
export type ClaimForm = { kind: 'queued'; candidate: ClaimCandidate } | { kind: 'pulled'; pull: PulledCandidate };
export type WorkerClaim = { worker: WorkerPrincipal; leaseExpiresAt: number; harness: string; now: number; profile: ExecutionProfile; capabilities?: readonly string[]; input?: ClaimedInput; settingsGuard?: Readonly<Record<string,number>> };
type ClaimResult = {row:ClaimedRunRow;issued:Awaited<ReturnType<typeof mintWrite>>['issued'];input?:ClaimedInput} | null;

/** Move one queued row to `running` through the claim capability. */
export const claimQueuedRun = (env: Pick<ServerEnv,'db'|'fleet'|'wrappingKey'>, candidate: ClaimCandidate, claim: WorkerClaim): Promise<ClaimResult> =>
  claimWorkerRun(env, { kind: 'queued', candidate }, claim);

/** Create one pulled run, already `running`, through the claim capability. */
export const claimPulledRun = (env: Pick<ServerEnv,'db'|'fleet'|'wrappingKey'>, pull: PulledCandidate, claim: Omit<WorkerClaim,'input'>): Promise<ClaimResult> =>
  claimWorkerRun(env, { kind: 'pulled', pull }, { ...claim, input: pull.input });

/** Admission, named stage assertions, credentials, heads and lease companions settle in one atomic batch. */
async function claimWorkerRun(env: Pick<ServerEnv,'db'|'fleet'|'wrappingKey'>, form: ClaimForm, claim: WorkerClaim): Promise<ClaimResult> {
  const {db}=env;
  if (!isExecutionProfile(claim.profile)) throw new Error('a worker claim requires a resolved execution profile');
  const candidate: ClaimCandidate = form.kind === 'queued' ? form.candidate
    : { projectId: form.pull.projectId, id: form.pull.id, task: form.pull.task, instruction: form.pull.input.instruction, dispatchSpec: null };
  const selectedInput = claim.input === undefined ? undefined : await knowledgeInputForExecution(env, candidate.projectId, candidate.task,
    claim.input, claim.harness, claim.capabilities ?? []);
  claim = {...claim, input:selectedInput};
  const price = await estimateForClaim(db,candidate.projectId,candidate.task,claim.harness,claim.profile);
  const capability=capabilityOf(candidate.task);
  const admission: WriteAdmission = {limits:await readDispatchLimits(env),now:claim.now,...(capability===null?{}:{capability}),
    budget:{...price,reserveUsd:reserveForStage(candidate.task),active:(await budgetActivation(db)).active},settingsGuard:claim.settingsGuard};
  const mint=await mintWrite(db,{memberId:HARNESS_MEMBER_ID,machineId:'harness'},claim.now,null,NO_RUNTIME_CLAIMS,{rotates:false,claim:workerCredentialGate(form,claim,admission)});
  const dispatchedBy=mint.issued.tokenId;
  const setup=[ensureMemberWrite(db,HARNESS_MEMBER_ID,claim.now,'member','harness runtime'),
    ensureAgentWrite(db,{id:'myco-agent',name:'myco-agent',provider:claim.harness,model:null,enabled:true},claim.now),mint.statement] as const;
  const lease = { projectId: candidate.projectId, runId: candidate.id, attemptId: dispatchedBy };
  const contact = claim.worker.kind === 'member'
    ? await workerContactWrite(db, { credentialId: claim.worker.tokenId, machineId: claim.worker.machineId, reason: 'claimed', now: claim.now }, lease)
    : runnerContactWrite(db, { runnerId: claim.worker.runnerId, reason: 'claimed', now: claim.now }, lease, claim.worker);
  const claimStatement = workerClaimWrite(form,claim,admission,dispatchedBy);
  const row = await commitWorkerClaim(db, setup, claimStatement, [recordAttemptStatement(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.worker, claim.now, admission.budget),
    ...(claim.input === undefined ? [] : [claimedInputWrite(db, { projectId: candidate.projectId }, candidate.id, dispatchedBy, claim.input)]),
    ...(form.kind === 'pulled' ? form.pull.claimed?.(dispatchedBy) ?? [] : []),
    ...(contact === null ? [] : [contact]),
    ...(claim.worker.kind === 'runner' ? [runnerAssignmentWrite.bind(claim.now, claim.worker.runnerId, candidate.projectId, candidate.id, dispatchedBy)] : []),
  ], [...workerClaimAssertions(form, claim, admission), ...(form.kind === 'pulled' ? form.pull.assertions : [])]);
  if(row===undefined) { await revokeCredentialOfMember(db,HARNESS_MEMBER_ID,dispatchedBy,claim.now);return null; }
  return {row,issued:mint.issued,input:selectedInput};
}
