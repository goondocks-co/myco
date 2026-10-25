import {isExecutionProfile} from '@goondocks/myco-shared/execution-profile';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { workerLeaseAuthority, type WorkerPrincipal } from './worker-lease.js';
import { seedForStage, BUDGET_ESTIMATE_PREFIX } from './budget-policy.js';

export interface AttemptPrice { estimate: number; profileJson: string }
const RESTORE_CLAIM_FIELDS=new Set(['claimed_at','leased_by','machine_id','owner_kind','runner_id','estimate_usd','cost_usd','cost_source','profile_json']);
/** Settlement order belongs to the destination Deployment's estimator cursor. */
export const portableAttemptRow = (row:Record<string,unknown>):Record<string,unknown> => Object.fromEntries(Object.entries(row).filter(([key])=>key!=='settled_seq'));
/** Restored estimate history ranks below every destination settlement. */
export function restoreAgentStateStatement(db:RelationalStore,row:Record<string,unknown>):PreparedStatement {
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
  return db.prepare(`INSERT OR IGNORE INTO agent_state(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) RETURNING rowid`)
    .bind(...columns.map(key=>row[key]??null));
}
export function attemptRestoreComparison(row:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key,value])=>value!=null
    && (RESTORE_CLAIM_FIELDS.has(key)||['project_id','run_id','attempt_id'].includes(key))
    && (key!=='cost_source'||row.cost_usd!=null)));
}
export function recordPricedAttempt(
  db: RelationalStore, scope: ReadScope, runId: string, attemptId: string, worker: WorkerPrincipal, now: number, price?: AttemptPrice,
): PreparedStatement {
  const runner = worker.kind === 'runner';
  return db.prepare(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,machine_id,claimed_at,owner_kind,runner_id,estimate_usd,profile_json)
    SELECT project_id,id,dispatched_by,?,?,?,?,?,?,? FROM agent_runs
    WHERE project_id=? AND id=? AND status='running' AND dispatched_by=?
    AND ${runner ? 'leased_runner_id=? AND leased_runner_credential_id=?' : 'leased_by=?'}
    ON CONFLICT(project_id,run_id,attempt_id) DO NOTHING`)
    .bind(runner ? worker.credentialId : worker.tokenId,worker.machineId,now,worker.kind,runner ? worker.runnerId : null,
      price?.estimate ?? seedForStage(''),price?.profileJson ?? null,scope.projectId,runId,attemptId,
      ...(runner ? [worker.runnerId,worker.credentialId] : [worker.tokenId]));
}

/** Cost can settle only while this exact attempt remains under the authenticated live lease. */
export function settleAttemptCostStatement(
  db: RelationalStore, scope: ReadScope, runId: string, attemptId: string, worker: WorkerPrincipal,
  now: number, cost: number | null, source: string | null,
): PreparedStatement {
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Attempt cost must be finite and nonnegative');
  const authority = workerLeaseAuthority(worker,now,attemptId,true);
  return db.prepare(`UPDATE agent_run_attempts SET cost_usd=?,cost_source=? WHERE project_id=? AND run_id=? AND attempt_id=?
    AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=? AND id=? AND ${authority.sql})`)
    .bind(cost,source,scope.projectId,runId,attemptId,scope.projectId,runId,...authority.params);
}

/** Restored attempt evidence is additive and keeps its canonical identity. */
export function restoreAttemptStatement(db: RelationalStore, row: Record<string, unknown>): PreparedStatement {
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
  const updates=columns.filter(column=>RESTORE_CLAIM_FIELDS.has(column));
  const desired=(column:string)=>column==='cost_source'
    ? 'CASE WHEN excluded.cost_usd IS NULL THEN agent_run_attempts.cost_source ELSE COALESCE(excluded.cost_source,agent_run_attempts.cost_source) END'
    : `COALESCE(excluded.${column},agent_run_attempts.${column})`;
  return db.prepare(`INSERT INTO agent_run_attempts(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})
    ON CONFLICT(project_id,run_id,attempt_id) DO UPDATE SET ${updates.map(column=>`${column}=${desired(column)}`).join(',')}
    WHERE ${updates.map(column=>`${desired(column)} IS NOT agent_run_attempts.${column}`).join(' OR ')} RETURNING rowid`)
    .bind(...columns.map(key=>row[key] ?? null));
}
