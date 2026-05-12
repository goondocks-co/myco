import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  isDevServiceMode,
  resolveServiceDir,
  resolveServiceDaemonStatePath,
  setDevServiceMode,
  SERVICE_DIRNAME,
  SERVICE_DEV_DIRNAME,
} from '../../packages/myco/src/grove/paths';
import { resolveGlobalDaemonPort } from '../../packages/myco/src/daemon/service-state';

describe('two-daemon coexistence', () => {
  test('prod and dev resolve to different state dirs', () => {
    const home = path.join(os.tmpdir(), 'myco-test-home');
    setDevServiceMode(false);
    try {
      const prodDir = resolveServiceDir(home);
      setDevServiceMode(true);
      const devDir = resolveServiceDir(home);
      expect(prodDir).toBe(path.join(home, SERVICE_DIRNAME));
      expect(devDir).toBe(path.join(home, SERVICE_DEV_DIRNAME));
      expect(prodDir).not.toBe(devDir);
    } finally {
      setDevServiceMode(false);
    }
  });

  test('prod and dev derive different daemon ports', () => {
    const home = path.join(os.tmpdir(), 'myco-test-home');
    setDevServiceMode(false);
    try {
      const prodPort = resolveGlobalDaemonPort(home);
      setDevServiceMode(true);
      const devPort = resolveGlobalDaemonPort(home);
      expect(prodPort).toBeGreaterThan(0);
      expect(devPort).toBeGreaterThan(0);
      expect(prodPort).not.toBe(devPort);
    } finally {
      setDevServiceMode(false);
    }
  });

  test('prod and dev write distinct daemon.json paths', () => {
    const home = path.join(os.tmpdir(), 'myco-test-home');
    setDevServiceMode(false);
    try {
      const prodState = resolveServiceDaemonStatePath(home);
      setDevServiceMode(true);
      const devState = resolveServiceDaemonStatePath(home);
      expect(prodState).not.toBe(devState);
    } finally {
      setDevServiceMode(false);
    }
  });
});
