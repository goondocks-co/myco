/**
 * `hasConfiguredProvider` gates manual agent runs (POST /api/agent/run) and the
 * Cortex-instructions run. The default harness is claude-sdk, which shells out
 * to the Claude Code CLI (subscription auth) and needs NO provider config — so a
 * run with no explicit provider is still runnable and must NOT be rejected. A
 * non-claude harness configured without a provider genuinely cannot run and is
 * still blocked.
 */
import { describe, it, expect } from 'bun:test';
import { hasConfiguredProvider } from '@myco/agent/config-resolver';
import type { MycoConfig } from '@myco/config/schema';

function cfg(agent: Record<string, unknown>): MycoConfig {
  return { agent } as unknown as MycoConfig;
}

describe('hasConfiguredProvider', () => {
  it('allows a run with no explicit provider — the default harness is claude-sdk (subscription)', () => {
    expect(hasConfiguredProvider(cfg({}))).toBe(true);
  });

  it('allows when an explicit global provider is configured', () => {
    expect(hasConfiguredProvider(cfg({ provider: { type: 'openai' } }))).toBe(true);
  });

  it('blocks a non-claude harness configured without a provider', () => {
    expect(hasConfiguredProvider(cfg({ harness: 'openai-agents' }))).toBe(false);
  });

  it('honors a per-task provider override', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { provider: { type: 'ollama' } } } }), 'skill-survey'),
    ).toBe(true);
  });

  it('blocks a per-task non-claude harness without a provider', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { harness: 'openai-agents' } } }), 'skill-survey'),
    ).toBe(false);
  });

  it('a per-task claude-sdk harness needs no provider', () => {
    expect(
      hasConfiguredProvider(cfg({ tasks: { 'skill-survey': { harness: 'claude-sdk' } } }), 'skill-survey'),
    ).toBe(true);
  });
});
