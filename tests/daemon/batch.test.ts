import { describe, it, expect } from 'vitest';
import { BatchManager, type BatchEvent } from '@myco/daemon/batch';

describe('BatchManager', () => {
  it('opens a new batch on user_prompt', () => {
    const closed: BatchEvent[][] = [];
    const mgr = new BatchManager((events) => { closed.push([...events]); });

    mgr.addEvent({ type: 'user_prompt', prompt: 'Hello', session_id: 's1', timestamp: '2026-01-01T00:00:00Z' });
    expect(mgr.hasOpenBatch('s1')).toBe(true);
    expect(closed).toHaveLength(0);
  });

  it('accumulates tool events into current batch', () => {
    const closed: BatchEvent[][] = [];
    const mgr = new BatchManager((events) => { closed.push([...events]); });

    mgr.addEvent({ type: 'user_prompt', prompt: 'Hello', session_id: 's1', timestamp: '2026-01-01T00:00:00Z' });
    mgr.addEvent({ type: 'tool_use', tool_name: 'Read', session_id: 's1', timestamp: '2026-01-01T00:00:01Z' });
    mgr.addEvent({ type: 'tool_use', tool_name: 'Edit', session_id: 's1', timestamp: '2026-01-01T00:00:02Z' });

    expect(mgr.batchSize('s1')).toBe(3);
    expect(closed).toHaveLength(0);
  });

  it('closes previous batch when new user_prompt arrives', () => {
    const closed: BatchEvent[][] = [];
    const mgr = new BatchManager((events) => { closed.push([...events]); });

    mgr.addEvent({ type: 'user_prompt', prompt: 'First', session_id: 's1', timestamp: '2026-01-01T00:00:00Z' });
    mgr.addEvent({ type: 'tool_use', tool_name: 'Read', session_id: 's1', timestamp: '2026-01-01T00:00:01Z' });
    mgr.addEvent({ type: 'user_prompt', prompt: 'Second', session_id: 's1', timestamp: '2026-01-01T00:01:00Z' });

    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveLength(2);
    expect(closed[0][0].prompt).toBe('First');
  });

  it('finalize closes last batch and returns it', () => {
    const closed: BatchEvent[][] = [];
    const mgr = new BatchManager((events) => { closed.push([...events]); });

    mgr.addEvent({ type: 'user_prompt', prompt: 'Only', session_id: 's1', timestamp: '2026-01-01T00:00:00Z' });
    mgr.addEvent({ type: 'tool_use', tool_name: 'Read', session_id: 's1', timestamp: '2026-01-01T00:00:01Z' });

    const final = mgr.finalize('s1');
    expect(final).toHaveLength(2);
    expect(mgr.hasOpenBatch('s1')).toBe(false);
  });

  it('tracks separate batches per session', () => {
    const closed: BatchEvent[][] = [];
    const mgr = new BatchManager((events) => { closed.push([...events]); });

    mgr.addEvent({ type: 'user_prompt', prompt: 'A', session_id: 's1', timestamp: '2026-01-01T00:00:00Z' });
    mgr.addEvent({ type: 'user_prompt', prompt: 'B', session_id: 's2', timestamp: '2026-01-01T00:00:00Z' });

    expect(mgr.hasOpenBatch('s1')).toBe(true);
    expect(mgr.hasOpenBatch('s2')).toBe(true);
  });
});
