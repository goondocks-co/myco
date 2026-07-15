import { describe, it, expect } from 'bun:test';
import { formatTimestamp } from '../../packages/myco/ui/src/components/sessions/batch-timeline-helpers';

describe('formatTimestamp', () => {
  it('includes a date (month and day) alongside the time, so multi-day sessions stay readable', () => {
    const epochSeconds = 1783739257;
    const options = {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    } as const;
    const parts = new Intl.DateTimeFormat([], options).formatToParts(new Date(epochSeconds * 1000));
    const partTypes = parts.map((p) => p.type);

    const out = formatTimestamp(epochSeconds);
    const timeOnly = new Date(epochSeconds * 1000).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    expect(partTypes).toContain('month');
    expect(partTypes).toContain('day');
    expect(out.length).toBeGreaterThan(timeOnly.length);
    expect(out).toContain(timeOnly.match(/\d{1,2}:\d{2}:\d{2}/)?.[0] ?? timeOnly);
  });
});
