import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBuffer } from '@myco/capture/buffer';
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

  it('reports event count', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc');
    expect(buffer.count()).toBe(0);
    buffer.append({ type: 'tool_use', tool: 'Read' });
    buffer.append({ type: 'tool_use', tool: 'Write' });
    expect(buffer.count()).toBe(2);
  });

  it('deletes buffer file', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc');
    buffer.append({ type: 'tool_use', tool: 'Read' });
    expect(buffer.exists()).toBe(true);
    buffer.delete();
    expect(buffer.exists()).toBe(false);
  });

  it('respects max events limit', () => {
    const buffer = new EventBuffer(bufferDir, 'session-abc', { maxEvents: 3 });
    for (let i = 0; i < 5; i++) {
      buffer.append({ type: 'tool_use', tool: `tool-${i}` });
    }
    expect(buffer.isOverflow()).toBe(true);
  });
});
