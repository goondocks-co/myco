import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  EventBuffer,
  resolveSessionFromBuffer,
  BUFFER_QUARANTINE_DIRNAME,
} from '@myco/member/buffer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('EventBuffer', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-buf-'));
    bufferDir = path.join(tmpDir, 'buffer');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends events to JSONL file', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc');
    buffer.append({ type: 'tool_use', tool: 'Read', input: { path: '/foo' } });
    buffer.append({ type: 'tool_use', tool: 'Write', input: { path: '/bar' } });

    const lines = buffer.readAll();
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe('Read');
    expect(lines[1].tool).toBe('Write');
  });

  it('creates buffer directory on first append', () => {
    expect(fs.existsSync(bufferDir)).toBe(false);
    const buffer = new EventBuffer(bufferDir, 'session-xyz');
    buffer.append({ type: 'tool_use', tool: 'Bash' });
    expect(fs.existsSync(bufferDir)).toBe(true);
  });

  it('returns empty array for non-existent buffer', () => {
    const buffer = new EventBuffer(bufferDir, 'nonexistent');
    expect(buffer.readAll()).toEqual([]);
  });

  it('deletes buffer file', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc');
    buffer.append({ type: 'tool_use', tool: 'Read' });
    expect(buffer.exists()).toBe(true);
    buffer.delete();
    expect(buffer.exists()).toBe(false);
  });

  it('delete() removes the .lock companion alongside the buffer', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc');
    buffer.append({ type: 'tool_use', tool: 'Read' });
    const lockPath = path.join(bufferDir, '.session-abc.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    buffer.delete();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('EventBuffer.deleteIfSync (locked conditional delete)', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-buf-delif-'));
    bufferDir = path.join(tmpDir, 'buffer');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes when the callback approves the re-read records, reaping the lock companion', () => {
    const buffer = new EventBuffer(bufferDir, 's1');
    buffer.append({ type: 'tool_use', tool: 'Read' });
    buffer.append({ type: 'tool_use', tool: 'Write' });

    let seen: Array<Record<string, unknown>> = [];
    const deleted = buffer.deleteIfSync((records) => { seen = records; return true; });

    expect(deleted).toBe(true);
    expect(buffer.exists()).toBe(false);
    expect(fs.existsSync(path.join(bufferDir, '.s1.lock'))).toBe(false);
    // The callback judged the exact re-read state the unlink acted on.
    expect(seen).toHaveLength(2);
    expect(seen[0].tool).toBe('Read');
    expect(seen[1].tool).toBe('Write');
  });

  it('refuses (file intact) when the callback rejects', () => {
    const buffer = new EventBuffer(bufferDir, 's1');
    buffer.append({ type: 'tool_use', tool: 'Read' });

    const deleted = buffer.deleteIfSync(() => false);

    expect(deleted).toBe(false);
    expect(buffer.exists()).toBe(true);
    expect(buffer.readAll()).toHaveLength(1);
  });

  it('a missing file returns false WITHOUT invoking the callback', () => {
    const buffer = new EventBuffer(bufferDir, 'never-written');
    let called = false;
    const deleted = buffer.deleteIfSync(() => { called = true; return true; });
    expect(deleted).toBe(false);
    expect(called).toBe(false);
  });

  it('a torn (unparseable) trailing line refuses outright — content not provably disposable', () => {
    const buffer = new EventBuffer(bufferDir, 's1');
    buffer.append({ type: 'tool_use', tool: 'Read' });
    // A writer that died mid-write leaves a torn tail no lock can retroactively fix.
    fs.appendFileSync(path.join(bufferDir, 's1.jsonl'), '{"type":"tool_use","tool":"Wri');

    let called = false;
    const deleted = buffer.deleteIfSync(() => { called = true; return true; });

    expect(deleted).toBe(false);
    expect(called).toBe(false); // refusal happens before the callback — nothing to judge
    expect(buffer.exists()).toBe(true);
  });
});

describe('resolveSessionFromBuffer', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-resolve-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns most recently modified buffer session', () => {
    fs.writeFileSync(path.join(bufferDir, 'older.jsonl'), '{}');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(bufferDir, 'older.jsonl'), past, past);

    fs.writeFileSync(path.join(bufferDir, 'newer.jsonl'), '{}');

    expect(resolveSessionFromBuffer(bufferDir)).toBe('newer');
  });

  it('returns undefined for empty buffer directory', () => {
    expect(resolveSessionFromBuffer(bufferDir)).toBeUndefined();
  });

  it('returns undefined for missing buffer directory', () => {
    expect(resolveSessionFromBuffer('/nonexistent/path')).toBeUndefined();
  });

  it('ignores non-jsonl files', () => {
    fs.writeFileSync(path.join(bufferDir, 'notes.txt'), 'not a buffer');
    expect(resolveSessionFromBuffer(bufferDir)).toBeUndefined();
  });
});
