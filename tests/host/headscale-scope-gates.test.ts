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
 * E1 §7 named gates for the headscale re-scope (spec rev 6). Each gate here
 * is one that FAILS when its property stops holding — a gate that passes
 * vacuously certifies the property while the machine violates it (the rev-4
 * render-time scope gate was exactly that, and was replaced).
 *
 * Gate 2 — headscale's scope classification is OBSERVED, not rendered.
 * Gate 3 — no hostEnable/hostDisable decision branches on the boot-domain-only
 *          `isSystemServiceInstalled` check for the headscale label.
 * Gate 6 — the four-cell render matrix (darwin/linux × login/boot).
 * Plus: the Linux per-label scope marker beats the machine-global linger
 * consult, and the admin socket is pinned in the rendered headscale config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderLaunchdPlist } from '@myco/service/launchd-plist.js';
import { renderSystemdUnit } from '@myco/service/systemd-unit.js';
import { resolveObservedScope } from '@myco/service/scoped.js';
import { headscaleLayout, renderHeadscaleConfig } from '@myco/team-host/headscale-config.js';
import { classifyHeadscaleScope } from '@myco/team-host/scope-converge.js';
import { HEADSCALE_SERVICE_LABEL, buildOverlayServiceSpec } from '@myco/team-host/system-service.js';

function overlaySpec(scope: { startAt: 'login' | 'boot'; runAs: 'invoking-user' | 'root' }) {
  return buildOverlayServiceSpec({
    label: HEADSCALE_SERVICE_LABEL,
    description: 'Myco Team Host control plane (headscale)',
    executable: '/opt/bin/headscale',
    args: ['serve', '--config', '/ctl/headscale/config.yaml'],
    workingDir: '/ctl/headscale',
    logDir: '/ctl/headscale/logs',
    scope,
  });
}

