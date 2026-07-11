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

describe('host action log rotation/cap', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-actionlog-rotate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('rotates the live file to .1 once it exceeds maxBytes; a fresh live file starts the next append', () => {
    // A tiny cap so one append already exceeds it, exercising rotation without
    // writing a real-size (1 MB default) file in a unit test.
    const rotation = { maxBytes: 10, maxBackups: 3 };
    appendHostAction({ action: 'enroll', subject: 'first' }, dir, rotation);
    expect(fs.existsSync(`${hostActionLogPath(dir)}.1`)).toBe(false); // nothing to rotate on the first append

    appendHostAction({ action: 'enroll', subject: 'second' }, dir, rotation);
    expect(fs.existsSync(`${hostActionLogPath(dir)}.1`)).toBe(true);
    // The live file now holds only the second append (rotation ran before the write).
    const liveLines = fs.readFileSync(hostActionLogPath(dir), 'utf-8').trim().split('\n');
    expect(liveLines).toHaveLength(1);
    expect(JSON.parse(liveLines[0]).subject).toBe('second');
  });

  test('shifts numbered backups and drops the oldest beyond maxBackups', () => {
    const rotation = { maxBytes: 1, maxBackups: 2 };
    appendHostAction({ action: 'enroll', subject: 'a' }, dir, rotation); // live=[a]
    appendHostAction({ action: 'enroll', subject: 'b' }, dir, rotation); // .1=[a], live=[b]
    appendHostAction({ action: 'enroll', subject: 'c' }, dir, rotation); // .2=[a], .1=[b], live=[c]
    appendHostAction({ action: 'enroll', subject: 'd' }, dir, rotation); // .2=[b] (drops old .2=[a]), .1=[c], live=[d]

    expect(JSON.parse(fs.readFileSync(hostActionLogPath(dir), 'utf-8').trim()).subject).toBe('d');
    expect(JSON.parse(fs.readFileSync(`${hostActionLogPath(dir)}.1`, 'utf-8').trim()).subject).toBe('c');
    expect(JSON.parse(fs.readFileSync(`${hostActionLogPath(dir)}.2`, 'utf-8').trim()).subject).toBe('b');
    expect(fs.existsSync(`${hostActionLogPath(dir)}.3`)).toBe(false);
  });

  test('readHostActionLog spans rotated backups oldest-first, then the live file', () => {
    const rotation = { maxBytes: 1, maxBackups: 2 };
    appendHostAction({ action: 'enroll', subject: 'a' }, dir, rotation);
    appendHostAction({ action: 'enroll', subject: 'b' }, dir, rotation);
    appendHostAction({ action: 'enroll', subject: 'c' }, dir, rotation);

    expect(readHostActionLog(dir, rotation).map((r) => r.subject)).toEqual(['a', 'b', 'c']);
  });
});
