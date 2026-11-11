import type { Bound } from '../db/index.js';
import { pricedAttemptInsert } from '../db/runs/claim-companions.js';
import { RESTORE_CLAIM_FIELDS, restoreAgentStateRow, restoreAttemptRow, settleAttemptCost } from '../db/runs/attempt-accounting.js';
import {isExecutionProfile} from '@goondocks/myco-shared/execution-profile';
import type { ReadScope } from '../read/scope.js';
import type { WorkerPrincipal } from './worker-lease.js';
import { seedForStage, BUDGET_ESTIMATE_PREFIX } from './budget-policy.js';

interface AttemptPrice { estimate: number; profileJson: string }
/** Settlement order belongs to the destination Deployment's estimator cursor. */
export const portableAttemptRow = (row:Record<string,unknown>):Record<string,unknown> => Object.fromEntries(Object.entries(row).filter(([key])=>key!=='settled_seq'));
/** Restored estimate history ranks below every destination settlement. */
export function restoreAgentStateStatement(row:Record<string,unknown>):Bound<{rowid:number},'write'> {
  if(typeof row.key==='string'&&row.key.startsWith(BUDGET_ESTIMATE_PREFIX)) {
    if(typeof row.value!=='string')throw new Error('Invalid restored estimate');
    const sample:unknown=JSON.parse(row.value);
    if(sample===null||typeof sample!=='object'||!('points' in sample)||!Array.isArray(sample.points))throw new Error('Invalid restored estimate');
    const points=sample.points.map((point:unknown)=>{
      if(point===null||typeof point!=='object'||Array.isArray(point))throw new Error('Invalid restored estimate point');
      return {...point,seq:0};
    });
    row={...row,value:JSON.stringify({...sample,points})};
  }
  const columns=Object.keys(row);
  if(!columns.every(key=>/^[a-z_]+$/.test(key)))throw new Error('Invalid restored state column');
  return restoreAgentStateRow(row,columns);
}
export function attemptRestoreComparison(row:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key,value])=>value!=null
    && (RESTORE_CLAIM_FIELDS.has(key)||['project_id','run_id','attempt_id'].includes(key))
    && (key!=='cost_source'||row.cost_usd!=null)));
}
/** The claimed attempt's row; `agentVersion` is the version the claim reported for the harness the run is held on, null where it reported none, and kept only on a runner's attempt. */
export function recordPricedAttemptWrite(
  scope: ReadScope, attempt: { runId: string; attemptId: string; worker: WorkerPrincipal; now: number; price?: AttemptPrice; agentVersion: string | null },
): Bound {
  const { runId, attemptId, worker, now, price, agentVersion } = attempt;
  const runner = worker.kind === 'runner';
  return pricedAttemptInsert[Number(runner)]!.bind(runner ? worker.credentialId : worker.tokenId, worker.machineId, now, worker.kind, runner ? worker.runnerId : null, price?.estimate ?? seedForStage(''), price?.profileJson ?? null, ...(runner ? [agentVersion] : []), scope.projectId, runId, attemptId, ...(runner ? [worker.runnerId,worker.credentialId] : [worker.tokenId]));
}

/** Cost can settle only while this exact attempt remains under the authenticated live lease. */
export function settleAttemptCostStatement(
  scope: ReadScope, runId: string, attemptId: string, worker: WorkerPrincipal,
  now: number, cost: number | null, source: string | null,
): Bound<never,'write'> {
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Attempt cost must be finite and nonnegative');
  return settleAttemptCost({projectId:scope.projectId,runId,attemptId,worker},now,{cost,source});
}

/** Restored attempt evidence is additive and keeps its canonical identity. */
export function restoreAttemptStatement(row: Record<string, unknown>): Bound<{rowid:number},'write'> {
  row=portableAttemptRow(row);
  const columns = Object.keys(row);
  if(row.cost_source!=null&&!['actual','estimated','unavailable'].includes(String(row.cost_source)))throw new Error('Invalid restored cost source');
  if(row.cost_usd==null&&['actual','estimated'].includes(String(row.cost_source)))throw new Error('A priced cost source requires a known attempt cost');
  if(row.profile_json!=null) {
    if(typeof row.profile_json!=='string')throw new Error('Invalid restored attempt profile');
    const profile:unknown=JSON.parse(row.profile_json);
    if(profile===null||typeof profile!=='object'||!('harness' in profile)||typeof profile.harness!=='string'||!('profile' in profile)||!isExecutionProfile(profile.profile))throw new Error('Invalid restored attempt profile');
  }
  if (!columns.every(key => /^[a-z_]+$/.test(key))) throw new Error('Invalid attempt column');
  for (const key of ['estimate_usd','cost_usd']) {
    const value = row[key];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value<0)) throw new Error('Invalid restored attempt money');
  }
  return restoreAttemptRow(row,columns);
}

