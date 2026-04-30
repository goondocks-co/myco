import { describe, it, expect } from 'bun:test';
import { handlePlans } from '@myco-team-worker/mcp/tools/plans';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handlePlans', () => {
  it('lists plans with filters', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'p1', machine_id: 'm1', title: 'Plan', status: 'active' }]);

    const result = await handlePlans({ status: 'active', session: 'sess-1', limit: 5 }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.plans).toHaveLength(1);
    expect(fake.queries[0].sql).toContain('status = ?');
    expect(fake.queries[0].sql).toContain('session_id = ?');
    expect(fake.queries[0].values).toEqual(['active', 'sess-1', 5]);
  });

  it('retrieves a plan by id and machine_id', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'p1', machine_id: 'm1', content: '# Plan' }]);

    const result = await handlePlans({ op: 'get', id: 'p1', machine_id: 'm1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed).toEqual({ id: 'p1', machine_id: 'm1', content: '# Plan' });
    expect(fake.queries[0].sql).toContain('FROM plans');
    expect(fake.queries[0].values).toEqual(['p1', 'm1']);
  });
});
