/**
 * `myco doctor` — the overlay forward check (Overlay Coexistence spec §8.3/§10).
 *
 * Guards the evidence gap C1 opened: the overlay listener used to bind the
 * 100.64 TUN address, so a successful bind proved the overlay was up. It now
 * binds loopback — which succeeds even with tailscaled dead — and reachability
 * lives in a SECOND piece of state inside tailscaled. Without this check a host
 * can advertise an address no member can reach while everything reports green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkOverlayForward } from '@myco/cli/doctor.js';
import { writeHostServeConfig } from '@myco/team-host/daemon-apply.js';

describe('checkOverlayForward', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevTeam: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-fwd-'));
    prevHome = process.env.MYCO_HOME;
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(home, 'myco');
    process.env.MYCO_TEAM_HOME = path.join(home, 'team');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevHome;
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns no row when this machine is not serving', async () => {
    expect(await checkOverlayForward(process.env.MYCO_HOME)).toBeNull();
  });

  it('warns when serving is enabled but no overlay port is recorded', async () => {
    // Hand-written config (the enable path refuses this), which is exactly the
    // state a partially-upgraded machine can be left in.
    const configPath = path.join(process.env.MYCO_HOME!, 'config.yaml');
    fs.writeFileSync(configPath, 'daemon:\n  host_serve:\n    enabled: true\n    overlay_port: null\n');

    const check = await checkOverlayForward(process.env.MYCO_HOME);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/no overlay port is recorded/);
  });

  it('warns when serving is enabled but no host overlay state exists', async () => {
    writeHostServeConfig(
      { enabled: true, overlayAddress: '100.64.0.7', overlayPort: 41443 },
      process.env.MYCO_HOME,
    );

    // host_serve is on, but `host enable` never recorded a tailscale binary —
    // so the forward cannot even be interrogated.
    const check = await checkOverlayForward(process.env.MYCO_HOME);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/no recorded overlay state/);
  });
});
