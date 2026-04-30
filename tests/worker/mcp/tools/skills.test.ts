import { describe, it, expect } from 'bun:test';
import { handleSkills } from '@myco-team-worker/mcp/tools/skills';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleSkills', () => {
  it('returns a list of skills', async () => {
    const fake = createFakeD1();
    fake.addResult([
      { id: 'sk1', machine_id: 'm1', name: 'debug-daemon', display_name: 'Debug Daemon', description: 'Debug daemon errors', status: 'active', generation: 2, usage_count: 15, last_used_at: 1700000000, created_at: 1699000000, updated_at: 1700000000 },
      { id: 'sk2', machine_id: 'm1', name: 'write-skill', display_name: 'Write Skill', description: 'Write skills', status: 'active', generation: 1, usage_count: 3, last_used_at: 1700000000, created_at: 1699000000, updated_at: 1700000000 },
    ]);

    const result = await handleSkills({}, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.skills).toHaveLength(2);
    expect(parsed.skills[0].name).toBe('debug-daemon');
  });

  it('retrieves a skill by id and machine_id', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'sk1', machine_id: 'm1', name: 'debug-daemon' }]);

    const result = await handleSkills({ op: 'get', id: 'sk1', machine_id: 'm1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed).toEqual({ id: 'sk1', machine_id: 'm1', name: 'debug-daemon' });
    expect(fake.queries[0].sql).toContain('FROM skill_records');
    expect(fake.queries[0].sql).toContain('machine_id = ?');
    expect(fake.queries[0].values).toEqual(['sk1', 'm1']);
  });

  it('filters by status', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'sk1', status: 'active' }]);

    await handleSkills({ status: 'active' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('status = ?');
    expect(fake.queries[0].values[0]).toBe('active');
  });

  it('defaults limit to 50', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSkills({}, { MYCO_TEAM_DB: fake.db });

    const values = fake.queries[0].values;
    expect(values[values.length - 1]).toBe(50);
  });

  it('respects limit parameter', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleSkills({ limit: 10 }, { MYCO_TEAM_DB: fake.db });

    const values = fake.queries[0].values;
    expect(values[values.length - 1]).toBe(10);
  });

  it('clamps limit to range [1, 100]', async () => {
    const fake = createFakeD1();
    fake.addResult([]);
    await handleSkills({ limit: 0 }, { MYCO_TEAM_DB: fake.db });
    expect(fake.queries[0].values[fake.queries[0].values.length - 1]).toBe(1);

    const fake2 = createFakeD1();
    fake2.addResult([]);
    await handleSkills({ limit: 200 }, { MYCO_TEAM_DB: fake2.db });
    expect(fake2.queries[0].values[fake2.queries[0].values.length - 1]).toBe(100);
  });

  it('returns empty array when no skills exist', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    const result = await handleSkills({}, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.skills).toHaveLength(0);
  });
});
