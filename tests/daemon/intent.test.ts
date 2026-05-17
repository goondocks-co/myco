import { describe, test, expect, spyOn } from 'bun:test';
import fs, { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readIntent,
  writeIntent,
  mergeIntent,
  clearIntentSection,
} from '../../packages/myco/src/daemon/intent.js';
import type { DaemonServiceState } from '../../packages/myco/src/daemon/service-state.js';

function svc(dir: string): DaemonServiceState {
  return { stateDir: dir, statePath: join(dir, 'daemon.json'), canonicalPort: 20915, scope: 'global' };
}

describe('intent', () => {
  test('round-trips restart intent', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeIntent(svc(d), { restart: { requested_at: '2026-05-16T19:30:00Z', reason: 'user' } });
    expect(readIntent(svc(d)).restart?.reason).toBe('user');
  });

  test('merge preserves unrelated sections', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeIntent(svc(d), { update: { target_version: '0.27.11', requested_at: 'x' } });
    mergeIntent(svc(d), { restart: { requested_at: 'y' } });
    const i = readIntent(svc(d));
    expect(i.update?.target_version).toBe('0.27.11');
    expect(i.restart?.requested_at).toBe('y');
  });

  test('clearIntentSection removes file when empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeIntent(svc(d), { restart: { requested_at: 'x' } });
    clearIntentSection(svc(d), 'restart');
    expect(readIntent(svc(d))).toEqual({});
    expect(existsSync(join(d, 'intent.toml'))).toBe(false);
  });

  test('clearIntentSection keeps file when other sections remain', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeIntent(svc(d), {
      restart: { requested_at: 'x' },
      update: { target_version: '0.27.11', requested_at: 'y' },
    });
    clearIntentSection(svc(d), 'restart');
    const i = readIntent(svc(d));
    expect(i.restart).toBeUndefined();
    expect(i.update?.target_version).toBe('0.27.11');
  });

  test('readIntent returns empty object when file does not exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    expect(readIntent(svc(d))).toEqual({});
  });

  test('readIntent tolerates malformed TOML by returning empty object', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    writeFileSync(join(d, 'intent.toml'), '!!! not valid toml !!!');
    expect(readIntent(svc(d))).toEqual({});
  });

  test('writeIntent is atomic — spies on renameSync', () => {
    const d = mkdtempSync(join(tmpdir(), 'myco-intent-'));
    const spy = spyOn(fs, 'renameSync');
    try {
      writeIntent(svc(d), { restart: { requested_at: 'x' } });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
