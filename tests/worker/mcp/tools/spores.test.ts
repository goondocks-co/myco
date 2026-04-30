import { describe, it, expect } from 'bun:test';
import { handleSpores } from '@myco-team-worker/mcp/tools/spores';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleSpores', () => {
  it('lists spores with filters', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'spore' }]);

    const result = await handleSpores({
      status: 'active',
      observation_type: 'decision',
      agent_id: 'agent',
      search: 'sqlite',
      limit: 5,
      offset: 2,
    }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.spores).toHaveLength(1);
    expect(parsed.offset).toBe(2);
    expect(parsed.limit).toBe(5);
    expect(fake.queries[0].sql).toContain('status = ?');
    expect(fake.queries[0].sql).toContain('observation_type = ?');
    expect(fake.queries[0].sql).toContain('agent_id = ?');
    expect(fake.queries[0].sql).toContain('content LIKE ?');
    expect(fake.queries[0].values).toEqual(['active', 'decision', 'agent', '%sqlite%', 5, 2]);
  });

  it('retrieves a spore by id and machine_id', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'full spore' }]);

    const result = await handleSpores({ op: 'get', id: 'sp1', machine_id: 'm1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed).toEqual({ id: 'sp1', machine_id: 'm1', content: 'full spore' });
    expect(fake.queries[0].sql).toContain('FROM spores');
    expect(fake.queries[0].values).toEqual(['sp1', 'm1']);
  });
});
