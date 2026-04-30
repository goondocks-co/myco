import { describe, it, expect } from 'bun:test';
import { handleSessions } from '@myco-team-worker/mcp/tools/sessions';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleSessions', () => {
  it('returns a list of sessions', async () => {
    const fake = createFakeD1();
    fake.addResult([
      { id: 's1', machine_id: 'm1', agent: 'claude', status: 'completed', title: 'Session 1' },
      { id: 's2', machine_id: 'm1', agent: 'cursor', status: 'active', title: 'Session 2' },
    ]);

    const result = await handleSessions({}, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].id).toBe('s1');
  });

  it('retrieves a session by id and machine_id', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 's1', machine_id: 'm1', summary: 'full session' }]);

    const result = await handleSessions({ op: 'get', id: 's1', machine_id: 'm1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed).toEqual({ id: 's1', machine_id: 'm1', summary: 'full session' });
    expect(fake.queries[0].sql).toContain('FROM sessions');
    expect(fake.queries[0].sql).toContain('machine_id = ?');
    expect(fake.queries[0].values).toEqual(['s1', 'm1']);
  });

  it('filters by status', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 's1', status: 'completed' }]);

    await handleSessions({ status: 'completed' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('status = ?');
    expect(fake.queries[0].values[0]).toBe('completed');
  });

  it('filters by agent', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({ agent: 'claude' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('agent = ?');
    expect(fake.queries[0].values[0]).toBe('claude');
  });

  it('filters by branch', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({ branch: 'main' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('branch = ?');
    expect(fake.queries[0].values[0]).toBe('main');
  });

  it('filters by since (converts ISO string to epoch seconds)', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({ since: '2024-01-01T00:00:00Z' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('started_at >= ?');
    expect(fake.queries[0].values[0]).toBe(Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000));
  });

  it('combines multiple filters', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({ status: 'active', agent: 'claude', branch: 'main' }, { MYCO_TEAM_DB: fake.db });

    const sql = fake.queries[0].sql;
    expect(sql).toContain('status = ?');
    expect(sql).toContain('agent = ?');
    expect(sql).toContain('branch = ?');
    expect(fake.queries[0].values).toEqual(['active', 'claude', 'main', 20]);
  });

  it('respects limit parameter', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({ limit: 5 }, { MYCO_TEAM_DB: fake.db });

    // limit is the last bind value
    const values = fake.queries[0].values;
    expect(values[values.length - 1]).toBe(5);
  });

  it('clamps limit to range [1, 100]', async () => {
    const fake = createFakeD1();
    fake.addResult([]);
    await handleSessions({ limit: 0 }, { MYCO_TEAM_DB: fake.db });
    expect(fake.queries[0].values[fake.queries[0].values.length - 1]).toBe(1);

    const fake2 = createFakeD1();
    fake2.addResult([]);
    await handleSessions({ limit: 200 }, { MYCO_TEAM_DB: fake2.db });
    expect(fake2.queries[0].values[fake2.queries[0].values.length - 1]).toBe(100);
  });

  it('defaults limit to 20', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSessions({}, { MYCO_TEAM_DB: fake.db });

    const values = fake.queries[0].values;
    expect(values[values.length - 1]).toBe(20);
  });
});
