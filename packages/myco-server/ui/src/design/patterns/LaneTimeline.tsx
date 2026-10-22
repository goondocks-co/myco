import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { selectedRow } from '../lib/classes';
import { Link } from '../primitives/Link';

/** One lane: a named span of time, and the lanes nested under it. */
export interface Lane {
  key: string;
  /** The lane's name, never an id. */
  name: ReactNode;
  /** Makes the name a link to this path. */
  to?: string;
  /** The line under the name, such as the harness and the relation. */
  detail?: ReactNode;
  /** The span in words, as in "Oct 18, 21:30 – 22:10". */
  when: ReactNode;
  /** The span the track draws; a lane with no start draws none, and one with no end runs to the timeline's end. */
  start: number | null;
  end: number | null;
  /** The lane the page is about. */
  current?: boolean;
  lanes?: readonly Lane[];
}

export interface LaneTimelineProps {
  lanes: readonly Lane[];
  /** Names the list, as in "Lineage". */
  label: string;
  /** Where a lane with no end stops. */
  now: number;
  className?: string;
}

interface Range { from: number; to: number }

function rangeOf(lanes: readonly Lane[], now: number): Range | null {
  const spans = (all: readonly Lane[]): Array<[number, number]> =>
    all.flatMap((lane) => [...(lane.start === null ? [] : [[lane.start, lane.end ?? now] as [number, number]]), ...spans(lane.lanes ?? [])]);
  const all = spans(lanes);
  if (all.length === 0) return null;
  const from = Math.min(...all.map(([start]) => start));
  return { from, to: Math.max(from + 1, ...all.map(([, end]) => end)) };
}

/**
 * Lanes nested as a tree, each a row with its name, its detail and its span in words, and beside them from the `md`
 * width a track that places its span on one shared time axis. The track is drawn for the eye alone; every fact it
 * shows is in the row's words. The current lane is marked as the selected row is.
 */
export function LaneTimeline({ lanes, label, now, className }: LaneTimelineProps) {
  const range = rangeOf(lanes, now);
  return (
    <ol aria-label={label} className={cn('flex flex-col gap-s1', className)} data-lane-timeline="">
      {lanes.map((lane) => <LaneItem key={lane.key} lane={lane} depth={0} range={range} now={now} />)}
    </ol>
  );
}

function LaneItem({ lane, depth, range, now }: { lane: Lane; depth: number; range: Range | null; now: number }) {
  const name = lane.to !== undefined && lane.current !== true
    ? <Link to={lane.to} className="tap-area font-medium">{lane.name}</Link>
    : <span className={cn('font-medium', lane.current === true ? 'text-ink' : 'text-ink-2')}>{lane.name}</span>;
  return (
    <li>
      <div
        className={cn('flex items-center gap-s3 rounded-control px-s3 py-s2', lane.current === true && selectedRow)}
        aria-current={lane.current === true ? 'true' : undefined}
        data-lane={lane.current === true ? 'current' : ''}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-[2px] md:w-2/5 md:flex-none" style={{ paddingLeft: `calc(${depth} * var(--s-4))` }}>
          <span className="break-words t-body">{name}</span>
          {lane.detail != null && <span className="break-words t-small text-muted">{lane.detail}</span>}
          <span className="t-meta tabular-nums text-muted">{lane.when}</span>
        </div>
        <Track lane={lane} range={range} now={now} />
      </div>
      {lane.lanes !== undefined && lane.lanes.length > 0 && (
        <ol className="flex flex-col gap-s1">
          {lane.lanes.map((child) => <LaneItem key={child.key} lane={child} depth={depth + 1} range={range} now={now} />)}
        </ol>
      )}
    </li>
  );
}

function Track({ lane, range, now }: { lane: Lane; range: Range | null; now: number }) {
  const span = range === null || lane.start === null ? null : {
    left: ((lane.start - range.from) / (range.to - range.from)) * 100,
    right: (((lane.end ?? now) - range.from) / (range.to - range.from)) * 100,
  };
  return (
    <div aria-hidden className="relative hidden h-s3 flex-1 rounded-pill bg-surface-2 md:block" data-lane-track="">
      {span !== null && (
        <div
          className={cn('absolute inset-y-0 min-w-s1 rounded-pill', lane.current === true ? 'bg-primary' : 'bg-line-strong', lane.end === null && 'rounded-r-none')}
          style={{ left: `${span.left}%`, width: `${Math.max(span.right - span.left, 0)}%` }}
        />
      )}
    </div>
  );
}
