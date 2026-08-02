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

import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import { renderLaunchdPlist } from '@myco/service/launchd-plist.js';
import { renderSystemdUnit } from '@myco/service/systemd-unit.js';
import { renderWindowsServiceScript } from '@myco/service/windows-task.js';
import type { ServiceScope, ServiceSpec } from '@myco/service/types.js';

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    label: 'co.goondocks.myco',
    variant: 'prod',
    executable: '/usr/local/bin/myco',
    args: ['daemon'],
    workingDir: '/Users/x/.myco',
    env: { MYCO_HOME: '/Users/x/.myco' },
    stdoutPath: '/Users/x/.myco/service/logs/daemon.out.log',
    stderrPath: '/Users/x/.myco/service/logs/daemon.err.log',
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
    ...overrides,
  };
}

describe('§13.13 gate 1 — a spec with NO declared scope renders byte-identically to an explicit login scope, on all THREE renderers', () => {
  const login: ServiceScope = { startAt: 'login', runAs: 'invoking-user' };

  it('launchd', () => {
    expect(renderLaunchdPlist(spec({ scope: login }))).toBe(renderLaunchdPlist(spec()));
    // And the undeclared render carries no scope-era keys at all.
    expect(renderLaunchdPlist(spec())).not.toContain('UserName');
  });

  it('systemd', () => {
    // A DECLARED login scope adds only the scope marker comment; the
    // undeclared render is byte-identical to the pre-scope world.
    expect(renderSystemdUnit(spec())).not.toContain('X-Myco-Scope');
    expect(renderSystemdUnit(spec({ scope: login })).replace('# X-Myco-Scope=login\n', ''))
      .toBe(renderSystemdUnit(spec()));
  });

  it('windows', () => {
    expect(renderWindowsServiceScript(spec({ scope: login }))).toBe(renderWindowsServiceScript(spec()));
  });
});

describe('scope-declared rendering', () => {
  it('launchd boot+invoking-user emits UserName (a LaunchDaemon dropping to the installing user)', () => {
    const rendered = renderLaunchdPlist(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } }));
    expect(rendered).toContain('<key>UserName</key>');
    expect(rendered).toContain(`<string>${os.userInfo().username}</string>`);
  });

  it('GATE (R-M4): boot+invoking-user renders HOME/USER/TMPDIR — a LaunchDaemon inherits no session env and machine_id hashes HOME', () => {
    const rendered = renderLaunchdPlist(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } }));
    expect(rendered).toContain('<key>HOME</key>');
    expect(rendered).toContain(`<string>${os.homedir()}</string>`);
    expect(rendered).toContain('<key>USER</key>');
    expect(rendered).toContain('<key>TMPDIR</key>');
  });

  it('an explicit spec.env.HOME overrides the derived one', () => {
    const rendered = renderLaunchdPlist(spec({
      scope: { startAt: 'boot', runAs: 'invoking-user' },
      env: { MYCO_HOME: '/Users/x/.myco', HOME: '/Users/custom-home' },
    }));
    expect(rendered).toContain('<string>/Users/custom-home</string>');
    expect(rendered).not.toContain(`<string>${os.homedir()}</string>`);
  });

  it('GATE (N1): rendering boot+invoking-user AS ROOT refuses — sudo myco service install must not mint a root identity', () => {
    if (process.getuid?.() === 0) return; // already root: the refusal path is the default
    const originalGetuid = process.getuid;
    (process as { getuid?: () => number }).getuid = () => 0;
    try {
      expect(() => renderLaunchdPlist(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } })))
        .toThrow(/WITHOUT sudo/);
    } finally {
      (process as { getuid?: () => number }).getuid = originalGetuid;
    }
  });

  it('launchd boot+root emits NO UserName — the job runs as root', () => {
    expect(renderLaunchdPlist(spec({ scope: { startAt: 'boot', runAs: 'root' } })))
      .not.toContain('UserName');
  });

  it('systemd boot+root is wanted by the machine, not a user session, and carries the scope marker', () => {
    const rendered = renderSystemdUnit(spec({ scope: { startAt: 'boot', runAs: 'root' } }));
    expect(rendered).toContain('WantedBy=multi-user.target');
    expect(rendered).toContain('# X-Myco-Scope=boot');
  });

  it('systemd boot+invoking-user keeps default.target — persistence comes from linger, not the system domain', () => {
    const rendered = renderSystemdUnit(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } }));
    expect(rendered).toContain('WantedBy=default.target');
    expect(rendered).toContain('# X-Myco-Scope=boot');
  });

  it('description replaces the "Myco daemon (prod)" lie for non-daemon services', () => {
    expect(renderSystemdUnit(spec({ description: 'Myco Team Host control plane (headscale)' })))
      .toContain('Description=Myco Team Host control plane (headscale)');
    expect(renderSystemdUnit(spec())).toContain('Description=Myco daemon (prod)');
  });
});
