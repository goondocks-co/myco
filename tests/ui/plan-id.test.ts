import { describe, expect, it } from 'bun:test';
import { truncatePlanId } from '../../packages/myco/ui/src/components/sessions/plan-id';

describe('truncatePlanId', () => {
  it('shortens a long id to a head + ellipsis', () => {
    expect(truncatePlanId('abcdef0123456789')).toBe('abcdef01…');
  });

  it('returns short ids unchanged', () => {
    expect(truncatePlanId('abc123')).toBe('abc123');
  });

  it('handles empty input', () => {
    expect(truncatePlanId('')).toBe('');
  });
});
