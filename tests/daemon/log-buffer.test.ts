import { describe, it, expect } from 'vitest';
import { LogRingBuffer } from '@myco/daemon/log-buffer';

describe('LogRingBuffer', () => {
  it('stores and retrieves entries', () => {
    const buf = new LogRingBuffer(100);
    buf.push({ timestamp: '2026-01-01', level: 'info', component: 'test', message: 'hello' });
    const entries = buf.since(null);
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0].message).toBe('hello');
  });

  it('evicts oldest entries when full', () => {
    const buf = new LogRingBuffer(3);
    buf.push({ timestamp: '1', level: 'info', component: 't', message: 'a' });
    buf.push({ timestamp: '2', level: 'info', component: 't', message: 'b' });
    buf.push({ timestamp: '3', level: 'info', component: 't', message: 'c' });
    buf.push({ timestamp: '4', level: 'info', component: 't', message: 'd' });
    const entries = buf.since(null);
    expect(entries.entries).toHaveLength(3);
    expect(entries.entries[0].message).toBe('b');
  });

  it('returns entries after cursor', () => {
    const buf = new LogRingBuffer(100);
    buf.push({ timestamp: '1', level: 'info', component: 't', message: 'a' });
    const first = buf.since(null);
    buf.push({ timestamp: '2', level: 'info', component: 't', message: 'b' });
    const second = buf.since(first.cursor);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].message).toBe('b');
  });

  it('filters by level', () => {
    const buf = new LogRingBuffer(100);
    buf.push({ timestamp: '1', level: 'debug', component: 't', message: 'a' });
    buf.push({ timestamp: '2', level: 'error', component: 't', message: 'b' });
    const entries = buf.since(null, { level: 'warn' });
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0].level).toBe('error');
  });

  it('signals cursor reset when cursor is stale', () => {
    const buf = new LogRingBuffer(2);
    buf.push({ timestamp: '1', level: 'info', component: 't', message: 'a' });
    const first = buf.since(null);
    buf.push({ timestamp: '2', level: 'info', component: 't', message: 'b' });
    buf.push({ timestamp: '3', level: 'info', component: 't', message: 'c' });
    buf.push({ timestamp: '4', level: 'info', component: 't', message: 'd' });
    const result = buf.since(first.cursor);
    expect(result.cursor_reset).toBe(true);
  });
});

describe('component filtering', () => {
  it('should filter entries by component', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ timestamp: '2026-01-01T00:00:00Z', level: 'info', component: 'hooks', message: 'hook event' });
    buf.push({ timestamp: '2026-01-01T00:00:01Z', level: 'info', component: 'context', message: 'context injected' });
    buf.push({ timestamp: '2026-01-01T00:00:02Z', level: 'info', component: 'mcp', message: 'tool call' });

    const result = buf.since(null, { component: 'hooks' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('hook event');
  });

  it('should return all entries when no component filter', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ timestamp: '2026-01-01T00:00:00Z', level: 'info', component: 'hooks', message: 'a' });
    buf.push({ timestamp: '2026-01-01T00:00:01Z', level: 'info', component: 'mcp', message: 'b' });

    const result = buf.since(null);
    expect(result.entries).toHaveLength(2);
  });
});
