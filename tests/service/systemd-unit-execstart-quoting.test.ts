/**
 * Tests for the systemd unit renderer.
 *
 * Focus: ExecStart must survive a spaced executable/argument path. systemd
 * splits ExecStart on whitespace, so an unquoted spaced path (a user profile
 * with a space, a "Program Files"-style install dir) would be torn into
 * separate words and the service would fail to launch. The renderer quotes
 * each token per systemd's quoting rules.
 */

import { describe, test, expect } from 'bun:test';
import { renderSystemdUnit } from '@myco/service/systemd-unit.js';
import type { ServiceSpec } from '@myco/service/types.js';

function specWith(overrides: Partial<ServiceSpec>): ServiceSpec {
  return {
    label: 'co.goondocks.myco',
    variant: 'prod',
    executable: '/home/alice/.local/bin/myco',
    args: ['daemon', 'run'],
    workingDir: '/home/alice',
    env: { MYCO_VARIANT: 'prod' },
    stdoutPath: '/home/alice/.myco/out.log',
    stderrPath: '/home/alice/.myco/err.log',
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 2,
    ...overrides,
  };
}

describe('renderSystemdUnit ExecStart quoting', () => {
  test('quotes the executable so a spaced install path is one argument', () => {
    const unit = renderSystemdUnit(
      specWith({ executable: '/home/alice smith/.local/bin/myco' }),
    );
    const execLine = unit
      .split('\n')
      .find((l) => l.startsWith('ExecStart='));
    expect(execLine).toBeDefined();
    // The spaced path must be wrapped in double quotes, NOT left bare (which
    // systemd would split into "/home/alice" + "smith/.local/bin/myco").
    expect(execLine).toContain('"/home/alice smith/.local/bin/myco"');
    expect(execLine).not.toContain('/home/alice smith/.local/bin/myco daemon');
  });

  test('quotes a spaced argument too', () => {
    const unit = renderSystemdUnit(
      specWith({ args: ['daemon', '--root', '/opt/My Groves'] }),
    );
    const execLine = unit
      .split('\n')
      .find((l) => l.startsWith('ExecStart='))!;
    expect(execLine).toContain('"/opt/My Groves"');
  });

  test('non-spaced path still renders all tokens', () => {
    const unit = renderSystemdUnit(specWith({}));
    const execLine = unit
      .split('\n')
      .find((l) => l.startsWith('ExecStart='))!;
    expect(execLine).toContain('"/home/alice/.local/bin/myco"');
    expect(execLine).toContain('"daemon"');
    expect(execLine).toContain('"run"');
  });

  test('escapes embedded double quotes in a path', () => {
    const unit = renderSystemdUnit(
      specWith({ executable: '/home/we"rd/myco' }),
    );
    const execLine = unit
      .split('\n')
      .find((l) => l.startsWith('ExecStart='))!;
    // shellEscape backslash-escapes the inner quote.
    expect(execLine).toContain('/home/we\\"rd/myco');
  });
});
