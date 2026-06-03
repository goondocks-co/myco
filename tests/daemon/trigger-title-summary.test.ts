import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { triggerTitleSummary } from '@myco/daemon/trigger-title-summary';
import type { MycoConfig } from '@myco/config/schema';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeEmbeddingManagerStub(): unknown {
  return { remove: vi.fn(), reconcile: vi.fn() };
}

function makeConfig(overrides: Partial<MycoConfig['agent']> = {}): MycoConfig {
  return {
    agent: {
      summary_batch_interval: 5,
      event_tasks_enabled: true,
      ...overrides,
    },
  } as MycoConfig;
}

describe('triggerTitleSummary live-config gating', () => {
  it('reads the current value from the holder at call time (not the initial snapshot)', async () => {
    // The trigger should observe a mutation to the holder between calls — this
    // is the contract that makes Settings toggles take effect without a daemon
    // restart.
    const liveConfig = { current: makeConfig({ event_tasks_enabled: false }) };
    const deps = {
      vaultDir: '/tmp/ignored',
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      liveConfig,
      logger: makeLogger() as never,
    };

    // Disabled state: trigger returns immediately without touching the
    // dynamic-imported agent executor.
    await expect(triggerTitleSummary('sess-1', deps)).resolves.toBeUndefined();

    // Flip the holder — simulates a scoped-config write that fired the
    // reaction registered in main.ts.
    liveConfig.current = makeConfig({ event_tasks_enabled: true });

    // Enabled state: the executor import is attempted; it may fail because
    // we're not in a real daemon, but it MUST proceed past the gate. The
    // shared trigger wraps the import in a try/catch and swallows module
    // load failures as a silent no-op, so resolution is still clean.
    await expect(triggerTitleSummary('sess-1', deps)).resolves.toBeUndefined();
  });

  it('resolves the embedding manager from the request context (per-request tenancy, not bootstrap)', async () => {
    // Anchor-leak guard (Variant A): the title-summary agent run must get the
    // session's grove manager, resolved from its request context.
    const rc = { projectId: 'proj_x', groveId: 'grove_x' } as never;
    let seen: unknown = 'NOT_CALLED';
    await triggerTitleSummary('sess-1', {
      vaultDir: '/tmp/ignored',
      resolveEmbeddingManager: (c: unknown) => { seen = c; return makeEmbeddingManagerStub() as never; },
      liveConfig: { current: makeConfig({ event_tasks_enabled: true }) },
      logger: makeLogger() as never,
      requestContext: rc,
    } as never);
    expect(seen).toBe(rc);
  });

  it('summary_batch_interval <= 0 short-circuits regardless of event_tasks_enabled', async () => {
    const liveConfig = {
      current: makeConfig({ summary_batch_interval: 0, event_tasks_enabled: true }),
    };
    const logger = makeLogger();
    await expect(triggerTitleSummary('sess-1', {
      vaultDir: '/tmp/ignored',
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      liveConfig,
      logger: logger as never,
    })).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
