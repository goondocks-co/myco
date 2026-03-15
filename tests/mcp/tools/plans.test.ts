import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoPlans } from '@myco/mcp/tools/plans';
import { MycoIndex } from '@myco/index/sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('myco_plans', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plans-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));

    index.upsertNote({
      path: 'plans/auth.md', type: 'plan', id: 'auth',
      title: 'Auth Redesign', content: '- [x] Step 1\n- [ ] Step 2',
      frontmatter: { type: 'plan', id: 'auth', status: 'active' },
      created: '2026-03-10T00:00:00Z',
    });
    index.upsertNote({
      path: 'plans/done.md', type: 'plan', id: 'done',
      title: 'Completed Plan', content: '- [x] All done',
      frontmatter: { type: 'plan', id: 'done', status: 'completed' },
      created: '2026-03-01T00:00:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists active plans', async () => {
    const results = await handleMycoPlans(index, { status: 'active' });
    expect(results).toHaveLength(1);
    expect((results as any[])[0].id).toBe('auth');
  });

  it('gets plan detail with derived sessions', async () => {
    index.upsertNote({
      path: 'sessions/s1.md', type: 'session', id: 's1',
      title: 'Session 1', content: '',
      frontmatter: { type: 'session', id: 's1', plan: '[[auth]]' },
      created: '2026-03-12T09:00:00Z',
    });

    const result = await handleMycoPlans(index, { id: 'auth' }) as any;
    expect(result.sessions).toHaveLength(1);
    expect(result.progress).toBe('1/2');
  });
});
