import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HARNESSES } from '@myco/runner/harnesses.js';
import { ExecutionAccounting } from '@myco/runner/accounting.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { parseExecutionIdentity, parseWorkerAccounting } from '@goondocks/myco-shared/worker-usage';
import { fixtureRun } from '../helpers/execution-harness.ts';

const codex = HARNESSES.find((h) => h.id === 'codex')!;
const claude = HARNESSES.find((h) => h.id === 'claude-code')!;
const recorded = (name: string): Record<string, unknown>[] => readFileSync(new URL(`../fixtures/runner/${name}.stream.jsonl`, import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const updateZero = (events: AcpEvents) => [...events.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'usage_update', cost: { currency: 'USD', amount: 0 } } } }, 's')];

describe('accounting cannot change the harness outcome', () => {
  it('closes a completed Codex turn with known usage and an unknown identity after a torn session line', async () => {
    expect(await fixtureRun(codex, 'truncated')).toMatchObject({ status: 'completed', error: null,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
      identity: { status: 'unknown', reason: 'codex_session_torn_last_line' } });
  });
  it('trims a reported model name and keeps the completed run and usage', async () => {
    expect(await fixtureRun(codex, 'spaced')).toMatchObject({ status: 'completed', usage: { inputTokens: 100, model: 'gpt-x' }, identity: { primary: { model: 'gpt-x' } } });
  });
  for (const [outcome, warning] of [['oversized', 'model_name_truncated'], ['many_models', 'model_list_truncated']]) {
    it(`bounds ${outcome} evidence with a reason while keeping completion and usage`, async () => {
      const report = await fixtureRun(codex, outcome!);
      expect(report).toMatchObject({ status: 'completed', usage: { inputTokens: 100 }, identity: { status: 'reported' } });
      const identity = parseWorkerAccounting(report).identity;
      if (identity === undefined || identity.status === 'unknown') throw new Error('Expected bounded model evidence');
      expect(identity).toHaveProperty('warnings', expect.arrayContaining([warning]));
      expect(identity.models.length).toBeLessThanOrEqual(64);
      expect(identity.primary.model.length).toBeLessThanOrEqual(256);
    });
  }
  it('surfaces an invalid identity without throwing or losing preceding usage', () => {
    const accounting = new ExecutionAccounting();
    accounting.usage({ inputTokens: 12, outputTokens: 3, costUsd: null });
    expect(() => accounting.observe({ status: 'reported', source: 'fixture', primary: { model: 'm' }, models: [] })).not.toThrow();
    expect(accounting.identity).toMatchObject({ status: 'unknown', reason: expect.stringContaining('accounting_extraction_failed') });
    expect(() => accounting.usage({ inputTokens: null, outputTokens: null, costUsd: null, tokenScope: 'unverified', model: '\u0000' })).not.toThrow();
    expect(accounting.totals).toMatchObject({ inputTokens: 12, outputTokens: 3, tokenScope: 'unverified' });
  });
  it('treats a subscription zero as unavailable and a manifest-declared real zero as a price', () => {
    const events = new AcpEvents('opencode', '1.18.29', { models: { currentModelId: 'openai/m' } });
    updateZero(events);
    expect(events.usage({})).toHaveProperty('estimatedCostUsd', null);
    const policy = { ...HARNESSES.find((h) => h.id === 'opencode')!.accounting, zeroDollars: 'reported' as const };
    const priced = new AcpEvents('opencode', '1.18.29', { models: { currentModelId: 'openai/m' } }, policy);
    updateZero(priced);
    expect(priced.usage({})).toHaveProperty('estimatedCostUsd', 0);
  });
  it('preserves a recorded Sonnet run and its Haiku sub-call through the worker accounting boundary', async () => {
    const report = await fixtureRun(claude, 'success', undefined, { stream: recorded('claude-sonnet-haiku') });
    expect(report).toMatchObject({ status: 'completed', identity: { primary: { model: 'claude-sonnet-5-5' }, models: [
      { model: 'claude-sonnet-5-5', usage: { inputTokens: 13147, outputTokens: 171, cachedTokens: 6345, cacheCreationTokens: 6798, cacheCreation5mTokens: 0, cacheCreation1hTokens: 6798, estimatedCostUsd: 0.030179 } },
      { model: 'claude-haiku-4-5-20251001', usage: { inputTokens: 694, outputTokens: 84, estimatedCostUsd: 0.001114 } },
    ] }, usage: { estimatedCostUsd: 0.031293, model: 'claude-sonnet-5-5' } });
  });
  it('merges recorded Claude 1m and bare spellings into a bare primary with context', async () => {
    const report = await fixtureRun(claude, 'success', undefined, { stream: recorded('claude-opus-1m') });
    expect(report).toMatchObject({ status: 'completed', identity: { primary: { model: 'claude-opus-5-5', provider: 'anthropic', context: '1m' }, models: [
      { model: 'claude-opus-5-5', context: '1m', usage: { inputTokens: 2659, outputTokens: 7, cachedTokens: 535, cacheCreationTokens: 2122, cacheCreation5mTokens: 0, cacheCreation1hTokens: 2122, estimatedCostUsd: 0.017231000000000003 } },
    ] }, usage: { model: 'claude-opus-5-5' } });
    expect(parseWorkerAccounting(report).identity).toHaveProperty('models.length', 1);
  });
  it('sums counts and dollars when one result names both bare and 1m spellings', async () => {
    const stream = recorded('claude-opus-1m');
    const result = stream.find((line) => line.type === 'result')!;
    const models = result.modelUsage as Record<string, Record<string, unknown>>;
    models['claude-opus-5-5'] = { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00008 };
    const report = await fixtureRun(claude, 'success', undefined, { stream });
    const identity = parseWorkerAccounting(report).identity;
    expect(identity).toMatchObject({ primary: { model: 'claude-opus-5-5', context: '1m' }, models: [
      { model: 'claude-opus-5-5', context: '1m', usage: { inputTokens: 2669, outputTokens: 9, estimatedCostUsd: expect.closeTo(0.017311, 12) } },
    ] });
    expect(identity).toHaveProperty('models.length', 1);
  });
  for (const [features, advertised] of [[null, false], ['turn,worker-accounting-v1', true]] as const) {
    it(`negotiates accounting with an ${advertised ? 'advertising' : 'older'} server and keeps the legacy model`, async () => {
      const report = await fixtureRun(codex, 'success', undefined, { features });
      expect(report).toHaveProperty('usage.model', 'gpt-5.4-mini');
      expect(Object.hasOwn(report!, 'identity')).toBe(advertised);
      expect(Object.hasOwn(report!, 'accountingVersion')).toBe(advertised);
    });
  }
  for (const [name, credentialEnv, provider] of [
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, 'bedrock'],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }, 'vertex'],
    ['ambiguous', { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' }, undefined],
  ] as const) {
    it(`records the ${name} provider from the actual Claude launch environment`, async () => {
      const identity = parseWorkerAccounting(await fixtureRun(claude, 'success', undefined, { credentialEnv })).identity;
      expect(identity?.status).toBe('reported');
      if (identity?.status !== 'reported') throw new Error('Expected a reported model');
      expect(identity.primary.provider).toBe(provider);
    });
  }
  it('explains that a primary model must be in the accounting models', () => {
    expect(() => parseExecutionIdentity({ status: 'reported', source: 's', primary: { model: 'absent' }, models: [{ model: 'm', source: 's', usage: null }] }))
      .toThrow('Primary model must be in the accounting models.');
  });
});
