import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryLogs } from '@myco/logs/reader';
import type { LogQueryResult } from '@myco/logs/reader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeLog(logDir: string, filename: string, entries: object[]): void {
  fs.mkdirSync(logDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, filename), lines);
}

const entry = (level: string, component: string, message: string, extra?: Record<string, unknown>) => ({
  timestamp: '2026-03-14T14:00:00.000Z',
  level,
  component,
  message,
  ...extra,
});

describe('queryLogs', () => {
  let tmpDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-logs-'));
    logDir = path.join(tmpDir, 'logs');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses valid JSONL entries', () => {
    writeLog(logDir, 'daemon.log', [
      entry('info', 'daemon', 'Server started', { port: 55986 }),
    ]);
    const result = queryLogs(logDir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('Server started');
    expect(result.entries[0].port).toBe(55986);
  });

  it('skips malformed lines', () => {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'daemon.log'),
      '{"timestamp":"2026-03-14T14:00:00Z","level":"info","component":"d","message":"ok"}\nNOT JSON\n');
    const result = queryLogs(logDir);
    expect(result.entries).toHaveLength(1);
  });

  it('filters by minimum level', () => {
    writeLog(logDir, 'daemon.log', [
      entry('debug', 'daemon', 'Debug msg'),
      entry('info', 'daemon', 'Info msg'),
      entry('warn', 'daemon', 'Warn msg'),
      entry('error', 'daemon', 'Error msg'),
    ]);
    const result = queryLogs(logDir, { level: 'warn' });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('filters by component', () => {
    writeLog(logDir, 'daemon.log', [
      entry('info', 'hooks', 'Hook event'),
      entry('info', 'processor', 'Process event'),
    ]);
    const result = queryLogs(logDir, { component: 'hooks' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].component).toBe('hooks');
  });

  it('filters by since timestamp', () => {
    writeLog(logDir, 'daemon.log', [
      { timestamp: '2026-03-14T10:00:00Z', level: 'info', component: 'd', message: 'old' },
      { timestamp: '2026-03-14T15:00:00Z', level: 'info', component: 'd', message: 'new' },
    ]);
    const result = queryLogs(logDir, { since: '2026-03-14T12:00:00Z' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('new');
  });

  it('filters by until timestamp', () => {
    writeLog(logDir, 'daemon.log', [
      { timestamp: '2026-03-14T10:00:00Z', level: 'info', component: 'd', message: 'old' },
      { timestamp: '2026-03-14T15:00:00Z', level: 'info', component: 'd', message: 'new' },
    ]);
    const result = queryLogs(logDir, { until: '2026-03-14T12:00:00Z' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('old');
  });

  it('combines multiple filters', () => {
    writeLog(logDir, 'daemon.log', [
      { timestamp: '2026-03-14T10:00:00Z', level: 'info', component: 'hooks', message: 'old hook' },
      { timestamp: '2026-03-14T15:00:00Z', level: 'warn', component: 'hooks', message: 'new warn hook' },
      { timestamp: '2026-03-14T15:00:00Z', level: 'info', component: 'daemon', message: 'new daemon' },
    ]);
    const result = queryLogs(logDir, { level: 'warn', component: 'hooks', since: '2026-03-14T12:00:00Z' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('new warn hook');
  });

  it('reads rotated files in chronological order', () => {
    writeLog(logDir, 'daemon.2.log', [entry('info', 'd', 'oldest')]);
    writeLog(logDir, 'daemon.1.log', [entry('info', 'd', 'middle')]);
    writeLog(logDir, 'daemon.log', [entry('info', 'd', 'newest')]);
    const result = queryLogs(logDir, { limit: 10 });
    expect(result.entries.map((e) => e.message)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('returns tail (last N) entries', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry('info', 'd', `msg-${i}`));
    writeLog(logDir, 'daemon.log', entries);
    const result = queryLogs(logDir, { limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].message).toBe('msg-7');
    expect(result.entries[2].message).toBe('msg-9');
  });

  it('reports truncation when total exceeds limit', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry('info', 'd', `msg-${i}`));
    writeLog(logDir, 'daemon.log', entries);
    const result = queryLogs(logDir, { limit: 3 });
    expect(result.total).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('reports no truncation when all entries fit', () => {
    writeLog(logDir, 'daemon.log', [entry('info', 'd', 'only')]);
    const result = queryLogs(logDir, { limit: 50 });
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('returns empty result for missing log directory', () => {
    const result = queryLogs(path.join(tmpDir, 'nonexistent'));
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('clamps limit to MAX_LOG_QUERY_LIMIT', () => {
    writeLog(logDir, 'daemon.log', [entry('info', 'd', 'one')]);
    const result = queryLogs(logDir, { limit: 999_999 });
    expect(result.entries).toHaveLength(1);
  });
});
