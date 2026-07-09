import { describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { createConfigReactionRegistry } from '@myco/daemon/config-reactions/registry.js';
import { createOkfReconcileReaction } from '@myco/daemon/okf-reconcile-reaction.js';
import type { MycoConfig } from '@myco/config/schema.js';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ctx = {} as MycoConfig;

describe('createOkfReconcileReaction', () => {
  it('reconciles the written project (and only that project) on an okf.* write', async () => {
    const reconcile = vi.fn();
    const registry = createConfigReactionRegistry(makeLogger());
    registry.on(['okf'], createOkfReconcileReaction({ reconcile }));

    await registry.fire(['okf.enabled'], ctx, {
      vaultDir: '/tmp/proj-a/.myco',
      groveId: 'grove_okf_test',
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('/tmp/proj-a', '/tmp/proj-a/.myco', 'grove_okf_test');
  });

  it('fires for nested okf paths and not for unrelated writes', async () => {
    const reconcile = vi.fn();
    const registry = createConfigReactionRegistry(makeLogger());
    registry.on(['okf'], createOkfReconcileReaction({ reconcile }));

    await registry.fire(['okf.maintain.managed_agents_md_pointer'], ctx, {
      vaultDir: '/tmp/proj-b/.myco',
      groveId: null,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('/tmp/proj-b', '/tmp/proj-b/.myco', null);

    await registry.fire(['capture.plan_dirs', 'daemon.log_level'], ctx, {
      vaultDir: '/tmp/proj-b/.myco',
      groveId: null,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
