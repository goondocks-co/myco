import { legacyWorker } from './helpers/worker-principal.js';
import { describe, expect, it } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { applyRunUpdate } from '@myco-server-worker/core/runs.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { sqliteEnv } from './helpers/fixtures.js';

async function fixture() {
  const f = sqliteEnv();
  const now = Date.now();
  await ensureMember(f.db, 'mem_worker', now, 'admin', 'worker');
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const worker = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'worker-machine' }, now);
  const harness = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness-machine' }, now);
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,leased_by,lease_expires_at,dispatched_by)
    VALUES('proj_1','dual-authority','myco-agent','vault-seed','running',?,?,?,?,?)`,
  [now, now, worker.tokenId, now + 10_000, harness.tokenId]);
  const lease = { worker: legacyWorker(worker.tokenId, 'm1'), dispatchedBy: harness.tokenId, now };
  const caller = { tokenId: harness.tokenId, now, deadline: now + 5_000 };
  const update = () => applyRunUpdate(f.db, { projectId: 'proj_1' }, 'dual-authority', { tokens_used: 42 }, lease, 'run_failed', undefined, caller);
  return { ...f, now, worker, harness, lease, caller, update };
}

describe('worker lease and dispatched runtime authority', () => {
  it('binds all caller parameters after the separate lease lineage parameters', async () => {
    const f = await fixture();
    try {
      expect(f.worker.tokenId).not.toBe(f.harness.tokenId);
      expect(await f.update()).toBe(1);
      expect(f.sqlite.query("SELECT tokens_used FROM agent_runs WHERE id='dual-authority'").get()).toEqual({ tokens_used: 42 });
    } finally { f.sqlite.close(); }
  });

  for (const refusal of ['worker-lineage', 'worker-expiry', 'dispatch', 'dispatch-revocation', 'deadline'] as const) {
    it(`keeps both guards when refusing ${refusal}`, async () => {
      const f = await fixture();
      try {
        if (refusal === 'worker-lineage') f.lease.worker = legacyWorker(f.harness.tokenId, 'm1');
        if (refusal === 'worker-expiry') f.sqlite.run('UPDATE member_credentials SET expires_at=? WHERE id=?', [f.now, f.worker.tokenId]);
        if (refusal === 'dispatch') f.caller.tokenId = f.worker.tokenId;
        if (refusal === 'dispatch-revocation') f.sqlite.run('UPDATE member_credentials SET revoked_at=? WHERE id=?', [f.now, f.harness.tokenId]);
        if (refusal === 'deadline') f.caller.deadline = f.now;
        expect(await f.update()).toBe(0);
        expect(f.sqlite.query("SELECT tokens_used FROM agent_runs WHERE id='dual-authority'").get()).toEqual({ tokens_used: null });
      } finally { f.sqlite.close(); }
    });
  }
});