describe('GATE 6 — four-cell render matrix (darwin/linux × login/boot)', () => {
  it('darwin × login: plain LaunchAgent — no UserName, no HOME pinning, no root anywhere', () => {
    const plist = renderLaunchdPlist(overlaySpec({ startAt: 'login', runAs: 'invoking-user' }));
    expect(plist).toContain(HEADSCALE_SERVICE_LABEL);
    expect(plist).not.toContain('<key>UserName</key>');
    // HOME/USER/TMPDIR pinning is the boot cell's compensation for launchd
    // rendering no session env — the login cell inherits a real session.
    expect(plist).not.toContain('<key>HOME</key>');
  });

  it('darwin × boot: LaunchDaemon that DROPS to the invoking user (UserName + HOME/USER/TMPDIR pinned)', () => {
    const plist = renderLaunchdPlist(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' }));
    expect(plist).toContain('<key>UserName</key>');
    expect(plist).toContain(os.userInfo().username);
    expect(plist).toContain('<key>HOME</key>');
  });

  it('linux × login: ordinary user unit with the scope marker, no User= directive', () => {
    const unit = renderSystemdUnit(overlaySpec({ startAt: 'login', runAs: 'invoking-user' }));
    expect(unit).toContain('# X-Myco-Scope=login');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
  });

  it('linux × boot (invoking-user): STILL an ordinary user unit — boot persistence is linger, never a system unit', () => {
    const unit = renderSystemdUnit(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' }));
    expect(unit).toContain('# X-Myco-Scope=boot');
    // NOT multi-user.target — that is the root cell's system-unit marker.
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
  });
});

describe('GATE 3 — no headscale decision rides the boot-domain-only installed check', () => {
  it('overlay.ts never passes HEADSCALE_SERVICE_LABEL to isSystemServiceInstalled', () => {
    // `isSystemServiceInstalled` is `fs.existsSync(<system unit path>)` —
    // boot-domain-only by construction (boot-backend.ts). With headscale in
    // the user domain, a decision keyed on it is a fail-open: enable
    // installs a SECOND unit; disable skips the uninstall and then rmSyncs
    // live state (E1 review RC1). The only legitimate remaining caller is
    // the legacy Linux tailscaled converge, which is genuinely boot-only.
    const source = fs.readFileSync(
      path.join(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'team-host', 'overlay.ts'),
      'utf-8',
    );
    // Proximity check, not shape check: any argument form (renamed context,
    // lowercase local, aliased label) still puts the label text within the
    // call's argument span. A shape-anchored regex passes vacuously the
    // moment the call is written differently (diff review N7).
    const sites = [...source.matchAll(/isSystemServiceInstalled\s*\(/g)].map((m) => m.index ?? 0);
    expect(sites.length).toBeGreaterThan(0); // the legacy converge still exists
    for (const at of sites) {
      const argSpan = source.slice(at, at + 160);
      expect(argSpan).not.toContain('HEADSCALE');
    }
  });
});

describe('Linux per-label scope marker beats the machine-global linger consult', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-marker-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const throwingLoginctl = {
    run: async () => { throw new Error('linger consulted — the per-label marker must win'); },
  };

  it('a login-marked unit on a NON-lingering box reads login (linger consulted, says no)', async () => {
    // A `login` marker is a declaration, not an effect: linger is machine-
    // wide and Myco never disables it, so a login-declared unit on a
    // lingering box still starts at boot. resolveObservedScope reports what
    // is ACTUALLY installed — the marker only decides when it claims MORE
    // than the machine grants (boot), never less (diff review C6).
    fs.writeFileSync(
      path.join(tmp, `${HEADSCALE_SERVICE_LABEL}.service`),
      renderSystemdUnit(overlaySpec({ startAt: 'login', runAs: 'invoking-user' })),
    );
    const seams = {
      platform: 'linux' as const,
      loginUnitDir: tmp,
      bootUnitDir: path.join(tmp, 'no-boot-units'),
    };
    expect(await resolveObservedScope(HEADSCALE_SERVICE_LABEL, {
      ...seams, loginctl: { run: async () => ({ stdout: 'Linger=no', exitCode: 0 }) },
    })).toBe('login');
    // On a lingering box the same unit EFFECTIVELY starts at boot — honesty
    // over declaration, for every consumer (doctor, remove, self-install).
    expect(await resolveObservedScope(HEADSCALE_SERVICE_LABEL, {
      ...seams, loginctl: { run: async () => ({ stdout: 'Linger=yes', exitCode: 0 }) },
    })).toBe('boot');
  });

  it('a boot-marked user unit (the linger cell) reads as boot, still without linger', async () => {
    fs.writeFileSync(
      path.join(tmp, `${HEADSCALE_SERVICE_LABEL}.service`),
      renderSystemdUnit(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' })),
    );
    const observed = await resolveObservedScope(HEADSCALE_SERVICE_LABEL, {
      platform: 'linux',
      loginUnitDir: tmp,
      bootUnitDir: path.join(tmp, 'no-boot-units'),
      loginctl: throwingLoginctl,
    });
    expect(observed).toBe('boot');
  });

  it('a marker-less legacy unit still falls back to the linger consult', async () => {
    fs.writeFileSync(path.join(tmp, `${HEADSCALE_SERVICE_LABEL}.service`), '[Unit]\nDescription=legacy\n');
    const observed = await resolveObservedScope(HEADSCALE_SERVICE_LABEL, {
      platform: 'linux',
      loginUnitDir: tmp,
      bootUnitDir: path.join(tmp, 'no-boot-units'),
      loginctl: { run: async () => ({ stdout: 'Linger=yes', exitCode: 0 }) },
    });
    expect(observed).toBe('boot');
  });
});

describe('GATE 2 — classification is observed-state, and legacy root cells are never "converged"', () => {
  let tmp: string; let home: string; let loginDir: string; let bootDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-classify-'));
    home = path.join(tmp, 'myco-home'); fs.mkdirSync(home, { recursive: true });
    loginDir = path.join(tmp, 'agents'); fs.mkdirSync(loginDir, { recursive: true });
    bootDir = path.join(tmp, 'daemons'); fs.mkdirSync(bootDir, { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function writeConfig(opts: { serving: boolean; scope?: 'login' | 'boot' }): void {
    fs.writeFileSync(path.join(home, 'config.yaml'), [
      'daemon:',
      ...(opts.scope ? [`  service_scope: ${opts.scope}`] : []),
      '  host_serve:',
      `    enabled: ${opts.serving}`,
      ...(opts.serving ? ["    overlay_address: '100.64.0.5'"] : []),
    ].join('\n'));
  }

  const seams = (platform: NodeJS.Platform = 'darwin') => ({ platform, loginUnitDir: loginDir, bootUnitDir: bootDir });

  it('not serving → not-serving, regardless of what units exist', async () => {
    writeConfig({ serving: false });
    fs.writeFileSync(path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`), 'legacy');
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('not-serving');
  });

  it('serving + no unit anywhere → missing', async () => {
    writeConfig({ serving: true });
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('missing');
  });

  it('serving + login unit at login target → converged', async () => {
    writeConfig({ serving: true });
    fs.writeFileSync(path.join(loginDir, `${HEADSCALE_SERVICE_LABEL}.plist`), 'agent');
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('converged');
  });

  it('serving + legacy ROOT boot unit at login target → legacy-root (a pre-1.3.1 host)', async () => {
    writeConfig({ serving: true });
    fs.writeFileSync(
      path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`),
      renderLaunchdPlist(overlaySpec({ startAt: 'boot', runAs: 'root' })),
    );
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('legacy-root');
  });

  it('serving + legacy ROOT boot unit even at BOOT target → still legacy-root, never converged', async () => {
    // The root cell is unacceptable even when the daemon is boot-scoped:
    // its admin socket is root-owned, so every member add would need the
    // sudo the re-scope removed.
    writeConfig({ serving: true, scope: 'boot' });
    fs.writeFileSync(
      path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`),
      renderLaunchdPlist(overlaySpec({ startAt: 'boot', runAs: 'root' })),
    );
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('legacy-root');
  });

  it('serving + invoking-user boot unit at BOOT target → converged', async () => {
    writeConfig({ serving: true, scope: 'boot' });
    fs.writeFileSync(
      path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`),
      renderLaunchdPlist(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' })),
    );
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('converged');
  });

  it('serving + invoking-user boot unit at LOGIN target → drift (transitionable)', async () => {
    writeConfig({ serving: true });
    fs.writeFileSync(
      path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`),
      renderLaunchdPlist(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' })),
    );
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('drift');
  });

  it('serving + units in BOTH domains → both (the dangerous state)', async () => {
    writeConfig({ serving: true });
    fs.writeFileSync(path.join(loginDir, `${HEADSCALE_SERVICE_LABEL}.plist`), 'agent');
    fs.writeFileSync(path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.plist`), 'legacy');
    expect((await classifyHeadscaleScope(home, seams())).verdict).toBe('both');
  });
});

describe('GATE 2, Linux cells — a system-domain unit is ALWAYS the root cell', () => {
  // linuxUserBootCell is the predicate at the heart of the B1 disable fix:
  // the linux boot×invoking-user cell has NO system-domain unit at all, so
  // an /etc/systemd/system file is decisive evidence of the legacy root
  // cell regardless of markers or linger.
  let tmp: string; let home: string; let loginDir: string; let bootDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-linux-'));
    home = path.join(tmp, 'myco-home'); fs.mkdirSync(home, { recursive: true });
    loginDir = path.join(tmp, 'user-units'); fs.mkdirSync(loginDir, { recursive: true });
    bootDir = path.join(tmp, 'system-units'); fs.mkdirSync(bootDir, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.yaml'), [
      'daemon:',
      '  host_serve:',
      '    enabled: true',
      "    overlay_address: '100.64.0.5'",
    ].join('\n'));
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('legacy system unit at login target → legacy-root (never drift)', async () => {
    fs.writeFileSync(
      path.join(bootDir, `${HEADSCALE_SERVICE_LABEL}.service`),
      renderSystemdUnit(overlaySpec({ startAt: 'boot', runAs: 'root' })),
    );
    const report = await classifyHeadscaleScope(home, { platform: 'linux', loginUnitDir: loginDir, bootUnitDir: bootDir });
    expect(report.verdict).toBe('legacy-root');
  });

  it('boot-marked USER unit with no system unit → drift at login target (the linger cell, transitionable)', async () => {
    fs.writeFileSync(
      path.join(loginDir, `${HEADSCALE_SERVICE_LABEL}.service`),
      renderSystemdUnit(overlaySpec({ startAt: 'boot', runAs: 'invoking-user' })),
    );
    const report = await classifyHeadscaleScope(home, { platform: 'linux', loginUnitDir: loginDir, bootUnitDir: bootDir });
    expect(report.verdict).toBe('drift');
    expect(report.observed).toBe('boot');
  });
});

describe('the admin socket is pinned in the rendered headscale config', () => {
  it('unix_socket + unix_socket_permission are OURS, never headscale defaults', () => {
    // headscale 0.29.2's compiled-in default socket dir is root-owned — a
    // user-cell headscale inheriting it cannot create its admin socket,
    // which takes down every admin call and `host enable` with them. This
    // must hold in the SAME release as the scope change, not after it.
    const layout = headscaleLayout('/ctl');
    const rendered = renderHeadscaleConfig({
      serverUrl: 'https://host.example:8080',
      listenAddr: '0.0.0.0:8080',
      layout,
    });
    expect(rendered).toContain(`unix_socket: ${layout.adminSocketPath}`);
    expect(rendered).toContain('unix_socket_permission: "0700"');
    expect(layout.adminSocketPath).toBe('/ctl/headscale/headscale.sock');
  });
});
