import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoLogs } from '@myco/mcp/tools/logs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeLog(logDir: string, entries: object[]): void {
  fs.mkdirSync(logDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, 'daemon.log'), lines);
}

const entry = (level: string, component: string, message: string) => ({
  timestamp: '2026-03-14T14:00:00.000Z',
  level,
  component,
  message,
});

describe('myco_logs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-logs-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns entries with default limit', async () => {
    writeLog(path.join(tmpDir, 'logs'), [
      entry('info', 'daemon', 'Started'),
      entry('info', 'hooks', 'Stop received'),
    ]);
    const result = await handleMycoLogs(tmpDir, {});
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('passes level filter through to reader', async () => {
    writeLog(path.join(tmpDir, 'logs'), [
      entry('info', 'daemon', 'Info msg'),
      entry('error', 'daemon', 'Error msg'),
    ]);
    const result = await handleMycoLogs(tmpDir, { level: 'error' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].level).toBe('error');
  });

  it('returns structured result with total and truncated', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry('info', 'd', `msg-${i}`));
    writeLog(path.join(tmpDir, 'logs'), entries);
    const result = await handleMycoLogs(tmpDir, { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });
});
