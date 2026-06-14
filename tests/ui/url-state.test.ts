import { describe, expect, it } from 'bun:test';
import {
  appendSearchHash,
  parseOffset,
  pathnameWithSearchHash,
  updateQueryValues,
} from '../../packages/myco/ui/src/lib/url-state';

describe('url-state helpers', () => {
  it('appends existing search and hash to redirect targets', () => {
    expect(appendSearchHash('/g/default/p/app/agent/run-1', '?status=failed', '#audit'))
      .toBe('/g/default/p/app/agent/run-1?status=failed#audit');
  });

  it('parses only non-negative integer offsets', () => {
    expect(parseOffset('20')).toBe(20);
    expect(parseOffset('0')).toBe(0);
    expect(parseOffset('-1')).toBe(0);
    expect(parseOffset('1.5')).toBe(0);
    expect(parseOffset('nope')).toBe(0);
    expect(parseOffset(null)).toBe(0);
  });

  it('updates owned query keys without dropping unrelated detail state', () => {
    const params = updateQueryValues('?tab=plans&plan=p1&agent=codex&offset=20', {
      agent: { value: 'all', defaultValue: 'all' },
      status: { value: 'completed', defaultValue: 'all' },
      offset: { value: 0, defaultValue: 0 },
    });
    expect(params.toString()).toBe('tab=plans&plan=p1&status=completed');
  });

  it('builds pathnames from params and hash', () => {
    const params = new URLSearchParams('agent=codex&offset=20');
    expect(pathnameWithSearchHash('/sessions/s1', params, '#x')).toBe('/sessions/s1?agent=codex&offset=20#x');
  });
});
