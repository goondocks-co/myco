import { describe, expect, it } from 'bun:test';
import { sectionRows } from '../../packages/myco/ui/src/lib/section-rows';

// Fixed local-time anchor: 2026-05-14T15:00:00 in whichever timezone the
// tests run. The helper buckets by local calendar day, so we derive the
// boundaries from the same anchor to keep the tests timezone-independent.
const NOW = new Date(2026, 4, 14, 15, 0, 0); // May 14 2026, 15:00 local
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const startOfToday = new Date(2026, 4, 14, 0, 0, 0);
const startOfYesterday = new Date(2026, 4, 13, 0, 0, 0);
const startOfDayBeforeYesterday = new Date(2026, 4, 12, 0, 0, 0);

const TODAY_SEC = Math.floor(startOfToday.getTime() / 1000) + 60 * 60; // 01:00 today
const YESTERDAY_SEC = Math.floor(startOfYesterday.getTime() / 1000) + 60 * 60; // 01:00 yesterday
const EARLIER_SEC = Math.floor(startOfDayBeforeYesterday.getTime() / 1000) - 60; // a minute before yesterday's midnight

interface Row {
  id: string;
  status: 'active' | 'completed';
  started_at: number | null;
}

const isActive = (r: Row) => r.status === 'active';
const startedAtEpochSec = (r: Row) => r.started_at;

describe('sectionRows', () => {
  it('returns only ACTIVE section when all rows are active', () => {
    const rows: Row[] = [
      { id: 'a', status: 'active', started_at: EARLIER_SEC },
      { id: 'b', status: 'active', started_at: TODAY_SEC },
    ];
    const sections = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: NOW_SEC });
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('ACTIVE');
    expect(sections[0].rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns sections in display order and omits empty ones', () => {
    const rows: Row[] = [
      { id: 'active1', status: 'active', started_at: TODAY_SEC },
      { id: 'today1', status: 'completed', started_at: TODAY_SEC },
      { id: 'earlier1', status: 'completed', started_at: EARLIER_SEC },
    ];
    const sections = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: NOW_SEC });
    // No YESTERDAY rows — that section should be omitted entirely.
    expect(sections.map((s) => s.label)).toEqual(['ACTIVE', 'TODAY', 'EARLIER']);
    expect(sections[0].rows.map((r) => r.id)).toEqual(['active1']);
    expect(sections[1].rows.map((r) => r.id)).toEqual(['today1']);
    expect(sections[2].rows.map((r) => r.id)).toEqual(['earlier1']);
  });

  it('preserves the original order of rows within each section', () => {
    const rows: Row[] = [
      { id: 't1', status: 'completed', started_at: TODAY_SEC + 100 },
      { id: 't2', status: 'completed', started_at: TODAY_SEC + 50 },
      { id: 't3', status: 'completed', started_at: TODAY_SEC + 10 },
    ];
    const sections = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: NOW_SEC });
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('TODAY');
    expect(sections[0].rows.map((r) => r.id)).toEqual(['t1', 't2', 't3']);
  });

  it('buckets non-active rows with null started_at into EARLIER', () => {
    const rows: Row[] = [
      { id: 'orphan', status: 'completed', started_at: null },
      { id: 'today', status: 'completed', started_at: TODAY_SEC },
    ];
    const sections = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: NOW_SEC });
    expect(sections.map((s) => s.label)).toEqual(['TODAY', 'EARLIER']);
    expect(sections[1].rows.map((r) => r.id)).toEqual(['orphan']);
  });

  it('honors nowEpochSec for deterministic today/yesterday boundaries', () => {
    const rows: Row[] = [
      { id: 'today', status: 'completed', started_at: TODAY_SEC },
      { id: 'yesterday', status: 'completed', started_at: YESTERDAY_SEC },
      { id: 'earlier', status: 'completed', started_at: EARLIER_SEC },
    ];
    const sections = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: NOW_SEC });
    expect(sections.map((s) => s.label)).toEqual(['TODAY', 'YESTERDAY', 'EARLIER']);
    expect(sections[0].rows.map((r) => r.id)).toEqual(['today']);
    expect(sections[1].rows.map((r) => r.id)).toEqual(['yesterday']);
    expect(sections[2].rows.map((r) => r.id)).toEqual(['earlier']);

    // Shift "now" forward by one day: yesterday's row should now be EARLIER.
    const tomorrowNow = NOW_SEC + 24 * 60 * 60;
    const shifted = sectionRows(rows, { isActive, startedAtEpochSec, nowEpochSec: tomorrowNow });
    const byLabel = new Map(shifted.map((s) => [s.label, s.rows.map((r) => r.id)]));
    expect(byLabel.get('TODAY')).toBeUndefined();
    expect(byLabel.get('YESTERDAY')).toEqual(['today']);
    expect(byLabel.get('EARLIER')).toEqual(['yesterday', 'earlier']);
  });
});
