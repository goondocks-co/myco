import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isServiceRunning,
  writeServicePid,
  removeServicePid,
  getServiceStatus,
  setupIdleShutdown,
} from '@myco/intelligence/service';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Intelligence Service Lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports not running when no PID file exists', () => {
    expect(isServiceRunning(tmpDir)).toBe(false);
  });

  it('writes and reads PID file', () => {
    writeServicePid(tmpDir);
    const pidPath = path.join(tmpDir, 'service.pid');
    expect(fs.existsSync(pidPath)).toBe(true);
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it('detects current process as running', () => {
    writeServicePid(tmpDir);
    expect(isServiceRunning(tmpDir)).toBe(true);
  });

  it('cleans up stale PID file for non-existent process', () => {
    const pidPath = path.join(tmpDir, 'service.pid');
    fs.writeFileSync(pidPath, '999999999');  // Non-existent PID
    expect(isServiceRunning(tmpDir)).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);  // Cleaned up
  });

  it('removes PID file', () => {
    writeServicePid(tmpDir);
    removeServicePid(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'service.pid'))).toBe(false);
  });

  it('getServiceStatus returns full status', () => {
    const status = getServiceStatus(tmpDir);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();

    writeServicePid(tmpDir);
    const running = getServiceStatus(tmpDir);
    expect(running.running).toBe(true);
    expect(running.pid).toBe(process.pid);
  });

  it('setupIdleShutdown returns a handle with refresh', () => {
    const handle = setupIdleShutdown(tmpDir, 60_000);
    expect(handle.refresh).toBeTypeOf('function');
    expect(handle.stop).toBeTypeOf('function');
    handle.stop();  // Clean up timer
  });
});
