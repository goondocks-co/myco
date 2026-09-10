import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { applyRunUpdate, getRun } from '@myco-server-worker/core/runs.js';
import { claimNextRun, endLeasedRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const scope = { projectId: 'proj_1' };
const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 40, costUsd: null, estimatedCostUsd: 0.25 };

async function rig() {
  const e = sqliteEnv();
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'worker');
  const token = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [NOW]);
  e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
    VALUES ('proj_1','run_usage','myco-agent','extract-curate','queued',?,'worker',?,'{}','do it')`,
    [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 })]);
  const claim = () => claimNextRun(e.serverEnv, { tokenId: token.tokenId, machineId: 'm1', harnesses: [{ id: 'claude-code', authenticated: true }], now });
  const claimed = await claim();
  if (!claimed.claimed) throw new Error('run was not claimed');
  const end = async (extra: Record<string, unknown>) => {
    const response = await server.handleRequest(new Request('https://s/worker/end', {
      method: 'POST', headers: memberHeaders(token.token),
      body: JSON.stringify({ ...scope, runId: 'run_usage', status: 'failed', attemptId: claimed.run.attemptId, ...extra }),
    }), e.serverEnv);
    return response.json();
  };
  const detail = () => getRunDetail(e.db, scope, 'run_usage');
  return { e, token, claimed, claim, end, detail, advance: (value: number) => { now = value; } };
}

describe('worker accounting on the Deployment', () => {
  it('persists estimated spend and totals with a failed run, and ignores duplicate completion', async () => {
    const r = await rig();
    try {
      expect(await r.end({ usage, error: 'harness failed' })).toMatchObject({ ended: true, status: 'failed' });
      const detail = await r.detail();
      expect(detail?.run).toMatchObject({ tokensUsed: 120, costUsd: 0.25, estimatedCostUsd: 0.25, actualCostUsd: null, costSource: 'estimated' });
      expect(JSON.parse(detail!.run.usageData!)).toEqual(usage);
      expect(await r.end({ usage: { ...usage, estimatedCostUsd: 9 } })).toMatchObject({ ended: false });
      expect((await r.detail())?.run.costUsd).toBe(0.25);
      expect(r.e.sqlite.query('SELECT leased_by, lease_expires_at FROM agent_runs WHERE id=?').get('run_usage')).toEqual({ leased_by: null, lease_expires_at: null });
    } finally { r.e.sqlite.close(); }
  });

  it('retains unavailable cost and missing counts, including an older worker with no usage', async () => {
    for (const reported of [undefined, { inputTokens: null, outputTokens: 2, costUsd: null }]) {
      const r = await rig();
      try {
        expect(await r.end({ usage: reported, ...(reported === undefined ? { attemptId: undefined } : {}) })).toMatchObject({ ended: true });
        expect((await r.detail())?.run).toMatchObject({ tokensUsed: null, costUsd: null, actualCostUsd: null, estimatedCostUsd: null, costSource: reported === undefined ? null : 'unavailable' });
      } finally { r.e.sqlite.close(); }
    }
  });

  it('refuses malformed accounting before changing the run', async () => {
    const r = await rig();
    try {
      for (const invalid of [[], 'usage', { ...usage, inputTokens: -1 }, { ...usage, outputTokens: 1.5 }, { ...usage, estimatedCostUsd: '0.25' }, { ...usage, costUsd: 1e100 }, { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }]) {
        expect(await r.end({ usage: invalid })).toMatchObject({ persisted: false, code: 'parse' });
        expect((await r.detail())?.run).toMatchObject({ status: 'running', usageData: null });
      }
      expect(await r.end({ usage, attemptId: undefined })).toMatchObject({ persisted: false, code: 'parse' });
    } finally { r.e.sqlite.close(); }
  });

  it('refuses an old attempt even when the same worker reclaims the run', async () => {
    const r = await rig();
    try {
      r.advance(NOW + WORKER_LEASE_MS);
      await expireLeases(r.e.serverEnv, NOW + WORKER_LEASE_MS);
      const next = await r.claim();
      if (!next.claimed) throw new Error('run was not reclaimed');
      expect(next.run.attemptId).not.toBe(r.claimed.run.attemptId);
      expect(await r.end({ usage })).toMatchObject({ ended: false });
      expect((await r.detail())?.run).toMatchObject({ status: 'running', usageData: null });
      expect(await r.end({ usage, attemptId: next.run.attemptId })).toMatchObject({ ended: true });
    } finally { r.e.sqlite.close(); }
  });

  it('uses a fresh clock after preparation and refuses an expired lease', async () => {
    const r = await rig();
    try {
      let reads = 0;
      const clock = () => ++reads === 1 ? NOW : NOW + WORKER_LEASE_MS;
      expect(await endLeasedRun(r.e.serverEnv, { tokenId: r.token.tokenId, now: NOW, clock }, {
        ...scope, runId: 'run_usage', status: 'failed', usage, attemptId: r.claimed.run.attemptId,
      })).toMatchObject({ ended: false });
      expect((await r.detail())?.run).toMatchObject({ status: 'running', usageData: null });
    } finally { r.e.sqlite.close(); }
  });

  it('guards the accounting write itself against an attempt that changed after admission', async () => {
    const r = await rig();
    try {
      const old = await getRun(r.e.db, scope, 'run_usage');
      r.advance(NOW + WORKER_LEASE_MS);
      await expireLeases(r.e.serverEnv, NOW + WORKER_LEASE_MS);
      await r.claim();
      expect(await applyRunUpdate(r.e.db, scope, 'run_usage', { status: 'failed', cost_usd: 1 }, {
        tokenId: r.token.tokenId, dispatchedBy: old!.dispatchedBy!, now: NOW + WORKER_LEASE_MS,
      })).toBe(0);
      expect((await r.detail())?.run).toMatchObject({ status: 'running', costUsd: null });
    } finally { r.e.sqlite.close(); }
  });
});
