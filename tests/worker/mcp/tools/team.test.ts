import { describe, it, expect } from 'vitest';
import { handleTeam } from '../../../../src/worker/src/mcp/tools/team';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleTeam', () => {
  it('returns registered nodes', async () => {
    const fake = createFakeD1();
    fake.addResult([
      { machine_id: 'm1', package_version: '0.17.0', schema_version: 9, sync_protocol_version: 1, last_seen: 1700000000, registered_at: 1699000000 },
      { machine_id: 'm2', package_version: '0.16.2', schema_version: 9, sync_protocol_version: 1, last_seen: 1699500000, registered_at: 1699000000 },
    ]);

    const result = await handleTeam({ MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0].machine_id).toBe('m1');
    expect(parsed.nodes[1].machine_id).toBe('m2');
  });

  it('returns empty array when no nodes registered', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    const result = await handleTeam({ MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.nodes).toHaveLength(0);
  });

  it('queries the correct columns from nodes table', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleTeam({ MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('machine_id');
    expect(fake.queries[0].sql).toContain('package_version');
    expect(fake.queries[0].sql).toContain('schema_version');
    expect(fake.queries[0].sql).toContain('sync_protocol_version');
    expect(fake.queries[0].sql).toContain('last_seen');
    expect(fake.queries[0].sql).toContain('registered_at');
    expect(fake.queries[0].sql).toContain('ORDER BY last_seen DESC');
  });
});
