/**
 * `hasConfiguredProvider` gates agent runs.
 *
 * Strict by default (the automatic Cortex per-grove path): an explicit provider
 * must be configured, so a grove with none is not silently auto-run.
 *
 * `{ allowDefaultHarness: true }` is for USER-INITIATED manual runs
 * (POST /api/agent/run): the default claude-sdk harness shells out to the Claude
 * Code CLI (subscription auth) and needs no provider config, so a logged-in user
 * can trigger a run on a fresh grove. A non-claude harness with no provider
 * genuinely cannot run and is still blocked in both modes.
 */
import { describe, it, expect } from 'bun:test';
import { hasConfiguredProvider } from '@myco/agent/config-resolver';
import type { MycoConfig } from '@myco/config/schema';

function cfg(agent: Record<string, unknown>): MycoConfig {
  return { agent } as unknown as MycoConfig;
}

describe('hasConfiguredProvider — strict by default (automatic runs)', () => {
  it('rejects a grove with no explicit provider (no auto-default)', () => {
    expect(hasConfiguredProvider(cfg({}))).toBe(false);
  });

  it('allows when an explicit global provider is configured', () => {
    expect(hasConfiguredProvider(cfg({ provider: { type: 'openai' } }))).toBe(true);
  });

  it('honors a per-task provider override', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { provider: { type: 'ollama' } } } }), 'skill-survey'),
    ).toBe(true);
  });
});

describe('hasConfiguredProvider — allowDefaultHarness (manual user-initiated runs)', () => {
  const manual = { allowDefaultHarness: true };

  it('allows a run with no explicit provider — the default harness is claude-sdk (subscription)', () => {
    expect(hasConfiguredProvider(cfg({}), undefined, manual)).toBe(true);
  });

  it('still allows when an explicit provider is configured', () => {
    expect(hasConfiguredProvider(cfg({ provider: { type: 'openai' } }), undefined, manual)).toBe(true);
  });

  it('blocks a non-claude harness configured without a provider', () => {
    expect(hasConfiguredProvider(cfg({ harness: 'openai-agents' }), undefined, manual)).toBe(false);
  });

  it('blocks a per-task non-claude harness without a provider', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { harness: 'openai-agents' } } }), 'skill-survey', manual),
    ).toBe(false);
  });

  it('a per-task claude-sdk harness needs no provider', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { harness: 'claude-sdk' } } }), 'skill-survey', manual),
    ).toBe(true);
  });

  it('blocks a run whose TASK DEFINITION pins a non-claude harness with no provider (guard matches executor)', () => {
    // The myco.yaml is silent, but the task definition's execution.harness is
    // openai-agents. The guard must see that (via definitionHarness) and reject,
    // so it never admits a run the executor resolves to a provider-less openai
    // harness (which would 401 at run time).
    expect(
      hasConfiguredProvider(cfg({}), 'some-task', { ...manual, definitionHarness: 'openai-agents' }),
    ).toBe(false);
  });

  it('a task definition pinning claude-sdk is fine with no provider', () => {
    expect(
      hasConfiguredProvider(cfg({}), 'some-task', { ...manual, definitionHarness: 'claude-sdk' }),
    ).toBe(true);
  });
});
