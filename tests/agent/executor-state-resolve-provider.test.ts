/**
 * First tests for resolveProviderForResume (executor-state.ts).
 *
 * Fix 7 regression (pre-tag cumulative review): the function spread the
 * LIVE matching provider config AFTER the persisted snapshot, so a
 * same-type resume silently adopted live myco.yaml values for overlapping
 * fields — violating the snapshot invariant that a resumed run reflects
 * the ORIGINAL dispatch's provider config. Blast radius was audit-bearing
 * fields: actions_taken.baseUrl and the token-budget contextLength.
 * Persisted must win over live for every overlapping field; live config
 * is only a fallback base for fields the snapshot never captured.
 */

import { describe, it, expect } from 'bun:test';
import { resolveProviderForResume, type RunCheckpointState } from '@myco/agent/executor-state.js';
import type { ProviderConfig } from '@myco/agent/types.js';

function checkpointWith(providerConfig?: ProviderConfig, provider?: ProviderConfig['type']): RunCheckpointState {
  return {
    schemaVersion: 2,
    harness: 'claude-sdk',
    ...(provider ? { provider } : {}),
    ...(providerConfig ? { providerConfig } : {}),
    phases: {},
  };
}

describe('resolveProviderForResume', () => {
  it('persisted snapshot wins over changed live config on a same-type resume (baseUrl + thinkingBudgetMap)', () => {
    const persisted: ProviderConfig = {
      type: 'anthropic',
      baseUrl: 'https://snapshot.example',
      thinkingBudgetMap: { low: { budgetTokens: 1_000 } },
    };
    // Operator edited myco.yaml between dispatch and resume: same provider
    // type, but different baseUrl and thinkingBudgetMap, plus a live-only
    // field (apiKey) the snapshot never captured.
    const liveCurrent: ProviderConfig = {
      type: 'anthropic',
      baseUrl: 'https://live-edited.example',
      thinkingBudgetMap: { low: { budgetTokens: 999_999 } },
      apiKey: 'live-only-key',
    };

    const resolved = resolveProviderForResume(
      liveCurrent,
      { provider: 'anthropic' },
      checkpointWith(persisted, 'anthropic'),
      'claude-sonnet-4',
    );

    expect(resolved).toBeDefined();
    // Overlapping fields: the ORIGINAL dispatch's values win.
    expect(resolved!.baseUrl).toBe('https://snapshot.example');
    expect(resolved!.thinkingBudgetMap).toEqual({ low: { budgetTokens: 1_000 } });
    // Snapshot-absent fields still fall back to live config.
    expect(resolved!.apiKey).toBe('live-only-key');
    expect(resolved!.type).toBe('anthropic');
    expect(resolved!.model).toBe('claude-sonnet-4');
  });

  it('different-type resume ignores the live provider entirely (persisted-only merge)', () => {
    const persisted: ProviderConfig = {
      type: 'openai',
      baseUrl: 'https://snapshot.example',
    };
    const liveCurrent: ProviderConfig = {
      type: 'anthropic',
      baseUrl: 'https://live.example',
      apiKey: 'live-key',
    };

    const resolved = resolveProviderForResume(
      liveCurrent,
      { provider: 'openai' },
      checkpointWith(persisted, 'openai'),
      'gpt-5',
    );

    expect(resolved).toBeDefined();
    expect(resolved!.type).toBe('openai');
    expect(resolved!.baseUrl).toBe('https://snapshot.example');
    // The live provider is a DIFFERENT type — none of its fields may leak in.
    expect(resolved!.apiKey).toBeUndefined();
    expect(resolved!.model).toBe('gpt-5');
  });

  it('returns the live provider unchanged when nothing was persisted', () => {
    const liveCurrent: ProviderConfig = { type: 'anthropic', baseUrl: 'https://live.example' };
    const resolved = resolveProviderForResume(
      liveCurrent,
      { provider: null },
      checkpointWith(),
      'claude-sonnet-4',
    );
    expect(resolved).toBe(liveCurrent);
  });
});
