import { describe, expect, it } from 'bun:test';
import { HARNESSES, offerable } from '@myco/runner/harnesses.js';
import { claudeUsage } from '@myco/runner/drivers/usage.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { parseWorkerAccounting } from '@goondocks/myco-shared/worker-usage';
import { fixtureRun } from '../helpers/execution-harness.ts';

describe('execution identity on every profile-capable runner end', () => {
  const runnable = HARNESSES.filter((harness) => offerable(harness) && harness.profile.model !== 'none');
  for (const harness of runnable) {
    for (const outcome of ['success', 'failed_call', 'no_result', 'no_usage']) {
      it(`${harness.id} records identity on ${outcome}`, async () => {
        const report = await fixtureRun(harness, outcome);
        expect(report).toHaveProperty('accountingVersion', 1);
        expect(report).toHaveProperty('identity.status');
        expect(() => parseWorkerAccounting(report)).not.toThrow();
        expect(harness).toHaveProperty('accounting');
        expect(report).toHaveProperty('identity.status', 'reported');
        if (harness.id === 'codex') expect(report).toHaveProperty('identity.primary', { model: 'gpt-5.4-mini', provider: 'openai' });
        if (outcome === 'failed_call') expect(report?.error).toContain('failed');
        if (outcome === 'no_result') expect(report?.status).toBe('failed');
      });
    }
  }
  for (const harness of runnable.filter((harness) => harness.id !== 'codex')) {
    it(`${harness.id} explains an unresolved model even with no usable identity`, async () => {
      expect(await fixtureRun(harness, 'unknown')).toHaveProperty('identity', { status: 'unknown', reason: 'harness_did_not_report_model_and_launch_choice_unresolved' });
    });
  }
  it('ends an OpenCode run whose claimed model the harness does not offer as unapplied, never on the harness\'s default (#1608)', async () => {
    const report = await fixtureRun(HARNESSES.find((h) => h.id === 'opencode')!, 'unoffered');
    expect({ status: report?.status, unapplied: String(report?.error).includes('profile_unapplied: it offers no model openai/gpt-5.4-mini (it offers opencode/big-pickle)') })
      .toEqual({ status: 'failed', unapplied: true });
    expect(report).toHaveProperty('identity.status', 'unknown');
  });
  it('records the real pinned Codex launch choice when the run session has no model', async () => {
    expect(await fixtureRun(HARNESSES.find((h) => h.id === 'codex')!, 'launched')).toHaveProperty('identity', {
      status: 'launched', source: 'launch.config.model', primary: { model: 'configured-model', provider: 'openai' },
      models: [{ model: 'configured-model', provider: 'openai', source: 'launch.config.model', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40, costUsd: null } }],
    });
  });
  it('keeps all Codex session models and attributes cumulative count deltas once', async () => {
    expect(await fixtureRun(HARNESSES.find((h) => h.id === 'codex')!, 'multi_model')).toHaveProperty('identity.models', [
      { model: 'gpt-5.4-mini', provider: 'openai', source: 'session.turn_context.model', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40, reasoningTokens: 0, costUsd: null } },
      { model: 'gpt-5.4-nano', provider: 'openai', source: 'session.turn_context.model', usage: { inputTokens: 200, outputTokens: 20, cachedTokens: 40, reasoningTokens: 0, costUsd: null } },
    ]);
  });
  it('refuses another session identity and retains only the pinned Codex launch choice', async () => {
    expect(await fixtureRun(HARNESSES.find((h) => h.id === 'codex')!, 'foreign_session')).toHaveProperty('identity.status', 'launched');
  });
  it('ignores malformed unrelated Codex sessions and a matching id with a stale cwd', async () => {
    expect(await fixtureRun(HARNESSES.find((h) => h.id === 'codex')!, 'foreign_noise')).toHaveProperty('identity.primary', { model: 'gpt-5.4-mini', provider: 'openai' });
  });
  it('replaces unused ACP selections and retains models that produced activity', async () => {
    const report = await fixtureRun(HARNESSES.find((h) => h.id === 'opencode')!, 'acp_replace_unused');
    expect(report).toHaveProperty('identity.models');
    const identity = parseWorkerAccounting(report).identity;
    if (identity === undefined || identity.status === 'unknown') throw new Error('Fixture has no reported models');
    const models = identity.models.map((m) => m.model);
    expect(models).toEqual(['used-first', 'used-last']);
  });
  for (const evidence of ['spend', 'tokens']) {
    it(`retains an ACP model with reported ${evidence} before visible activity`, async () => {
      const report = await fixtureRun(HARNESSES.find((h) => h.id === 'opencode')!, `acp_usage_${evidence}`);
      expect(report).toHaveProperty('identity.models');
      const identity = parseWorkerAccounting(report).identity;
      if (identity === undefined || identity.status === 'unknown') throw new Error('Fixture has no reported models');
      const models = identity.models.map((m) => m.model);
      expect(models).toEqual(['gpt-5.4-mini', 'gpt-5.4-nano']);
    });
  }
  it('requires a versioned identity and an attempt before accepting new accounting', () => {
    for (const raw of [ { accountingVersion: 1, attemptId: 'a' },
      { accountingVersion: 1, identity: { status: 'unknown', reason: 'unresolved' } },
      { accountingVersion: 1, attemptId: 'a', identity: { status: 'reported', primary: { model: 'm' }, source: 's', models: [] } },
    ]) expect(() => parseWorkerAccounting(raw)).toThrow();
  });
  it('preserves Claude per-model names, inclusive counts and estimates', () => {
    const usage = claudeUsage({ total_cost_usd: 0.5, modelUsage: {
      sonnet: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, costUSD: 0.4 },
      haiku: { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 0, costUSD: 0.1 },
    } });
    expect(usage).toMatchObject({ inputTokens: 46, outputTokens: 9, estimatedCostUsd: 0.5, models: [
      { model: 'sonnet', provider: 'anthropic', usage: { inputTokens: 35, outputTokens: 3, cachedTokens: 20, cacheCreationTokens: 5, estimatedCostUsd: 0.4 } },
      { model: 'haiku', provider: 'anthropic', usage: { inputTokens: 11, outputTokens: 6, cachedTokens: 7, cacheCreationTokens: 0, estimatedCostUsd: 0.1 } },
    ] });
  });
  it('retains ACP model updates and treats a subscription zero as unavailable', () => {
    const events = new AcpEvents('opencode', '1.18.29', { configOptions: [{ id: 'model', currentValue: 'openai/first' }] });
    expect([...events.identity()]).toContainEqual(expect.objectContaining({ identity: expect.objectContaining({ source: 'session.configOptions' }) }));
    const updated = [...events.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'current_model_update', currentModelId: 'openai/second' } } }, 's')];
    expect(updated).toContainEqual(expect.objectContaining({ kind: 'identity' }));
    [...events.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'usage_update', cost: { currency: 'USD', amount: 0 } } } }, 's')];
    expect(events.usage({})).toMatchObject({ model: 'second', estimatedCostUsd: null });
  });
});
