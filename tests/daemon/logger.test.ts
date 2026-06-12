import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

  it('setLevel changes the active level for subsequent writes', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-logger-setlevel-'));
    try {
      const logger = new DaemonLogger(logDir, { level: 'info' });
      logger.debug('test', 'should-be-dropped');
      logger.setLevel('debug');
      logger.debug('test', 'should-appear');
      const logFile = path.join(logDir, 'daemon.log');
      const contents = fs.readFileSync(logFile, 'utf-8');
      expect(contents).not.toContain('should-be-dropped');
      expect(contents).toContain('should-appear');
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe('DaemonLogger — never-throw write path (RC-8)', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-log-rc8-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** Reach into the private fd to simulate a dead descriptor (EBADF class). */
  function breakSink(logger: DaemonLogger): void {
    const fd = (logger as unknown as { fd: number | null }).fd;
    if (fd !== null) fs.closeSync(fd);
  }

  it('a dead sink fd does not throw; lines drop through the backoff window, then recovery logs the gap', () => {
    let clock = 1_000_000;
    const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024, now: () => clock });
    logger.info('daemon', 'before failure');

    breakSink(logger);
    // Hits EBADF internally — must not propagate; the line is dropped and
    // the dead fd is abandoned.
    expect(() => logger.info('daemon', 'dropped line')).not.toThrow();
    // Still inside the retry backoff: dropped without touching the sink.
    logger.info('daemon', 'backoff drop');

    // Past the window the next write re-opens the sink, lands, and the
    // recovery note records BOTH dropped lines.
    clock += 6_000;
    logger.info('daemon', 'after recovery');
    logger.close();

    const contents = fs.readFileSync(path.join(logDir, 'daemon.log'), 'utf-8');
    expect(contents).toContain('before failure');
    expect(contents).toContain('after recovery');
    expect(contents).not.toContain('dropped line');
    expect(contents).not.toContain('backoff drop');
    const recovery = contents.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .find((e: Record<string, unknown>) => e.kind === 'daemon.logger');
    expect(recovery).toBeDefined();
    expect(recovery.dropped_lines).toBe(2);
  });

  it('circular metadata falls back to core fields instead of throwing', () => {
    const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.info('daemon', 'circular payload', { circular })).not.toThrow();
    logger.close();

    const entry = JSON.parse(fs.readFileSync(path.join(logDir, 'daemon.log'), 'utf-8').trim());
    expect(entry.message).toBe('circular payload');
    expect(entry.metadata_unserializable).toBe(true);
  });

  it('close() on an already-dead fd does not throw', () => {
    const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024 });
    breakSink(logger);
    expect(() => logger.close()).not.toThrow();
  });
});

describe('DaemonLogger — degraded mode vs level filter (RC-8)', () => {
  it('below-threshold writes during degraded mode neither count as dropped nor declare recovery', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-log-lvl-'));
    try {
      let clock = 1_000_000;
      const logger = new DaemonLogger(logDir, { maxSize: 1024 * 1024, level: 'info', now: () => clock });
      logger.info('daemon', 'before failure');
      const fd = (logger as unknown as { fd: number | null }).fd;
      if (fd !== null) fs.closeSync(fd);
      logger.info('daemon', 'dropped line');

      // Filtered debug calls — past the backoff window, these must not
      // falsely complete a recovery pass (nothing landed).
      clock += 6_000;
      logger.debug('daemon', 'filtered one');
      logger.debug('daemon', 'filtered two');

      logger.info('daemon', 'after recovery');
      logger.close();

      const contents = fs.readFileSync(path.join(logDir, 'daemon.log'), 'utf-8');
      expect(contents).toContain('after recovery');
      const recovery = contents.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .find((e: Record<string, unknown>) => e.kind === 'daemon.logger');
      expect(recovery).toBeDefined();
      expect(recovery.dropped_lines).toBe(1);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
