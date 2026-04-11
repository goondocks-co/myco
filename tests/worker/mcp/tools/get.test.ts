import { describe, it, expect } from 'vitest';
import { handleGet } from '../../../../src/worker/src/mcp/tools/get';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleGet', () => {
  it('retrieves a record by type and id', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'found spore', observation_type: 'gotcha' }]);

    const result = await handleGet({ id: 'sp1', type: 'spore' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.id).toBe('sp1');
    expect(parsed.content).toBe('found spore');
    expect(fake.queries[0].sql).toContain('FROM spores');
  });

  it('maps each type to the correct table', async () => {
    const types = [
      { type: 'session', table: 'sessions' },
      { type: 'spore', table: 'spores' },
      { type: 'plan', table: 'plans' },
      { type: 'artifact', table: 'artifacts' },
      { type: 'skill', table: 'skill_records' },
    ];

    for (const { type, table } of types) {
      const fake = createFakeD1();
      fake.addResult([{ id: 'test-id' }]);

      await handleGet({ id: 'test-id', type }, { MYCO_TEAM_DB: fake.db });
      expect(fake.queries[0].sql).toContain(`FROM ${table}`);
    }
  });

  it('returns error for unknown type', async () => {
    const fake = createFakeD1();

    const result = await handleGet({ id: 'x', type: 'widget' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.error).toBe('Unknown type: widget');
    expect(fake.queries).toHaveLength(0);
  });

  it('returns not-found when record does not exist', async () => {
    const fake = createFakeD1();
    // No addResult — first() returns null

    const result = await handleGet({ id: 'missing', type: 'session' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.error).toBe("session 'missing' not found");
  });
});
