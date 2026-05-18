import { describe, test, expect, spyOn } from 'bun:test';
import fs, { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readIntent,
  readRestartIntent,
  readUpdateIntent,
  writeRestartIntent,
  writeUpdateIntent,
  clearIntentSection,
} from '../../packages/myco/src/daemon/intent.js';
import type { DaemonServiceState } from '../../packages/myco/src/daemon/service-state.js';

function svc(dir: string): DaemonServiceState {
  return { stateDir: dir, statePath: join(dir, 'daemon.json'), canonicalPort: 20915, scope: 'global' };
}

const RESTART_FILE = 'intent.restart.toml';
const UPDATE_FILE = 'intent.update.toml';

describe('intent (per-section files)', () => {
  test('round-trips restart intent', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeRestartIntent(svc(d), { requested_at: '2026-05-16T19:30:00Z', reason: 'user' });
    expect(readIntent(svc(d)).restart?.reason).toBe('user');
    expect(readRestartIntent(svc(d))?.reason).toBe('user');
  });

  test('round-trips update intent', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeUpdateIntent(svc(d), { target_version: '0.27.11', requested_at: 'x' });
    expect(readUpdateIntent(svc(d))?.target_version).toBe('0.27.11');
  });

  test('restart and update live in independent files (no cross-section read-modify-write)', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeUpdateIntent(svc(d), { target_version: '0.27.11', requested_at: 'x' });
    writeRestartIntent(svc(d), { requested_at: 'y' });
    const i = readIntent(svc(d));
    expect(i.update?.target_version).toBe('0.27.11');
    expect(i.restart?.requested_at).toBe('y');
    expect(existsSync(join(d, RESTART_FILE))).toBe(true);
    expect(existsSync(join(d, UPDATE_FILE))).toBe(true);
  });

  test('clearIntentSection removes only the targeted section file', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeRestartIntent(svc(d), { requested_at: 'x' });
    writeUpdateIntent(svc(d), { target_version: '0.27.11', requested_at: 'y' });
    clearIntentSection(svc(d), 'restart');
    const i = readIntent(svc(d));
    expect(i.restart).toBeUndefined();
    expect(i.update?.target_version).toBe('0.27.11');
    expect(existsSync(join(d, RESTART_FILE))).toBe(false);
    expect(existsSync(join(d, UPDATE_FILE))).toBe(true);
  });

  test('clearIntentSection is idempotent when the section file is already gone', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    expect(() => clearIntentSection(svc(d), 'restart')).not.toThrow();
    expect(() => clearIntentSection(svc(d), 'update')).not.toThrow();
  });

  test('readIntent returns empty when no section files exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    expect(readIntent(svc(d))).toEqual({});
  });

  test('readIntent tolerates malformed TOML by returning empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeFileSync(join(d, RESTART_FILE), '!!! not valid toml !!!');
    writeFileSync(join(d, UPDATE_FILE), '!!! not valid toml either !!!');
    expect(readIntent(svc(d))).toEqual({});
  });

  test('readIntent rejects malformed-but-valid TOML (missing required fields)', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    // Valid TOML, missing required `requested_at`. The shape guard must
    // reject this — otherwise a bare `as Intent` cast would propagate
    // garbage into update.target_version downstream.
    writeFileSync(join(d, UPDATE_FILE), 'target_version = "0.27.11"\n');
    expect(readUpdateIntent(svc(d))).toBeUndefined();
    expect(readIntent(svc(d)).update).toBeUndefined();
  });

  test('readIntent rejects update intent with empty target_version', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeFileSync(join(d, UPDATE_FILE), 'target_version = ""\nrequested_at = "x"\n');
    expect(readUpdateIntent(svc(d))).toBeUndefined();
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

  test('intent files are written with 0o600 mode', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeUpdateIntent(svc(d), { target_version: '0.27.11', requested_at: 'x' });
    const stat = fs.statSync(join(d, UPDATE_FILE));
    // On POSIX, mask off file-type bits and compare the permission bits.
    // On Windows the file API may report different bits — skip the strict
    // check there (this codebase ships POSIX as the primary target).
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
