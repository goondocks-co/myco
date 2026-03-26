import { Radio } from 'lucide-react';
import { useActivity } from '../../hooks/use-activity';
import { SessionPodCard } from './SessionPodCard';

/* ---------- Constants ---------- */

const POD_GRID_LIMIT = 6;

/** Number of skeleton placeholders to show during loading. */
const SKELETON_COUNT = 3;

/* ---------- Sub-components ---------- */

function PodSkeleton() {
  return (
    <div className="p-5 rounded-lg border-l-4 border-l-outline-variant/30 bg-surface-container/40 animate-pulse">
      <div className="flex justify-between items-start mb-3">
        <div className="space-y-2">
          <div className="h-3 w-16 rounded bg-surface-container-high" />
          <div className="h-5 w-40 rounded bg-surface-container-high" />
        </div>
        <div className="w-8 h-8 rounded-full bg-surface-container-high" />
      </div>
      <div className="h-3 w-3/4 rounded bg-surface-container-high/60 mb-3" />
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded bg-surface-container-high/60" />
        <div className="h-5 w-12 rounded bg-surface-container-high/60" />
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export function SessionPodGrid() {
  const { data, isLoading } = useActivity(POD_GRID_LIMIT * 2);
  // Filter out agent runs — those are already visible in the activity log
  const events = (data ?? []).filter((e) => e.type !== 'agent_run').slice(0, POD_GRID_LIMIT);

  return (
    <section className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between border-b border-outline-variant/10 pb-4">
        <div>
          <h3 className="font-serif text-3xl text-on-surface">Session Pods</h3>
          <p className="font-mono text-[10px] uppercase text-outline mt-1">
            Monitoring concurrent thread activity
          </p>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <PodSkeleton key={i} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="relative">
            <Radio className="h-10 w-10 text-outline/30" />
            <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-surface-container border-2 border-surface" />
          </div>
          <p className="font-sans text-sm text-on-surface-variant">No recent activity</p>
          <p className="font-mono text-[10px] uppercase text-outline tracking-wider">
            Pods appear as sessions and spores are captured
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {events.map((event) => (
            <SessionPodCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}
