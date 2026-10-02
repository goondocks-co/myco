import { offeredHarness } from './helpers/offered-harness.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { fixtureRun } from '../helpers/execution-harness.ts';
import { harnessById } from '@myco/runner/harnesses.js';
import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { applyRunUpdate, getRun } from '@myco-server-worker/core/runs.js';
import { claimNextRun, endLeasedRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { readWork } from '@myco-server-worker/read/work.js';
import { listRuns } from '@myco-server-worker/read/runs.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const scope = { projectId: 'proj_1' };
const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 40, costUsd: null, estimatedCostUsd: 0.25 };

async function rig(harness = 'claude-code') {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'worker');
  const token = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [NOW]);
  e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
    VALUES ('proj_1','run_usage','myco-agent','extract-curate','queued',?,'worker',?,'{}','do it')`,
    [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 })]);
  await settingsWriter(e.db).setLeaf('agent.reasoning_map.codex.default', 'gpt-5.4-mini', 'mem_worker', NOW);
  const claim = () => claimNextRun(e.serverEnv, { tokenId: token.tokenId, machineId: 'm1', harnesses: [offeredHarness(harness)], now });
  const claimed = await claim();
  if (!claimed.claimed) throw new Error('run was not claimed');
  const end = async (extra: Record<string, unknown>) => {
    const response = await server.handleRequest(new Request('https://s/worker/end', {
      method: 'POST', headers: memberHeaders(token.token),
      body: JSON.stringify({ ...scope, runId: 'run_usage', status: 'failed', attemptId: claimed.run.attemptId, ...extra }),
    }), e.serverEnv);
    return response.json();
  };
  const detail = () => getRunDetail(e.db, scope, 'run_usage', Date.now(), 'mem_viewer');
  return { e, token, claimed, claim, end, detail, advance: (value: number) => { now = value; } };
}

describe('worker accounting on the Deployment', () => {
  it('persists selected model and partial evidence without publishing a partial run total', async () => {
    const r = await rig();
    const reported = { ...usage, inputTokens: 10206, outputTokens: 9, cachedTokens: 9984, estimatedCostUsd: null,
      provider: 'openai', model: 'gpt-5.6-sol', tokenScope: 'last_response' };
    try {
      expect(await r.end({ usage: reported })).toMatchObject({ ended: true });
      expect((await r.detail())?.run).toMatchObject({ provider: 'openai', model: 'gpt-5.6-sol', tokensUsed: null, costUsd: null, costSource: 'unavailable' });
      expect(JSON.parse((await r.detail())!.run.usageData!)).toEqual(reported);
      expect(await r.end({ usage: { ...reported, model: 'wrong' } })).toMatchObject({ ended: false });
      expect((await r.detail())?.run.model).toBe('gpt-5.6-sol');
    } finally { r.e.sqlite.close(); }
  });

  it('persists estimated spend and totals with a failed run, and ignores duplicate completion', async () => {
    const r = await rig();
    try {
      expect(await r.end({ usage, error: 'harness failed' })).toMatchObject({ ended: true, status: 'failed' });
      const detail = await r.detail();
      expect(detail?.run).toMatchObject({ tokensUsed: 120, costUsd: 0.25, estimatedCostUsd: 0.25, actualCostUsd: null, costSource: 'estimated' });
      expect(JSON.parse(detail!.run.usageData!)).toEqual(usage);
      expect(await r.end({ usage: { ...usage, estimatedCostUsd: 9 } })).toMatchObject({ ended: false });
      expect((await r.detail())?.run.costUsd).toBe(0.25);
      // The lease ends with the run; the worker that ran it stays named.
      expect(r.e.sqlite.query('SELECT leased_by IS NOT NULL AS named, lease_expires_at FROM agent_runs WHERE id=?').get('run_usage')).toEqual({ named: 1, lease_expires_at: null });
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

const identity = (model: string, reported: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; estimatedCostUsd: number | null; cachedTokens: number } = usage) => ({ status: 'reported', source: 'fixture.result', primary: { provider: 'openai', model },
  models: [{ provider: 'openai', model, source: 'fixture.result', usage: reported }] });

describe('model-specific execution accounting', () => {
  it('closes an opaque future accounting version and leaves identity not recorded', async () => {
    const r = await rig();
    try {
      expect(await r.end({ status: 'failed', accountingVersion: 2, identity: { future: 'opaque' }, usage })).toMatchObject({ ended: true, status: 'failed' });
      expect((await r.detail())?.run).toMatchObject({ status: 'failed', identity: { status: 'not_recorded' }, costUsd: 0.25 });
    } finally { r.e.sqlite.close(); }
  });
  it('stores provenance once and reads canonical or legacy provenance through every run surface', async () => {
    const r = await rig();
    try {
      expect(await r.end({ accountingVersion: 1, identity: identity('gpt-5.4-mini'), usage })).toMatchObject({ ended: true });
      const row = r.e.sqlite.query('SELECT usage_data,cost_data FROM agent_runs WHERE id=?').get('run_usage') as { usage_data: string; cost_data: string };
      expect(JSON.parse(row.usage_data)).not.toHaveProperty('costProvenance');
      expect(JSON.parse(row.cost_data)).toHaveProperty('provenance', 'harness_estimate');
      for (const legacy of [false, true]) {
        if (legacy) r.e.sqlite.run('UPDATE agent_runs SET usage_data=?,cost_data=NULL WHERE id=?', [JSON.stringify({ ...JSON.parse(row.usage_data), costProvenance: 'harness_estimate' }), 'run_usage']);
        expect((await r.detail())?.run.costProvenance).toBe('harness_estimate');
        expect((await listRuns(r.e.db, scope, NOW, 'mem_viewer')).rows[0]?.costProvenance).toBe('harness_estimate');
        expect((await readWork(r.e.db, { all: false, projectIds: ['proj_1'] }, NOW - 1, NOW + 1)).runs[0]?.costProvenance).toBe('harness_estimate');
      }
    } finally { r.e.sqlite.close(); }
  });
  it('carries the Codex run-owned session model over end wire into DB and read APIs', async () => {
    const r = await rig('codex');
    try {
      const wire = await fixtureRun(harnessById('codex')!, 'success', async (body) => Response.json(await r.end({ ...body, attemptId: r.claimed.run.attemptId })));
      expect(wire).toHaveProperty('identity.primary', { model: 'gpt-5.4-mini', provider: 'openai' });
      const stored = r.e.sqlite.query('SELECT model,provider,usage_data,cost_usd,error_code FROM agent_runs WHERE id=?').get('run_usage') as { model: string; provider: string; usage_data: string; cost_usd: number; error_code: string };
      expect(stored).toMatchObject({ model: 'gpt-5.4-mini', provider: 'openai', cost_usd: 0.000138, error_code: 'run_failed' });
      expect(JSON.parse(stored.usage_data)).toHaveProperty('identity.primary.model', 'gpt-5.4-mini');
      expect((await r.detail())?.run).toMatchObject({ identity: { primary: { model: 'gpt-5.4-mini' } }, errorCode: 'run_failed', costProvenance: 'model_pricing' });
      expect((await readWork(r.e.db, { all: false, projectIds: ['proj_1'] }, NOW - 1, NOW + 1)).runs[0]).toMatchObject({ model: 'gpt-5.4-mini', failure: { code: 'run_failed' }, identity: { primary: { model: 'gpt-5.4-mini' } }, costProvenance: 'model_pricing' });
    } finally { r.e.sqlite.close(); }
  });
  for (const [label, model, reported, expected] of [
    ['known', 'gpt-5.4-mini', { ...usage, estimatedCostUsd: null }, 0.000138],
    ['unknown', 'unknown', { ...usage, estimatedCostUsd: null }, null],
    ['partial', 'gpt-5.4-mini', { ...usage, inputTokens: null, estimatedCostUsd: null }, null],
  ] as const) {
    it(`prices ${label} accounting using only its reported model`, async () => {
      const r = await rig();
      try {
        expect(await r.end({ accountingVersion: 1, identity: identity(model, reported), usage: reported })).toMatchObject({ ended: true });
        expect((await r.detail())?.run).toMatchObject({ model, provider: 'openai', costUsd: expected,
          identity: { status: 'reported' }, costProvenance: expected === null ? 'unavailable' : 'model_pricing' });
      } finally { r.e.sqlite.close(); }
    });
  }
  it('prices each model from its own counts and retains versioned pricing evidence', async () => {
    const r = await rig();
    const models = [identity('gpt-5.4-mini', { ...usage, estimatedCostUsd: null }).models[0]!,
      identity('gpt-5.4-nano', { ...usage, inputTokens: 200, estimatedCostUsd: null }).models[0]!];
    try {
      expect(await r.end({ accountingVersion: 1, identity: { ...identity('gpt-5.4-mini'), models }, usage: { ...usage, inputTokens: 300, outputTokens: 40, estimatedCostUsd: null } })).toMatchObject({ ended: true });
      expect((await r.detail())?.run.costUsd).toBeCloseTo(0.0001958, 12);
      expect((await r.detail())?.run.costProvenance).toBe('model_pricing');
      const cost = r.e.sqlite.query('SELECT cost_data FROM agent_runs WHERE id=?').get('run_usage') as { cost_data: string };
      expect(JSON.parse(cost.cost_data).models).toMatchObject([{ model: 'gpt-5.4-mini', costUsd: 0.000138, pricingVersion: 'openai-api-pricing-2026-04-16' }, { model: 'gpt-5.4-nano', costUsd: expect.closeTo(0.0000578, 12) }]);
    } finally { r.e.sqlite.close(); }
  });
  it('keeps harness estimates and each model estimate without re-pricing or cache double charges', async () => {
    const r = await rig();
    const models = [identity('gpt-5.4-mini').models[0]!, identity('unknown', { ...usage, estimatedCostUsd: 0.1 }).models[0]!];
    try {
      expect(await r.end({ accountingVersion: 1, identity: { ...identity('gpt-5.4-mini'), models }, usage: { ...usage, estimatedCostUsd: 2.7343128 } })).toMatchObject({ ended: true });
      expect((await r.detail())?.run).toMatchObject({ costUsd: 2.7343128, costProvenance: 'harness_estimate', identity: { models } });
    } finally { r.e.sqlite.close(); }
  });
  for (const versioned of [true, false]) {
    it(`exposes ${versioned ? 'reported identity' : 'legacy not recorded'} on detail, run list and work`, async () => {
      const r = await rig('codex');
      try {
        expect(await r.end(versioned ? { accountingVersion: 1, identity: identity('gpt-5.4-mini'), usage } : {})).toMatchObject({ ended: true });
        const expected = versioned ? identity('gpt-5.4-mini') : { status: 'not_recorded' };
        expect((await r.detail())?.run).toHaveProperty('identity', expected);
        expect((await listRuns(r.e.db, scope, NOW, 'mem_viewer')).rows[0]).toHaveProperty('identity', expected);
        expect((await readWork(r.e.db, { all: false, projectIds: ['proj_1'] }, NOW - 1, NOW + 1)).runs[0]).toHaveProperty('identity', expected);
      } finally { r.e.sqlite.close(); }
    });
  }
  it('refuses stale identities and costs under the same worker before and after completion', async () => {
    const r = await rig();
    try {
      r.advance(NOW + WORKER_LEASE_MS);
      await expireLeases(r.e.serverEnv, NOW + WORKER_LEASE_MS);
      const next = await r.claim();
      if (!next.claimed) throw new Error('no reclaimed run');
      expect(await r.end({ accountingVersion: 1, identity: identity('wrong'), usage })).toMatchObject({ ended: false });
      expect((await r.detail())?.run).toHaveProperty('identity', { status: 'not_recorded' });
      expect(await r.end({ accountingVersion: 1, identity: identity('gpt-5.4-mini'), usage, attemptId: next.run.attemptId })).toMatchObject({ ended: true });
      expect(await r.end({ accountingVersion: 1, identity: identity('wrong'), usage })).toMatchObject({ ended: false });
      expect((await r.detail())?.run).toMatchObject({ identity: identity('gpt-5.4-mini'), costUsd: 0.25 });
    } finally { r.e.sqlite.close(); }
  });
});
