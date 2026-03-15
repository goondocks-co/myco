import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoRecall } from '@myco/mcp/tools/recall';
import { MycoIndex } from '@myco/index/sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('myco_recall', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recall-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));

    index.upsertNote({
      path: 'plans/auth.md', type: 'plan', id: 'auth',
      title: 'Auth Redesign', content: 'Replace JWT secret.',
      frontmatter: { type: 'plan', id: 'auth', status: 'active' },
      created: '2026-03-10T00:00:00Z',
    });
    index.upsertNote({
      path: 'sessions/s1.md', type: 'session', id: 's1',
      title: 'Auth Session 1', content: 'Started refactoring.',
      frontmatter: {
        type: 'session', id: 's1', user: 'chris',
        branch: 'feature/auth', plan: '[[auth]]',
      },
      created: '2026-03-12T09:00:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recalls active plans', async () => {
    const result = await handleMycoRecall(index, {});
    expect(result.active_plans).toHaveLength(1);
    expect(result.active_plans[0].id).toBe('auth');
  });

  it('recalls recent sessions for a branch', async () => {
    const result = await handleMycoRecall(index, { branch: 'feature/auth' });
    expect(result.recent_sessions).toHaveLength(1);
  });

  it('returns empty context for fresh vault', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-empty-'));
    const emptyIndex = new MycoIndex(path.join(emptyDir, 'index.db'));

    const result = await handleMycoRecall(emptyIndex, {});
    expect(result.active_plans).toEqual([]);
    expect(result.recent_sessions).toEqual([]);

    emptyIndex.close();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
