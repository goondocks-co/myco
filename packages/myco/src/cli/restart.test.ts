/**
 * Tests for the `myco restart` down-daemon recovery hint.
 *
 * When the daemon is down, `myco restart` prints a platform-appropriate
 * supervisor command so the user can inspect or kick the service. The hint
 * previously only covered launchd (darwin) and systemd (everything else),
 * silently giving Windows users a `systemctl` command that doesn't exist
 * there. The Windows branch mirrors the Task Scheduler `/run` primitive the
 * service manager uses.
 */

import { describe, test, expect } from 'bun:test';
import { supervisorStatusHint } from './restart.js';

const LABEL = 'co.goondocks.myco';

describe('supervisorStatusHint', () => {
  test('darwin → launchctl', () => {
    expect(supervisorStatusHint(LABEL, 'darwin')).toContain('launchctl list');
    expect(supervisorStatusHint(LABEL, 'darwin')).toContain(LABEL);
  });

  test('win32 → schtasks against the task name (== service label)', () => {
    const hint = supervisorStatusHint(LABEL, 'win32');
    expect(hint).toContain('schtasks /run /tn');
    // Task name is quoted because schtasks delimits a spaced name with quotes,
    // and the label IS the task name (windows.ts uses spec.label as /tn).
    expect(hint).toContain(`"${LABEL}"`);
    expect(hint).not.toContain('systemctl');
    expect(hint).not.toContain('launchctl');
  });

  test('linux / other → systemctl --user', () => {
    expect(supervisorStatusHint(LABEL, 'linux')).toContain('systemctl --user status');
    expect(supervisorStatusHint(LABEL, 'linux')).toContain(`${LABEL}.service`);
  });
});
