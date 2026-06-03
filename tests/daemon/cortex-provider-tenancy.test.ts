/**
 * Cortex config-layer tenancy regression test.
 *
 * `triggerCortexInstructions` must resolve the provider/config check from the
 * REQUEST's grove — `loadMergedConfig(<request vaultDir>, { groveId })` — not
 * from the daemon's `liveConfig.current`. Agent/embedding config is grove-tier
 * (PR #394), and on the global daemon `liveConfig.current` is the merged config
 * for the daemon's bootstrap home (a phantom home post-Phase-5, or an arbitrary
 * anchor project before that). Reading it for a tenant op gates the request on
 * the wrong grove's provider state.
 *
 * The test stands up two real groves on disk:
 *   - Grove B: `agent.provider` configured.
 *   - Grove C: no `agent.provider`.
 * `triggerCortexInstructions` no longer takes a `liveConfig` dep at all — the
 * config is resolved structurally from the request grove inside the function,
 * so the daemon's bootstrap-home provider state CANNOT influence the outcome.
 * The correct behaviour: B passes the gate (proceeds past it), C is rejected
 * with `provider-not-configured` — the ONLY config source is the request grove.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveGroveConfig, saveMachineConfig, invalidateMergedConfigCache } from '@myco/config/loader';
import { triggerCortexInstructions } from '@myco/daemon/cortex';
import { resolveLegacyRequestContext } from '@myco/grove/request-context';
import { assertGroveProjectId } from '@myco/grove/ids';
import { useIsolatedHome } from '../support/isolated-home';

const GROVE_B_ID = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROJECT_B_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GROVE_C_ID = 'grove_cccccccccccccccccccccccccccccccc';
const PROJECT_C_ID = 'proj_cccccccccccccccccccccccccccccccc';

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} } as never;
}

describe('triggerCortexInstructions resolves provider config from the request grove', () => {
  useIsolatedHome('myco-cortex-tenancy-home-');
  let vaultB: string;
  let vaultC: string;

  beforeEach(() => {
    // Machine tier: NO provider, so the bootstrap default can't mask the
    // per-grove difference.
    saveMachineConfig({} as never);

    // Grove B has a configured agent provider; grove C does not.
    saveGroveConfig(GROVE_B_ID, {
      agent: { provider: { type: 'anthropic', model: 'claude-grove-b' } },
    } as never);
    saveGroveConfig(GROVE_C_ID, {
      // No agent.provider.
    } as never);

    // Project vaults carry only a minimal myco.yaml — no agent.provider — so
    // the provider gate's decision comes purely from the grove tier.
    vaultB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cortex-tenancy-vault-b-'));
    vaultC = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cortex-tenancy-vault-c-'));
    fs.writeFileSync(path.join(vaultB, 'myco.yaml'), 'version: 3\n', 'utf-8');
    fs.writeFileSync(path.join(vaultC, 'myco.yaml'), 'version: 3\n', 'utf-8');
    invalidateMergedConfigCache();
  });

  afterEach(() => {
    fs.rmSync(vaultB, { recursive: true, force: true });
    fs.rmSync(vaultC, { recursive: true, force: true });
    invalidateMergedConfigCache();
  });

  it('passes the provider gate for grove B (configured) — even though it gets there via B, not the daemon liveConfig', async () => {
    const requestContext = resolveLegacyRequestContext(vaultB, {
      projectId: assertGroveProjectId(PROJECT_B_ID),
      groveId: GROVE_B_ID,
      machineId: 'test-machine',
      tenancySource: 'caller',
    });

    const result = await triggerCortexInstructions({
      vaultDir: vaultB,
      requestContext,
      resolveEmbeddingManager: () => ({ reconcile() {} } as never),
      logger: noopLogger(),
      // Force the post-gate branch to short-circuit so the test does not need a
      // live DB / agent runtime. Reaching this branch proves the provider gate
      // passed for grove B.
      loadRunner: () => Promise.reject(new Error('runner unavailable (test)')),
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('agent-module-unavailable');
    // Crucially NOT provider-not-configured: grove B's provider gated this in.
    expect(result.reason).not.toBe('provider-not-configured');
  });

  it('rejects grove C (no provider) with provider-not-configured — no daemon config can save it', async () => {
    const requestContext = resolveLegacyRequestContext(vaultC, {
      projectId: assertGroveProjectId(PROJECT_C_ID),
      groveId: GROVE_C_ID,
      machineId: 'test-machine',
      tenancySource: 'caller',
    });

    const result = await triggerCortexInstructions({
      vaultDir: vaultC,
      requestContext,
      resolveEmbeddingManager: () => ({ reconcile() {} } as never),
      logger: noopLogger(),
      loadRunner: () => Promise.reject(new Error('runner should not be reached')),
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('provider-not-configured');
  });
});
