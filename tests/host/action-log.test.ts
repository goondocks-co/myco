/**
 * Team Host control-plane action log (Task 2.4) — the append-only JSONL trail.
 * Hermetic: an explicit tmp controlDir, no env, no daemon.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendHostAction, hostActionLogPath, readHostActionLog } from '@myco/host/action-log';

describe('host action log', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-actionlog-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('append creates the file on demand and round-trips oldest-first with stamped ts', () => {
    appendHostAction({ action: 'key-mint', subject: 'myco-host', detail: { expiration: '1h' } }, dir);
    appendHostAction({ action: 'enroll', subject: '100.64.0.9' }, dir);
    appendHostAction({ action: 'evict', subject: '7' }, dir);

    const log = readHostActionLog(dir);
    expect(log.map((r) => r.action)).toEqual(['key-mint', 'enroll', 'evict']);
    expect(log[0].subject).toBe('myco-host');
    expect(log[0].detail?.expiration).toBe('1h');
    for (const r of log) expect(typeof r.ts).toBe('string');
    // JSONL: one record per line.
    expect(fs.readFileSync(hostActionLogPath(dir), 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  test('reading a missing log is empty, not an error', () => {
    expect(readHostActionLog(path.join(dir, 'nope'))).toEqual([]);
  });

  test('a torn/partial line is skipped, not thrown', () => {
    appendHostAction({ action: 'enroll', subject: 'a' }, dir);
    fs.appendFileSync(hostActionLogPath(dir), '{not json\n', 'utf-8');
    appendHostAction({ action: 'evict', subject: 'b' }, dir);
    expect(readHostActionLog(dir).map((r) => r.action)).toEqual(['enroll', 'evict']);
  });
});
