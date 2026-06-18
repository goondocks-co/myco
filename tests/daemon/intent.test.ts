import { describe, test, expect, spyOn } from 'bun:test';
import fs, { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readIntent,
  readRestartIntent,
  writeRestartIntent,
  clearRestartIntent,
} from '../../packages/myco/src/daemon/intent.js';
import type { DaemonServiceState } from '../../packages/myco/src/daemon/service-state.js';

function svc(dir: string): DaemonServiceState {
  return { stateDir: dir, statePath: join(dir, 'daemon.json'), canonicalPort: 20915, scope: 'global' };
}

const RESTART_FILE = 'intent.restart.toml';

describe('intent (per-section files)', () => {
  test('round-trips restart intent', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeRestartIntent(svc(d), { requested_at: '2026-05-16T19:30:00Z', reason: 'user' });
    expect(readIntent(svc(d)).restart?.reason).toBe('user');
    expect(readRestartIntent(svc(d))?.reason).toBe('user');
  });

  test('clearRestartIntent removes the restart section file', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeRestartIntent(svc(d), { requested_at: 'x' });
    clearRestartIntent(svc(d));
    expect(readIntent(svc(d)).restart).toBeUndefined();
    expect(existsSync(join(d, RESTART_FILE))).toBe(false);
  });

  test('clearRestartIntent is idempotent when the section file is already gone', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    expect(() => clearRestartIntent(svc(d))).not.toThrow();
  });

  test('readIntent returns empty when no section files exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    expect(readIntent(svc(d))).toEqual({});
  });

  test('readIntent tolerates malformed TOML by returning empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeFileSync(join(d, RESTART_FILE), '!!! not valid toml !!!');
    expect(readIntent(svc(d))).toEqual({});
  });

  test('writeRestartIntent is atomic — spies on renameSync', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    const spy = spyOn(fs, 'renameSync');
    try {
      writeRestartIntent(svc(d), { requested_at: 'x' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('restart intent file is written with 0o600 mode', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeRestartIntent(svc(d), { requested_at: 'x' });
    const stat = fs.statSync(join(d, RESTART_FILE));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
