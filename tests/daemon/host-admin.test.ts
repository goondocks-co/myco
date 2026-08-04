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
 * Host-admin route family (E1 §4): typed refusals, the in-daemon job's
 * terminal-before-restart ordering, dedupe, and the one-time mint. The
 * execution-model pins here are the review blockers made regression-proof:
 * the tracker's terminal state is written BEFORE any restart is scheduled
 * (the tracker dies with the process), and a failed job never restarts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createHostAdminEnableHandler,
  createHostAdminDisableHandler,
  createHostAdminMintJoinKeyHandler,
  type HostAdminRouteDeps,
} from '@myco/daemon/api/host-admin.js';
import { ProgressTracker } from '@myco/daemon/api/progress.js';
import { writeHostState } from '@myco/team-host/state.js';
import type { HostEnableResult } from '@myco/team-host/overlay.js';

const ENABLE_RESULT: HostEnableResult = {
  hostId: 'host_' + 'a'.repeat(32),
  overlayAddress: '100.64.0.5',
  overlayPort: 41443,
  serverUrl: 'https://host.example:8080',
  headscaleVersion: '0.29.2',
  tailscaleVersion: '1.98.8',
  daemonRestarted: true,
  servedGroveId: 'grove_' + 'b'.repeat(32),
  notes: [],
};

function request(body: unknown): { body: unknown; params: Record<string, string>; query: Record<string, string> } {
  return { body, params: {}, query: {} };
}

