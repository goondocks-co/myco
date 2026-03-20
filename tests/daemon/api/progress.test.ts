import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressTracker, handleGetProgress } from '@myco/daemon/api/progress';

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  it('creates and retrieves a progress entry', () => {
    const token = tracker.create('rebuild');
    const entry = tracker.get(token);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('rebuild');
    expect(entry!.status).toBe('running');
    expect(entry!.token).toBe(token);
  });

  it('updates progress fields', () => {
    const token = tracker.create('rebuild');
    tracker.update(token, { percent: 50, message: 'Halfway done' });
    const entry = tracker.get(token);
    expect(entry!.percent).toBe(50);
    expect(entry!.message).toBe('Halfway done');
  });

  it('updates status to completed', () => {
    const token = tracker.create('rebuild');
    tracker.update(token, { status: 'completed', percent: 100 });
    const entry = tracker.get(token);
    expect(entry!.status).toBe('completed');
    expect(entry!.percent).toBe(100);
  });

  it('returns existing token for duplicate operation type', () => {
    const token1 = tracker.create('rebuild');
    const token2 = tracker.create('rebuild');
    expect(token1).toBe(token2);
  });

  it('allows new operation of same type after previous completes', () => {
    const token1 = tracker.create('rebuild');
    tracker.update(token1, { status: 'completed' });
    const token2 = tracker.create('rebuild');
    expect(token2).not.toBe(token1);
  });

  it('throws when max concurrent operations reached', () => {
    for (let i = 0; i < 10; i++) {
      tracker.create(`op-${i}`);
    }
    expect(() => tracker.create('op-overflow')).toThrow('Maximum concurrent operations reached (10)');
  });

  it('hasActiveOperations returns true when running operations exist', () => {
    expect(tracker.hasActiveOperations()).toBe(false);
    const token = tracker.create('rebuild');
    expect(tracker.hasActiveOperations()).toBe(true);
    tracker.update(token, { status: 'completed' });
    expect(tracker.hasActiveOperations()).toBe(false);
  });

  it('cleanup removes stale completed entries', () => {
    const token = tracker.create('rebuild');
    tracker.update(token, { status: 'completed' });

    // Fast-forward the updated timestamp past TTL
    const entry = tracker.get(token)!;
    entry.updated = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    tracker.cleanup();
    expect(tracker.get(token)).toBeUndefined();
  });

  it('cleanup keeps running entries', () => {
    const token = tracker.create('rebuild');
    // Even if created a long time ago, running entries should not be cleaned up
    const entry = tracker.get(token)!;
    entry.updated = Date.now() - 10 * 60 * 1000;

    tracker.cleanup();
    expect(tracker.get(token)).toBeDefined();
  });

  it('returns undefined for unknown token', () => {
    expect(tracker.get('nonexistent')).toBeUndefined();
  });

  it('ignores update for unknown token', () => {
    // Should not throw
    tracker.update('nonexistent', { percent: 50 });
  });
});

describe('handleGetProgress', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  it('returns progress entry for valid token', async () => {
    const token = tracker.create('rebuild');
    const result = await handleGetProgress(tracker, token);
    expect(result.status).toBeUndefined(); // 200 default
    expect((result.body as Record<string, unknown>).token).toBe(token);
  });

  it('returns 404 for unknown token', async () => {
    const result = await handleGetProgress(tracker, 'missing-token');
    expect(result.status).toBe(404);
    expect((result.body as Record<string, unknown>).error).toBe('not_found');
  });
});
