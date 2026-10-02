import { describe, expect, it } from 'bun:test';
import { resolveWorkerCost } from '@myco-server-worker/core/cost/worker.js';
import { runAccounting } from '@myco-server-worker/read/accounting.js';
import { parseWorkerAccounting, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { EFFORT_UNAPPLIED, PROFILE_WARNINGS } from '@goondocks/myco-shared/execution-profile';

const usage: WorkerUsage = { inputTokens: 100, outputTokens: 20, cachedTokens: 20, cacheCreationTokens: 15, cacheCreation5mTokens: 10, cacheCreation1hTokens: 5, costUsd: null };
const model = (id: string, context?: '1m') => ({ model: id, provider: 'anthropic', ...(context === undefined ? {} : { context }), source: 'fixture', usage });
const identity = (id: string, context?: '1m') => ({ status: 'reported' as const, source: 'fixture', primary: { model: id, provider: 'anthropic', ...(context === undefined ? {} : { context }) }, models: [model(id, context)] });

describe('complete model pricing and compatibility', () => {
  for (const [id, expected] of [['claude-opus-5-5', 0.000754], ['claude-sonnet-5-5', 0.000379], ['claude-haiku-4-5', 0.0001895]] as const) {
    it(`prices ${id} fresh input, cache reads and both cache-write TTLs once`, async () => {
      expect(await resolveWorkerCost('claude-code', usage, identity(id))).toMatchObject({ costUsd: expect.closeTo(expected, 12), provenance: 'model_pricing', models: [{ pricingVersion: 'anthropic-api-pricing-2026-10-01' }] });
    });
  }
  it('uses the reported context variant for Sonnet pricing and keeps current 1m pricing standard', async () => {
    expect(await resolveWorkerCost('claude-code', usage, identity('claude-sonnet-5-5', '1m'))).toMatchObject({ costUsd: expect.closeTo(0.000379, 12), provenance: 'model_pricing' });
    expect(await resolveWorkerCost('claude-code', usage, identity('claude-sonnet-4-5', '1m'))).toMatchObject({ costUsd: null, provenance: 'unavailable' });
  });
  it('prices a run whose identity says only how its profile was applied, and no run whose accounting is in doubt (#1608)', async () => {
    for (const warning of PROFILE_WARNINGS) {
      expect(await resolveWorkerCost('claude-code', usage, { ...identity('claude-haiku-4-5'), warnings: [warning] })).toMatchObject({ costUsd: expect.closeTo(0.0001895, 12), provenance: 'model_pricing' });
    }
    expect(PROFILE_WARNINGS).toContain(EFFORT_UNAPPLIED);
    expect(await resolveWorkerCost('claude-code', usage, { ...identity('claude-haiku-4-5'), warnings: ['model_list_truncated'] })).toMatchObject({ costUsd: null, provenance: 'unavailable' });
  });
  it('labels totals from harness dollars and table pricing as mixed', async () => {
    const reported = identity('claude-opus-5-5');
    reported.models.push({ ...model('claude-sonnet-5-5'), usage: { ...usage, costUsd: 0.25 } });
    expect(await resolveWorkerCost('claude-code', usage, reported)).toMatchObject({ costUsd: expect.closeTo(0.250754, 12), provenance: 'mixed' });
  });
  it('closes a future accounting version with identity not recorded instead of refusing it', () => {
    expect(parseWorkerAccounting({ accountingVersion: 2, attemptId: 'a', usage: { inputTokens: 10, outputTokens: 2, costUsd: null }, identity: { future: 'opaque' } }))
      .toEqual({ attemptId: 'a', usage: { inputTokens: 10, outputTokens: 2, costUsd: null } });
  });
  it('reads canonical cost provenance and falls back to the legacy usage location', () => {
    const data = { identity: identity('claude-sonnet-5-5') };
    expect(runAccounting(JSON.stringify(data), 'model_pricing')).toHaveProperty('costProvenance', 'model_pricing');
    expect(runAccounting(JSON.stringify({ ...data, costProvenance: 'harness_estimate' }), null)).toHaveProperty('costProvenance', 'harness_estimate');
    expect(runAccounting(JSON.stringify({ ...data, costProvenance: 'harness_estimate' }), 'mixed')).toHaveProperty('costProvenance', 'mixed');
  });
  it('retains known future scalar usage when nested model evidence has a new format', () => {
    expect(parseWorkerAccounting({ accountingVersion: 2, attemptId: 'a', usage: { inputTokens: 10, outputTokens: 2, costUsd: null, estimatedCostUsd: 0.2, cachedTokens: 3,
      models: { future: 'format' }, reasoningTokens: 'future', tokenScope: 'future' }, identity: { future: 'opaque' } }))
      .toEqual({ attemptId: 'a', usage: { inputTokens: 10, outputTokens: 2, costUsd: null, estimatedCostUsd: 0.2, cachedTokens: 3, tokenScope: 'unverified' } });
  });
});