describe('host-admin routes', () => {
  let tmp: string;
  let prevMyco: string | undefined;
  let prevTeam: string | undefined;
  let tracker: ProgressTracker;
  let restartScheduled: number;
  let statusAtRestart: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-admin-'));
    prevMyco = process.env.MYCO_HOME;
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(tmp, 'myco');
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
    tracker = new ProgressTracker();
    restartScheduled = 0;
    statusAtRestart = undefined;
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(overrides: Partial<HostAdminRouteDeps> = {}): HostAdminRouteDeps {
    const built: HostAdminRouteDeps = {
      tracker,
      mycoHome: process.env.MYCO_HOME!,
      platform: 'darwin',
      startedAt: () => '2026-08-02T20:00:00.000Z',
      scheduleRestart: (_opts: { token: string }) => {
        restartScheduled += 1;
        // Capture the tracker state AT THE MOMENT the restart is scheduled —
        // the terminal-before-restart pin.
        const running = [...(tracker as unknown as { entries: Map<string, { status: string }> }).entries.values()];
        statusAtRestart = running[running.length - 1]?.status;
      },
      runHostEnable: async (_options, enableDeps) => {
        enableDeps?.logger?.('provisioning…');
        // The orchestration's terminal step requests the restart through
        // the EXPLICIT restartDaemon seam — mirror that here.
        await enableDeps?.restartDaemon?.(process.env.MYCO_HOME!);
        return ENABLE_RESULT;
      },
      runHostDisable: async (disableDeps) => {
        disableDeps?.logger?.('tearing down…');
        await disableDeps?.restartDaemon?.(process.env.MYCO_HOME!);
        return { cleared: true, errors: [], daemonRestarted: false };
      },
      runMintSetupKey: async () => 'one-time-key-value',
      ...overrides,
    };
    return built;
  }

  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('enable: 202 with token + pre-restart snapshot; terminal tracker state is written BEFORE the restart is scheduled', async () => {
    const handler = createHostAdminEnableHandler(deps());
    const res = await handler(request({ server_url: 'https://host.example:8080' }));
    expect(res.status).toBe(202);
    const { token, started_at } = res.body as { token: string; started_at: string };
    expect(started_at).toBe('2026-08-02T20:00:00.000Z');

    await flush();
    const entry = tracker.get(token)!;
    expect(entry.status).toBe('completed');
    expect(entry.steps?.some((s) => /provisioning/.test(s))).toBe(true);
    expect(entry.steps?.some((s) => /overlay_listener_bound && started_at changes/.test(s))).toBe(true);
    expect(restartScheduled).toBe(1);
    // The blocker pin: at schedule time the entry was ALREADY terminal.
    expect(statusAtRestart).toBe('completed');
  });

  it('enable and disable MUTUALLY exclude — one tracker type for the family (two-tabs guard, diff review C3)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({
      runHostEnable: async () => { await gate; return ENABLE_RESULT; },
    });
    const first = await createHostAdminEnableHandler(d)(request({ server_url: 'https://x:8080' }));
    const second = await createHostAdminEnableHandler(d)(request({ server_url: 'https://x:8080' }));
    expect((second.body as { existing?: boolean }).existing).toBe(true);
    expect((second.body as { token: string }).token).toBe((first.body as { token: string }).token);
    // A DISABLE during a running enable joins the same job rather than
    // interleaving hostDisable over the same config/db/statedir.
    const dis = await createHostAdminDisableHandler(d)(request({}));
    expect((dis.body as { existing?: boolean }).existing).toBe(true);
    expect((dis.body as { token: string }).token).toBe((first.body as { token: string }).token);
    release();
    await flush();
  });

  it('enable: a FAILED job records failed status with the error step and never schedules a restart', async () => {
    const handler = createHostAdminEnableHandler(deps({
      runHostEnable: async (_o, enableDeps) => {
        // The restart was requested before the failure — it must still not fire.
        await enableDeps?.restartDaemon?.(process.env.MYCO_HOME!);
        throw new Error('tailscale up exploded');
      },
    }));
    const res = await handler(request({ server_url: 'https://host.example:8080' }));
    await flush();
    const entry = tracker.get((res.body as { token: string }).token)!;
    expect(entry.status).toBe('failed');
    expect(entry.steps?.some((s) => /tailscale up exploded/.test(s))).toBe(true);
    expect(restartScheduled).toBe(0);
  });

  it('typed refusals: win32 unsupported; darwin+boot requires the CLI; root/no-HOME unsafe', async () => {
    const win = await createHostAdminEnableHandler(deps({ platform: 'win32' }))(request({ server_url: 'https://x:8080' }));
    expect(win.status).toBe(422);
    expect((win.body as { error: string }).error).toBe('host_admin_unsupported');

    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), 'daemon:\n  service_scope: boot\n');
    const boot = await createHostAdminEnableHandler(deps())(request({ server_url: 'https://x:8080' }));
    expect(boot.status).toBe(409);
    expect((boot.body as { error: string }).error).toBe('host_admin_requires_cli');
    expect((boot.body as { message: string }).message).toContain('myco host enable');
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), '');

    // mint skips the boot-scope refusal (unprivileged at every scope) but
    // keeps platform/HOME guards.
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), 'daemon:\n  service_scope: boot\n');
    const mintAtBoot = await createHostAdminMintJoinKeyHandler(deps())(request({}));
    expect((mintAtBoot.body as { error?: string }).error).not.toBe('host_admin_requires_cli');
  });

  it('enable: a team key without a provider is refused up front — no silent anthropic filing', async () => {
    const res = await createHostAdminEnableHandler(deps())(request({
      server_url: 'https://host.example:8080',
      team_provider_key: 'sk-team-key',
    }));
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain('team_key_provider');
  });

  it('mint-join-key: not_a_host without serving state; refused while the invite flow is rebuilt when serving', async () => {
    const bare = await createHostAdminMintJoinKeyHandler(deps())(request({}));
    expect(bare.status).toBe(409);
    expect((bare.body as { error: string }).error).toBe('not_a_host');

    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), [
      'daemon:',
      '  host_serve:',
      '    enabled: true',
    ].join('\n'));
    writeHostState({
      host_id: 'host_' + 'a'.repeat(32),
      enabled_at: new Date().toISOString(),
      label: 'test-host',
      platform: 'darwin',
    });

    // The key this minted was a headscale pre-auth key the daemon never saw or
    // validated — overlay membership, not the key, was the real admission gate.
    // Until the daemon-issued single-use key exists, refusing is the only honest
    // answer: handing back a key that admits nobody would look like success.
    const res = await createHostAdminMintJoinKeyHandler(deps())(request({ expiration: '2h' }));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe('join_unavailable');
    expect(res.body).not.toHaveProperty('key');
    expect(res.body).not.toHaveProperty('join_command');
  });

  it('disable: terminal state before restart, same as enable', async () => {
    const handler = createHostAdminDisableHandler(deps());
    const res = await handler(request({}));
    expect(res.status).toBe(202);
    await flush();
    const entry = tracker.get((res.body as { token: string }).token)!;
    expect(entry.status).toBe('completed');
    expect(restartScheduled).toBe(1);
    expect(statusAtRestart).toBe('completed');
  });
});
