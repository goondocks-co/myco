/**
 * Tests for the event-driven plan capture module.
 *
 * Covers:
 * - isInPlanDirectory: absolute path match, relative path match, non-match, multiple watch dirs
 * - isPlanWriteEvent: tool name filtering, file_path extraction, path extraction, non-plan dirs
 * - parsePlanTitle: heading extraction, filename fallback, null when neither
 * - capturePlan: creates plan with session association, updates on re-capture, does NOT reset embedded flag when content unchanged
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { getPlan, listPlansBySession } from '@myco/db/queries/plans.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import {
  isInPlanDirectory,
  isPlanWriteEvent,
  parsePlanTitle,
  capturePlan,
  type PlanWatchConfig,
} from '@myco/daemon/plan-capture.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// isInPlanDirectory
// ---------------------------------------------------------------------------

describe('isInPlanDirectory', () => {
  const projectRoot = '/home/user/myproject';
  const watchDirs = ['docs/plans', 'tasks'];

  it('matches an absolute path inside a watch dir', () => {
    expect(isInPlanDirectory('/home/user/myproject/docs/plans/sprint.md', watchDirs, projectRoot)).toBe(true);
  });

  it('matches a relative path inside a watch dir', () => {
    expect(isInPlanDirectory('docs/plans/sprint.md', watchDirs, projectRoot)).toBe(true);
  });

  it('returns false for a path outside all watch dirs', () => {
    expect(isInPlanDirectory('/home/user/myproject/src/index.ts', watchDirs, projectRoot)).toBe(false);
  });

  it('matches the second of multiple watch dirs', () => {
    expect(isInPlanDirectory('tasks/todo.md', watchDirs, projectRoot)).toBe(true);
  });

  it('returns false for a path that only partially matches a watch dir name', () => {
    // docs/plans-extra is NOT inside docs/plans
    expect(isInPlanDirectory('/home/user/myproject/docs/plans-extra/file.md', watchDirs, projectRoot)).toBe(false);
  });

  it('matches a deeply nested file inside a watch dir', () => {
    expect(isInPlanDirectory('docs/plans/2026/q1/sprint.md', watchDirs, projectRoot)).toBe(true);
  });

  it('returns false when watchDirs is empty', () => {
    expect(isInPlanDirectory('docs/plans/sprint.md', [], projectRoot)).toBe(false);
  });

  it('uses an absolute path for the watch dir itself', () => {
    const absDirs = ['/home/user/myproject/docs/plans'];
    expect(isInPlanDirectory('/home/user/myproject/docs/plans/sprint.md', absDirs, projectRoot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPlanWriteEvent
// ---------------------------------------------------------------------------

describe('isPlanWriteEvent', () => {
  const base: PlanWatchConfig = {
    watchDirs: ['docs/plans'],
    projectRoot: '/home/user/myproject',
  };

  it('returns file_path for a Write tool targeting a plan dir', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.md' }, base))
      .toBe('/home/user/myproject/docs/plans/sprint.md');
  });

  it('returns file path for an Edit tool', () => {
    expect(isPlanWriteEvent('Edit', { file_path: '/home/user/myproject/docs/plans/sprint.md' }, base))
      .toBe('/home/user/myproject/docs/plans/sprint.md');
  });

  it('returns file path for a Create tool', () => {
    expect(isPlanWriteEvent('Create', { file_path: 'docs/plans/new.md' }, base))
      .toBe('docs/plans/new.md');
  });

  it('extracts path from toolInput.path when file_path is absent', () => {
    expect(isPlanWriteEvent('Write', { path: 'docs/plans/sprint.md' }, base))
      .toBe('docs/plans/sprint.md');
  });

  it('returns null for a Read tool (non-write)', () => {
    expect(isPlanWriteEvent('Read', { file_path: '/home/user/myproject/docs/plans/sprint.md' }, base))
      .toBeNull();
  });

  it('returns null for a Bash tool', () => {
    expect(isPlanWriteEvent('Bash', { command: 'echo hello' }, base)).toBeNull();
  });

  it('returns null when file path is outside plan dirs', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/src/index.ts' }, base))
      .toBeNull();
  });

  it('returns null when toolInput is undefined', () => {
    expect(isPlanWriteEvent('Write', undefined, base)).toBeNull();
  });

  it('returns null when toolInput has no file_path or path', () => {
    expect(isPlanWriteEvent('Write', { content: 'hello' }, base)).toBeNull();
  });

  it('prefers file_path over path when both are present', () => {
    expect(isPlanWriteEvent('Write', { file_path: 'docs/plans/a.md', path: 'docs/plans/b.md' }, base))
      .toBe('docs/plans/a.md');
  });

  // Extension filtering

  it('returns file path when extension matches the allowed list', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.md' }, { ...base, extensions: ['.md'] }))
      .toBe('/home/user/myproject/docs/plans/sprint.md');
  });

  it('returns null when extension does not match the allowed list', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.ts' }, { ...base, extensions: ['.md'] }))
      .toBeNull();
  });

  it('extension check is case-insensitive', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.MD' }, { ...base, extensions: ['.md'] }))
      .toBe('/home/user/myproject/docs/plans/sprint.MD');
  });

  it('returns file path for any extension when extensions list is empty', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.ts' }, { ...base, extensions: [] }))
      .toBe('/home/user/myproject/docs/plans/sprint.ts');
  });

  it('returns file path for any extension when extensions not set', () => {
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/sprint.ts' }, base))
      .toBe('/home/user/myproject/docs/plans/sprint.ts');
  });

  it('matches when multiple extensions are allowed', () => {
    const cfg = { ...base, extensions: ['.md', '.txt', '.yaml'] };
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/a.txt' }, cfg))
      .toBe('/home/user/myproject/docs/plans/a.txt');
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/b.yaml' }, cfg))
      .toBe('/home/user/myproject/docs/plans/b.yaml');
    expect(isPlanWriteEvent('Write', { file_path: '/home/user/myproject/docs/plans/c.ts' }, cfg))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePlanTitle
// ---------------------------------------------------------------------------

describe('parsePlanTitle', () => {
  it('extracts title from the first # heading', () => {
    const content = '# My Sprint Plan\n\nSome content here.';
    expect(parsePlanTitle(content)).toBe('My Sprint Plan');
  });

  it('ignores ## and deeper headings', () => {
    const content = '## Not a top-level heading\n\nSome content.';
    expect(parsePlanTitle(content)).toBeNull();
  });

  it('falls back to filename when no heading is found', () => {
    const content = 'Just some plain text without a heading.';
    expect(parsePlanTitle(content, 'sprint.md')).toBe('sprint.md');
  });

  it('returns null when content has no heading and no filename given', () => {
    const content = 'Just plain text.';
    expect(parsePlanTitle(content)).toBeNull();
  });

  it('trims whitespace around the heading text', () => {
    const content = '#   My Plan Title   \n\nContent.';
    expect(parsePlanTitle(content)).toBe('My Plan Title');
  });

  it('uses heading even when filename is also provided', () => {
    const content = '# Heading Title\n\nContent.';
    expect(parsePlanTitle(content, 'fallback.md')).toBe('Heading Title');
  });

  it('handles empty content with filename fallback', () => {
    expect(parsePlanTitle('', 'myplan.md')).toBe('myplan.md');
  });

  it('returns null for empty content with no filename', () => {
    expect(parsePlanTitle('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// capturePlan
// ---------------------------------------------------------------------------

describe('capturePlan', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('creates a plan row with correct fields', () => {
    const sessionId = 'test-capture-plan-001';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const result = capturePlan({
      sourcePath: '/home/user/myproject/docs/plans/sprint.md',
      content: '# Sprint Plan\n\nThis is the plan.',
      sessionId,
    });

    expect(result.id).toHaveLength(16);
    expect(result.title).toBe('Sprint Plan');
    expect(result.content).toBe('# Sprint Plan\n\nThis is the plan.');
    expect(result.source_path).toBe('/home/user/myproject/docs/plans/sprint.md');
    expect(result.session_id).toBe(sessionId);
    expect(result.prompt_batch_id).toBeNull();
    expect(result.content_hash).toBeTruthy();
    expect(result.status).toBe('active');
    expect(result.embedded).toBe(0);
  });

  it('stores the plan in the database', () => {
    const sessionId = 'test-capture-plan-002';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const result = capturePlan({
      sourcePath: '/home/user/myproject/docs/plans/q1.md',
      content: '# Q1 Plan\n\nContent.',
      sessionId,
    });

    const stored = getPlan(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(result.id);
    expect(stored!.title).toBe('Q1 Plan');
  });

  it('is associated with the session', () => {
    const sessionId = 'test-capture-plan-003';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    capturePlan({
      sourcePath: '/home/user/myproject/docs/plans/sprint.md',
      content: '# Sprint\n\nContent.',
      sessionId,
    });

    const plans = listPlansBySession(sessionId);
    expect(plans.length).toBe(1);
    expect(plans[0].session_id).toBe(sessionId);
  });

  it('uses deterministic ID based on sourcePath — same file upserts', () => {
    const sessionId = 'test-capture-plan-004';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const sourcePath = '/home/user/myproject/docs/plans/sprint.md';

    const first = capturePlan({
      sourcePath,
      content: '# Sprint\n\nOriginal content.',
      sessionId,
    });

    const second = capturePlan({
      sourcePath,
      content: '# Sprint\n\nUpdated content.',
      sessionId,
    });

    // Same ID because same sourcePath
    expect(second.id).toBe(first.id);

    // Content is updated
    const stored = getPlan(first.id);
    expect(stored!.content).toBe('# Sprint\n\nUpdated content.');
  });

  it('updates content_hash when content changes', () => {
    const sessionId = 'test-capture-plan-005';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const sourcePath = '/home/user/myproject/docs/plans/sprint.md';

    const first = capturePlan({
      sourcePath,
      content: '# Sprint\n\nOriginal.',
      sessionId,
    });

    const second = capturePlan({
      sourcePath,
      content: '# Sprint\n\nChanged.',
      sessionId,
    });

    expect(second.content_hash).not.toBe(first.content_hash);
  });

  it('does NOT reset embedded flag when content is unchanged', () => {
    const sessionId = 'test-capture-plan-006';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const sourcePath = '/home/user/myproject/docs/plans/sprint.md';
    const content = '# Sprint\n\nSame content.';

    const first = capturePlan({ sourcePath, content, sessionId });

    // Manually mark as embedded
    getDatabase().prepare('UPDATE plans SET embedded = 1 WHERE id = ?').run(first.id);

    // Re-capture with identical content
    const second = capturePlan({ sourcePath, content, sessionId });

    // embedded flag should remain 1 (not reset) because content_hash is unchanged
    expect(second.embedded).toBe(1);
  });

  it('resets embedded flag when content changes', () => {
    const sessionId = 'test-capture-plan-007';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const sourcePath = '/home/user/myproject/docs/plans/sprint.md';

    const first = capturePlan({
      sourcePath,
      content: '# Sprint\n\nOriginal.',
      sessionId,
    });

    // Manually mark as embedded
    getDatabase().prepare('UPDATE plans SET embedded = 1 WHERE id = ?').run(first.id);

    // Re-capture with changed content — should reset embedded
    const second = capturePlan({
      sourcePath,
      content: '# Sprint\n\nChanged content!',
      sessionId,
    });

    expect(second.embedded).toBe(0);
  });

  it('stores prompt_batch_id when provided', () => {
    const sessionId = 'test-capture-plan-008';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    // Insert a real batch so the FK constraint is satisfied
    const batch = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'test prompt',
      started_at: now,
      created_at: now,
    });

    const result = capturePlan({
      sourcePath: '/home/user/myproject/docs/plans/sprint.md',
      content: '# Sprint\n\nContent.',
      sessionId,
      promptBatchId: batch.id,
    });

    expect(result.prompt_batch_id).toBe(batch.id);
  });

  it('falls back to filename as title when no heading present', () => {
    const sessionId = 'test-capture-plan-009';
    const now = epochNow();

    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    const result = capturePlan({
      sourcePath: '/home/user/myproject/docs/plans/roadmap.md',
      content: 'No heading here, just plain content.',
      sessionId,
    });

    expect(result.title).toBe('roadmap.md');
  });
});
