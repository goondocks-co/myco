import { describe, it, expect } from 'vitest';
import { handleContext } from '@myco-team-worker/mcp/tools/context';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleContext', () => {
  it('returns digest content at specified tier', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: '1', tier: 3000, content: 'digest at 3000', generated_at: 1700000000 }]);

    const result = await handleContext({ tier: 3000 }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.content).toBe('digest at 3000');
    expect(parsed.tier).toBe(3000);
    expect(parsed.generated_at).toBe(1700000000);
  });

  it('defaults to tier 5000 when not specified', async () => {
    const fake = createFakeD1();
    fake.addResult([{ id: '1', tier: 5000, content: 'default digest', generated_at: 1700000000 }]);

    await handleContext({}, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].values[0]).toBe(5000);
  });

  it('returns not-found message when no digest exists', async () => {
    const fake = createFakeD1();
    // No addResult — first() will return null

    const result = await handleContext({ tier: 1500 }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.content).toBeNull();
    expect(parsed.tier).toBe(1500);
    expect(parsed.message).toBe('No digest available at tier 1500');
  });
});
