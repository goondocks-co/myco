/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * E1 §7 GATE 4 and the Phase-2 contract fields (spec §4.1 rev 6):
 *
 *  - `serving` alone is config-derived and survives every bind failure —
 *    success is ONLY `serving && overlay_listener_bound` (gate 4).
 *  - `started_at` is the restart discriminator: without it, the Phase-2
 *    poll succeeds against the dying pre-restart process.
 *  - `{serving:false}` carries `not_serving_reason` — the daemon knows
 *    exactly why, and `restart_pending` is the enable flow's normal
 *    pre-restart window, not an error.
 *
 * Plus GATE 7 (cross-PR invariant): every headscale admin call in
 * `hostEnable` runs after the supervision step has converged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHostServeStatusHandler } from '@myco/daemon/api/host-serve-status.js';
import type { HostServeRuntime } from '@myco/daemon/host-serve.js';

const RUNTIME: HostServeRuntime = {
  overlayAddress: '100.64.0.5',
  overlayPort: 41443,
  bearer: 'bearer-value',
  hostId: 'host_' + 'a'.repeat(32),
  label: 'testhost',
  servedGroveId: undefined,
};

describe('GATE 4 — status body carries the observed listener bind + restart discriminator', () => {
  let tmp: string;
  let prevMyco: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hss-body-'));
    prevMyco = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tmp, 'myco');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serving:true can still report overlay_listener_bound:false — the two are NEVER conflated', async () => {
    const handler = createHostServeStatusHandler({
      hostServe: RUNTIME,
      mycoHome: process.env.MYCO_HOME!,
      overlayListenerBound: () => false, // bind failed (EADDRINUSE et al.) — hostServe survives it
      startedAt: () => '2026-08-02T21:00:00.000Z',
    });
    const res = await handler({ body: undefined, params: {}, query: {} } as never);
    const body = res.body as { serving: boolean; overlay_listener_bound: boolean | null; started_at: string | null };
    expect(body.serving).toBe(true);
    expect(body.overlay_listener_bound).toBe(false);
    expect(body.started_at).toBe('2026-08-02T21:00:00.000Z');
  });

  it('serving:false explains itself — disabled vs restart_pending are different states', async () => {
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), '');
    const disabled = createHostServeStatusHandler({
      hostServe: null,
      mycoHome: process.env.MYCO_HOME!,
      startedAt: () => 'T1',
    });
    const disabledBody = (await disabled({ body: undefined, params: {}, query: {} } as never)).body as Record<string, unknown>;
    expect(disabledBody.serving).toBe(false);
    expect(disabledBody.not_serving_reason).toBe('disabled');
    expect(disabledBody.started_at).toBe('T1');

    // Valid config + null boot runtime = the enable flow's pre-restart
    // window: the config was written AFTER this process booted.
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), [
      'daemon:',
      '  host_serve:',
      '    enabled: true',
      "    overlay_address: '100.64.0.5'",
      '    overlay_port: 41443',
    ].join('\n'));
    const pending = createHostServeStatusHandler({
      hostServe: null,
      mycoHome: process.env.MYCO_HOME!,
      startedAt: () => 'T1',
    });
    const pendingBody = (await pending({ body: undefined, params: {}, query: {} } as never)).body as Record<string, unknown>;
    expect(pendingBody.serving).toBe(false);
    expect(pendingBody.not_serving_reason).toBe('restart_pending');
  });

  it('a not-serving GET is READ-ONLY: it never mints the bearer, and the reason is cached (diff review C4)', async () => {
    // The refusal probe must never fall through to bearer resolution —
    // that is mint-if-absent, i.e. a GET creating secrets.env (proven in
    // review). And the reason is the Phase-2 poll's hot path, so it rides
    // the same TTL cache as the serving body.
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), [
      'daemon:',
      '  host_serve:',
      '    enabled: true',
      "    overlay_address: '100.64.0.5'",
      '    overlay_port: 41443',
    ].join('\n'));
    let loads = 0;
    const { loadMachineConfig } = await import('@myco/config/loader.js');
    const handler = createHostServeStatusHandler({
      hostServe: null,
      mycoHome: process.env.MYCO_HOME!,
      loadMachineConfig: (h) => { loads += 1; return loadMachineConfig(h); },
      now: () => 1_000_000,
      ttlMs: 15_000,
    });
    await handler({ body: undefined, params: {}, query: {} } as never);
    await handler({ body: undefined, params: {}, query: {} } as never);
    expect(loads).toBe(1); // second poll served from the reason cache
    expect(fs.existsSync(path.join(process.env.MYCO_HOME!, 'secrets.env'))).toBe(false);
  });

  it('a misconfigured enable names its actual defect (invalid port), never a bare boolean', async () => {
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), [
      'daemon:',
      '  host_serve:',
      '    enabled: true',
      "    overlay_address: '100.64.0.5'",
    ].join('\n'));
    const handler = createHostServeStatusHandler({ hostServe: null, mycoHome: process.env.MYCO_HOME! });
    const body = (await handler({ body: undefined, params: {}, query: {} } as never)).body as Record<string, unknown>;
    expect(body.not_serving_reason).toBe('invalid_overlay_port');
  });
});

describe('GATE 7 — headscale admin calls run after the supervision step has converged', () => {
  it('in hostEnable source order: admin-socket proof < key mint < node-id resolution', () => {
    // The cross-PR invariant nobody owned (E1 review): PR 1 made the admin
    // CLI unprivileged — which only works once the USER cell is up, because
    // the user-owned admin socket is what replaces sudo. PR 2 is a
    // reordering PR, so the ordering must be pinned, not assumed. Marker
    // positions are stable API names, not formatting.
    const source = fs.readFileSync(
      path.join(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'team-host', 'overlay.ts'),
      'utf-8',
    );
    const enableStart = source.indexOf('export async function hostEnable');
    expect(enableStart).toBeGreaterThan(0);
    const body = source.slice(enableStart);
    const supervisionProof = body.indexOf('waitForAdminSocket');
    const keyMint = body.indexOf('mintPreauthKey({');
    const nodeId = body.indexOf('deps.resolveNodeId\n');
    expect(supervisionProof).toBeGreaterThan(0);
    expect(keyMint).toBeGreaterThan(supervisionProof);
    expect(nodeId === -1 ? body.indexOf('deps.resolveNodeId') : nodeId).toBeGreaterThan(keyMint);
  });
});
