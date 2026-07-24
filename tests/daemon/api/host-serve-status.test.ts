/**
 * Team Host operator-side serving status (Team Host E-4 W1 Task T4):
 *
 *   GET /api/host-serve/status
 *
 * Unconditional positive read (never a refusal): a not-serving machine
 * returns `{ serving: false }`; a serving machine returns the full shape
 * described in `daemon/api/host-serve-status.ts`'s module docstring. Covers:
 * not-serving, the full serving shape (including a dangling designation),
 * the classifier-bundle TTL cache, the `process.env` isolation the
 * `resolveServedGroveKeyHealthIsolated` wrapper guarantees, and the
 * key-leak guard (presence booleans only — no secret ever serialized).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createHostServeStatusHandler as createHostServeStatusHandlerWith,
  type HostServeStatusRouteDeps,
} from '@myco/daemon/api/host-serve-status.js';
import type { HostServeRuntime } from '@myco/daemon/host-serve.js';
import { createGroveId, createProjectId } from '@myco/grove/ids.js';
import { createGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import { loadMachineConfig, saveMachineConfig } from '@myco/config/loader.js';
import { createSecretsOperations } from '@myco/config/secrets.js';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '@myco/constants.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';

const { writeSecret } = createSecretsOperations(testPerUserLockNamespace);
const createHostServeStatusHandler = (deps: HostServeStatusRouteDeps) =>
  createHostServeStatusHandlerWith({
    ...deps,
    lockNamespace: testPerUserLockNamespace,
  });

function req(): RouteRequest {
  return { body: undefined, query: {}, params: {}, pathname: '/api/host-serve/status' };
}

describe('GET /api/host-serve/status', () => {
  let home: string;
  // Snapshot/restore around every test, not just the isolation test below:
  // an assertion failure mid-test still runs afterEach, so this is the only
  // way to guarantee an ambient ANTHROPIC_API_KEY (real dev shells often
  // have one) survives this suite instead of leaking its deletion into
  // whichever test file bun runs next — this repo's recurring cross-file
  // env-pollution flake class.
  let originalAnthropicKey: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-serve-status-'));
    clearGroveRegistryCaches();
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    clearGroveRegistryCaches();
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  test('not serving (hostServe: null) -> { serving: false }, no disk read at all', async () => {
    let loadCalled = false;
    const handler = createHostServeStatusHandler({
      hostServe: null,
      mycoHome: home,
      loadMachineConfig: (h) => { loadCalled = true; return loadMachineConfig(h); },
    });
    const res = await handler(req());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serving: false });
    expect(loadCalled).toBe(false);
  });

  test('serving, designated, no backup yet, no provider, external MCP off -> full shape with defaults', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);

    const runtime: HostServeRuntime = {
      overlayAddress: '100.64.0.1:7433',
      bearer: 'test-host-serve-bearer',
      hostId: 'host_abc',
      label: 'Mac Studio',
      servedGroveId: grove.id,
    };
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const res = await handler(req());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      serving: true,
      served_grove_id: grove.id,
      served_grove_name: 'Served',
      hosted_project_count: 0,
      overlay_address: '100.64.0.1:7433',
      host_id: 'host_abc',
      label: 'Mac Studio',
      external_mcp: { enabled: false, port: machine.daemon.external_mcp.port, bound: null, token_present: false },
      bearer_present: true,
      health: { designation: 'ok', backup: 'stale', key: 'not_applicable', mcp_coherence: 'not_enabled' },
    });
  });

  test('hosted_project_count reflects registered synthetic-root rows in the served grove (AC #12)', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);

    // Zero to start.
    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b', servedGroveId: grove.id };
    const before = await createHostServeStatusHandler({ hostServe: runtime, mycoHome: home })(req());
    expect((before.body as { hosted_project_count: number }).hosted_project_count).toBe(0);

    // Register two hosted projects via the registration-on-ingest seam.
    const { maybeRegisterHostedProjectOnIngest } = await import('@myco/host/hosted-projects.js');
    for (let i = 0; i < 2; i += 1) {
      maybeRegisterHostedProjectOnIngest({
        method: 'POST',
        pathname: '/sessions/register',
        headers: { 'x-myco-grove-id': grove.id, 'x-myco-project-id': createProjectId() },
        servedGroveId: grove.id,
        mycoHome: home,
      });
    }
    clearGroveRegistryCaches();

    // A fresh handler (the count is inside the TTL cache) sees both rows.
    const after = await createHostServeStatusHandler({ hostServe: runtime, mycoHome: home })(req());
    expect((after.body as { hosted_project_count: number }).hosted_project_count).toBe(2);
  });

  test('undesignated (served_grove_id null on disk) -> health.designation undesignated, served_grove_name null', async () => {
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: null } },
    }, home);

    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b' };
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const res = await handler(req());
    const body = res.body as { served_grove_id: string | null; served_grove_name: string | null; health: { designation: string } };
    expect(body.served_grove_id).toBeNull();
    expect(body.served_grove_name).toBeNull();
    expect(body.health.designation).toBe('undesignated');
  });

  test('dangling designation (on-disk served_grove_id names no Grove) -> health.designation dangling, served_grove_name null', async () => {
    const danglingGroveId = createGroveId(); // never created in `home` — simulates deletion after boot.
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: danglingGroveId } },
    }, home);

    // The runtime's OWN servedGroveId reflects what resolveHostServeConfig
    // resolved at boot, when the grove presumably still existed — it can
    // legitimately diverge from the on-disk classifier's fresh read, which is
    // exactly the scenario this route exists to surface.
    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b', servedGroveId: danglingGroveId };
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const res = await handler(req());
    const body = res.body as { served_grove_id: string; served_grove_name: string | null; health: { designation: string } };
    expect(body.served_grove_id).toBe(danglingGroveId);
    expect(body.served_grove_name).toBeNull();
    expect(body.health.designation).toBe('dangling');
  });

  test('external_mcp.bound reflects the injected listener; null when no listener is threaded in', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);
    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b', servedGroveId: grove.id };

    const boundHandler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home, externalMcp: { listener: { isBound: true } } });
    const boundRes = await boundHandler(req());
    expect((boundRes.body as { external_mcp: { bound: boolean | null } }).external_mcp.bound).toBe(true);

    const unboundHandler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home, externalMcp: { listener: { isBound: false } } });
    const unboundRes = await unboundHandler(req());
    expect((unboundRes.body as { external_mcp: { bound: boolean | null } }).external_mcp.bound).toBe(false);

    const noListenerHandler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const noListenerRes = await noListenerHandler(req());
    expect((noListenerRes.body as { external_mcp: { bound: boolean | null } }).external_mcp.bound).toBeNull();
  });

  test('bearer_present is false for an empty/blank bearer', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);
    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: '   ', servedGroveId: grove.id };
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const res = await handler(req());
    expect((res.body as { bearer_present: boolean }).bearer_present).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Key-leak guard: presence booleans only, never the raw secret values.
  // ---------------------------------------------------------------------------

  test('KEY-LEAK GUARD: neither the host bearer nor the external MCP token ever appear in the serialized response', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: {
        ...machine.daemon,
        host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id },
        external_mcp: { enabled: true, port: machine.daemon.external_mcp.port },
      },
    }, home);
    const BEARER_SENTINEL = 'sk-sentinel-host-serve-bearer-ABCDEF1234567890';
    const TOKEN_SENTINEL = 'sk-sentinel-external-mcp-token-ZYXWVUTSRQ9876';
    writeSecret(home, HOST_EXTERNAL_MCP_TOKEN_SECRET, TOKEN_SENTINEL);

    const runtime: HostServeRuntime = {
      overlayAddress: '100.64.0.1:7433', bearer: BEARER_SENTINEL, servedGroveId: grove.id,
    };
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home });
    const res = await handler(req());
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain(BEARER_SENTINEL);
    expect(serialized).not.toContain(TOKEN_SENTINEL);
    const body = res.body as { bearer_present: boolean; external_mcp: { token_present: boolean } };
    expect(body.bearer_present).toBe(true);
    expect(body.external_mcp.token_present).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // process.env isolation (the regression resolveServedGroveKeyHealthIsolated prevents).
  // ---------------------------------------------------------------------------

  test('process.env is left untouched across repeated calls — a real secret gets loaded AND cleaned up each time (forces the loadLayeredSecrets path)', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);

    // Give the served grove an explicit cloud provider so
    // resolveServedGroveKeyHealthIsolated actually exercises
    // loadLayeredSecrets (the env-mutating call the wrapper cleans up after).
    const { saveGroveConfig, loadGroveConfig } = await import('@myco/config/loader.js');
    const groveConfig = loadGroveConfig(grove.id, home);
    saveGroveConfig(grove.id, { ...groveConfig, agent: { ...groveConfig.agent, provider: { type: 'anthropic' } } }, home);

    // A REAL secret on disk, under the exact env name loadLayeredSecrets
    // maps the anthropic provider to (KEYED_CLOUD_PROVIDER_ENV.anthropic,
    // provider-health.ts) — without this, loadLayeredSecrets has nothing to
    // load and the wrapper's cleanup has nothing to undo, making a
    // before/after env-key-set comparison pass vacuously even against the
    // bare, env-mutating resolveServedGroveKeyHealth.
    const ISOLATION_SENTINEL = 'sk-test-isolation-guard';
    writeSecret(resolveGroveDir(grove.id, home), 'ANTHROPIC_API_KEY', ISOLATION_SENTINEL);

    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b', servedGroveId: grove.id };
    let clock = 1_700_000_000_000;
    const handler = createHostServeStatusHandler({ hostServe: runtime, mycoHome: home, now: () => clock, ttlMs: 15_000 });

    delete process.env.ANTHROPIC_API_KEY; // hermetic: never ambient from the shell before this test's assertions; afterEach restores the snapshot taken in beforeEach
    const before = new Set(Object.keys(process.env));

    await handler(req()); // populates the cache (first real compute)
    expect(process.env.ANTHROPIC_API_KEY, 'the isolation wrapper must remove the key it loaded before returning').toBeUndefined();

    clock += 20_000; // past the TTL — forces a fresh compute
    await handler(req());
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    clock += 20_000;
    await handler(req());
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    const after = new Set(Object.keys(process.env));
    expect([...after]).toEqual([...before]);
  });

  // ---------------------------------------------------------------------------
  // Classifier-bundle TTL cache.
  // ---------------------------------------------------------------------------

  test('TTL cache: the classifier bundle is recomputed at most once per TTL window (config loader invoked once across two calls inside it)', async () => {
    const grove = createGrove('Served', home);
    const machine = loadMachineConfig(home);
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home);

    const runtime: HostServeRuntime = { overlayAddress: '100.64.0.1:7433', bearer: 'b', servedGroveId: grove.id };
    let loadCount = 0;
    let clock = 1_700_000_000_000;
    const handler = createHostServeStatusHandler({
      hostServe: runtime,
      mycoHome: home,
      now: () => clock,
      ttlMs: 15_000,
      loadMachineConfig: (h) => { loadCount += 1; return loadMachineConfig(h); },
    });

    await handler(req());
    expect(loadCount).toBe(1);

    clock += 10_000; // still inside the 15s TTL
    await handler(req());
    expect(loadCount).toBe(1); // cache hit — no new config read

    clock += 10_000; // now 20s since the first compute — past the TTL
    await handler(req());
    expect(loadCount).toBe(2); // recomputed
  });
});
