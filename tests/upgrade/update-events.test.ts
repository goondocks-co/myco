import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendUpdateEvent, drainUpdateEvents } from '@myco/upgrade/update-events.js';

let tmpDir: string;
let eventsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-events-test-'));
  eventsPath = path.join(tmpDir, 'sub', 'update-events.jsonl'); // sub/ tests mkdir
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('update-events side-channel', () => {
  it('append → drain returns events in order, then deletes the file', () => {
    appendUpdateEvent(eventsPath, 'info', 'adopt started', { from: '1.0.0', to: '1.1.0' });
    appendUpdateEvent(eventsPath, 'warn', 'health-watch did not reach target', { last_seen_version: '1.0.0' });
    appendUpdateEvent(eventsPath, 'error', 'rollback applied', { restored: '1.0.0' });

    const events = drainUpdateEvents(eventsPath);
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ['info', 'adopt started'],
      ['warn', 'health-watch did not reach target'],
      ['error', 'rollback applied'],
    ]);
    expect(events[1].data).toEqual({ last_seen_version: '1.0.0' });
    // Drained = deleted, so a second drain is empty.
    expect(fs.existsSync(eventsPath)).toBe(false);
    expect(drainUpdateEvents(eventsPath)).toEqual([]);
  });

  it('drain returns [] when the file is absent', () => {
    expect(drainUpdateEvents(eventsPath)).toEqual([]);
  });

  it('skips malformed lines without dropping the valid ones', () => {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(
      eventsPath,
      'not json\n' +
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', level: 'info', message: 'kept' }) + '\n' +
        JSON.stringify({ level: 'info' }) + '\n', // no message → skipped
    );
    const events = drainUpdateEvents(eventsPath);
    expect(events.map((e) => e.message)).toEqual(['kept']);
  });

  it('append never throws even when the path is unwritable', () => {
    // Point at a path whose parent is a FILE, so mkdir/append fail internally.
    const blocked = path.join(tmpDir, 'afile');
    fs.writeFileSync(blocked, 'x');
    expect(() => appendUpdateEvent(path.join(blocked, 'nope.jsonl'), 'info', 'x')).not.toThrow();
  });
});
