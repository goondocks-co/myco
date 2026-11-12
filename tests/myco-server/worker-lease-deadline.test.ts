import { REPOSITORY_PREPARATION_TIMEOUT_MS } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './helpers/worker-principal.js';
import { describe, expect, it } from 'bun:test';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { renewRunLease } from '@myco-server-worker/db/runs/leases.js';
import { runDeadline } from '@myco-server-worker/api/run-admission.js';
import { renewLease } from '@myco-server-worker/core/harness.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { changingAtStatement, observing, storingCall } from './helpers/store-faults.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const RUN = 'run_deadline';

async function rig(context: string | null = JSON.stringify({ timeoutSeconds: 60 }), resumedAt: number | null = null) {
  const e = sqliteEnv({ workerLogin: true });
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'worker');
  const worker = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'machine_worker' }, NOW);
  e.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [NOW]);
  e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,resumed_at,run_context,leased_by,lease_expires_at,dispatched_by)
    VALUES (?,?,'myco-agent','title-summary','running',?,?,?,?,?,?)`,
  [SCOPE.projectId, RUN, NOW, resumedAt, context, worker.tokenId, NOW + 1_000_000, worker.tokenId]);
  const deadline = runDeadline((await getRun(e.db, SCOPE, RUN))!);
  const expiry = () => (e.sqlite.query('SELECT lease_expires_at AS expiry FROM agent_runs WHERE id=?').get(RUN) as { expiry: number }).expiry;
  const renew = (at: number, expiresAt: number) => renewRunLease(e.db, SCOPE, RUN, legacyWorker(worker.tokenId, 'm1'), expiresAt, at, worker.tokenId);
  return { e, deadline, expiry, renew, worker };
}

describe('a worker lease is bounded by its run deadline', () => {
  it('answers the expiry the shared renewal actually stored', async () => {
    const r = await rig();
    try {
      expect(await renewLease(r.e.serverEnv, { principal: legacyWorker(r.worker.tokenId, 'm1'), now: r.deadline - 1 }, { projectId: SCOPE.projectId, runId: RUN, attemptId: r.worker.tokenId }))
        .toEqual({ held: true, expiresAt: r.deadline });
    } finally { r.e.sqlite.close(); }
  });

  it('answers only the final millisecond of lease duration through the worker HTTP route', async () => {
    const r = await rig();
    const now = r.deadline - 1;
    try {
      const response = await createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: fetch }).handleRequest(memberPost(r.worker.token,
        { projectId: SCOPE.projectId, runId: RUN, attemptId: r.worker.tokenId }, '/worker/lease'), r.e.serverEnv);
      expect({ status: response.status, body: await response.json(), stored: r.expiry() })
        .toMatchObject({ status: 200, body: { persisted: true, held: true, expiresAt: r.deadline, leaseMs: 1 }, stored: r.deadline });
    } finally { r.e.sqlite.close(); }
  });
  for (const context of [JSON.stringify({ timeoutSeconds: 60 }), '{}', null, '{broken', JSON.stringify({ timeoutSeconds: -1 }), JSON.stringify({ timeoutSeconds: '60' })]) {
    it(`caps an existing overlong lease using the canonical deadline for ${context}`, async () => {
      const r = await rig(context);
      try {
        expect(await r.renew(NOW + 1, r.deadline + 10_000)).toBe(true);
        expect(r.expiry()).toBe(r.deadline);
      } finally { r.e.sqlite.close(); }
    });
  }

  for (const offset of [0, 1]) it(`refuses renewal ${offset}ms past the run deadline while the lease is live`, async () => {
    const r = await rig();
    try {
      const before = r.expiry();
      expect(await r.renew(r.deadline + offset, r.deadline + 90_000)).toBe(false);
      expect(r.expiry()).toBe(before);
    } finally { r.e.sqlite.close(); }
  });

  it('uses the resumed attempt deadline and permits its last live millisecond', async () => {
    const r = await rig(JSON.stringify({ timeoutSeconds: 60 }), NOW + 10_000);
    try {
      expect(await r.renew(r.deadline - 1, r.deadline + 90_000)).toBe(true);
      expect(r.expiry()).toBe(r.deadline);
    } finally { r.e.sqlite.close(); }
  });

  it('refuses a deadline computed from a row changed before the lease write', async () => {
    const defined = await rig();
    try { await defined.renew(NOW + 1, defined.deadline); } finally { defined.e.sqlite.close(); }
    const r = await rig();
    const raced = changingAtStatement(r.e.db, 'runs.renewLeaseMemberAttempt', () => {
      r.e.sqlite.run(`UPDATE agent_runs SET run_context = '{"timeoutSeconds":1}' WHERE id=?`, [RUN]);
    });
    try {
      expect(await renewRunLease(raced.store, SCOPE, RUN, legacyWorker(r.worker.tokenId, 'm1'), r.deadline + 90_000, NOW + 125_000, r.worker.tokenId)).toBe(false);
      expect(raced.landed()).toBe(true);
    } finally { r.e.sqlite.close(); }
  });

  it('refuses a running row with no attempt start', async () => {
    const r = await rig();
    try {
      r.e.sqlite.run('UPDATE agent_runs SET started_at=NULL WHERE id=?', [RUN]);
      expect(runDeadline((await getRun(r.e.db, SCOPE, RUN))!)).toBe(0);
      expect(await r.renew(NOW + 1, r.deadline)).toBe(false);
    } finally { r.e.sqlite.close(); }
  });

  it('renews through an unrelated concurrent context update', async () => {
    const defined = await rig();
    try { await defined.renew(NOW + 1, defined.deadline); } finally { defined.e.sqlite.close(); }
    const r = await rig();
    const raced = changingAtStatement(r.e.db, 'runs.renewLeaseMemberAttempt', () => {
      r.e.sqlite.run(`UPDATE agent_runs SET run_context=json_set(run_context, '$.repository.commit', ?) WHERE id=?`, ['a'.repeat(40), RUN]);
    });
    try {
      expect(await renewRunLease(raced.store, SCOPE, RUN, legacyWorker(r.worker.tokenId, 'm1'), r.deadline + 90_000, NOW + 1, r.worker.tokenId)).toBe(true);
      expect(raced.landed()).toBe(true);
      expect(r.expiry()).toBe(r.deadline);
    } finally { r.e.sqlite.close(); }
  });

  it('answers the committed attempt expiry when another attempt replaces it after renewal', async () => {
    const probe = await rig();
    let at = 0;
    try {
      at = await storingCall(probe.e.db, async (store) => {
        probe.e.env.MYCO_DB = store;
        await renewLease(probe.e.serverEnv, { principal: legacyWorker(probe.worker.tokenId, 'm1'), now: NOW + 1 }, { projectId: SCOPE.projectId, runId: RUN, attemptId: probe.worker.tokenId });
      }, () => probe.expiry());
    } finally { probe.e.sqlite.close(); }
    const r = await rig();
    const replacement = await issueMemberToken(r.e.db, { memberId: 'mem_worker', machineId: 'machine_worker' }, NOW);
    let committedExpiry: number | null = null;
    const watched = observing(r.e.db, (n, moment) => {
      if (n !== at || moment !== 'after') return;
      committedExpiry = r.expiry();
      r.e.sqlite.run('UPDATE agent_runs SET dispatched_by=?, lease_expires_at=? WHERE id=?', [replacement.tokenId, NOW + 1234, RUN]);
    });
    r.e.env.MYCO_DB = watched.store;
    try {
      const outcome = await renewLease(r.e.serverEnv, { principal: legacyWorker(r.worker.tokenId, 'm1'), now: NOW + 1 }, { projectId: SCOPE.projectId, runId: RUN, attemptId: r.worker.tokenId });
      expect(outcome).toEqual({ held: true, expiresAt: committedExpiry! });
      expect(outcome.expiresAt).not.toBe(r.expiry());
    } finally { r.e.sqlite.close(); }
  });
});

it('keeps the independent repository preparation allowance in canonical and SQL lease deadlines', async () => {
  const base=await rig(JSON.stringify({timeoutSeconds:60}));
  const prepared=await rig(JSON.stringify({timeoutSeconds:60,preparationTimeoutMs:REPOSITORY_PREPARATION_TIMEOUT_MS}));
  try {
    expect(prepared.deadline-base.deadline).toBe(REPOSITORY_PREPARATION_TIMEOUT_MS);
    expect(await prepared.renew(prepared.deadline-1,prepared.deadline+1)).toBe(true);
    expect(prepared.expiry()).toBe(prepared.deadline);
    expect(await prepared.renew(prepared.deadline,prepared.deadline+1)).toBe(false);
  } finally {base.e.sqlite.close();prepared.e.sqlite.close();}
});
