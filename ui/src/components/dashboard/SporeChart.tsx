import { useActivity, type ActivityEvent } from '../../hooks/use-activity';

/* ---------- Constants ---------- */

const CHART_BUCKETS = 8;
const CHART_FETCH_LIMIT = 50;
const HOURS_IN_DAY = 24;
const MS_PER_SECOND = 1000;
const BUCKET_MIN_HEIGHT_PERCENT = 5;

/* ---------- Helpers ---------- */

function bucketEvents(events: ActivityEvent[]): number[] {
  const now = Date.now();
  const dayMs = HOURS_IN_DAY * 60 * 60 * MS_PER_SECOND;
  const bucketSize = dayMs / CHART_BUCKETS;
  const counts = new Array<number>(CHART_BUCKETS).fill(0);

  for (const event of events) {
    const age = now - event.timestamp * MS_PER_SECOND;
    if (age < 0 || age > dayMs) continue;
    const bucket = Math.min(
      Math.floor((dayMs - age) / bucketSize),
      CHART_BUCKETS - 1,
    );
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function bucketLabel(index: number): string {
  const hoursPerBucket = HOURS_IN_DAY / CHART_BUCKETS;
  const hour = Math.floor(index * hoursPerBucket);
  return `${String(hour).padStart(2, '0')}:00`;
}

const OPACITY_STEPS = [
  'bg-sage/20',
  'bg-sage/30',
  'bg-sage/40',
  'bg-sage/50',
  'bg-sage/60',
  'bg-sage/70',
  'bg-sage/80',
  'bg-sage/90',
];

/* ---------- Component ---------- */

export function SporeChart() {
  const { data } = useActivity(CHART_FETCH_LIMIT);
  const events = data ?? [];
  const buckets = bucketEvents(events);
  const max = Math.max(...buckets, 1);

  return (
    <div className="glass-panel p-6 rounded-xl border border-outline-variant/10">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <h4 className="font-serif text-xl text-on-surface">Spore Density Over Time</h4>
        <svg className="h-5 w-5 text-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 16l4-6 4 3 5-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Bar chart */}
      <div className="h-48 flex items-end gap-2 px-2">
        {buckets.map((count, i) => {
          const heightPercent = Math.max(
            (count / max) * 100,
            count > 0 ? BUCKET_MIN_HEIGHT_PERCENT : 2,
          );
          const opacityClass = OPACITY_STEPS[Math.min(i, OPACITY_STEPS.length - 1)] ?? 'bg-sage/40';

          return (
            <div
              key={i}
              className={`flex-1 rounded-t transition-all duration-500 ${opacityClass}`}
              style={{ height: `${heightPercent}%` }}
              title={`${bucketLabel(i)}: ${count} events`}
            />
          );
        })}
      </div>

      {/* Time labels */}
      <div className="flex justify-between mt-4 font-mono text-[10px] text-outline">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:59</span>
      </div>
    </div>
  );
}
