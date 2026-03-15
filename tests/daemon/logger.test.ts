import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonLogger, type LogEntry } from '@myco/daemon/logger';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonLogger', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-log-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('writes structured JSON lines to log file', () => {
    const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024 });
    logger.info('daemon', 'Server started', { port: 52341 });
    logger.close();

    const logFile = path.join(logDir, 'daemon.log');
    expect(fs.existsSync(logFile)).toBe(true);

    const line = fs.readFileSync(logFile, 'utf-8').trim();
    const entry: LogEntry = JSON.parse(line);
    expect(entry.level).toBe('info');
    expect(entry.component).toBe('daemon');
    expect(entry.message).toBe('Server started');
    expect(entry.port).toBe(52341);
    expect(entry.timestamp).toBeDefined();
  });

  it('respects log level filtering', () => {
    const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024, level: 'warn' });
    logger.debug('daemon', 'ignored');
    logger.info('daemon', 'ignored');
    logger.warn('daemon', 'kept');
    logger.close();

    const content = fs.readFileSync(path.join(logDir, 'daemon.log'), 'utf-8').trim();
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('warn');
  });

  it('rotates when file exceeds maxSize', () => {
    const logger = new DaemonLogger(logDir, { maxSize: 100, maxFiles: 3 });
    for (let i = 0; i < 20; i++) {
      logger.info('daemon', 'x'.repeat(20));
    }
    logger.close();

    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('daemon'));
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(4); // daemon.log + 3 rotated
  });
});
