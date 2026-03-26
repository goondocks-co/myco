import { useActivity } from '../../hooks/use-activity';
import { SessionPodCard } from './SessionPodCard';

/* ---------- Constants ---------- */

const POD_GRID_LIMIT = 6;

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
        <div className="font-mono text-sm text-outline py-8 text-center">Loading pods...</div>
      ) : events.length === 0 ? (
        <div className="font-mono text-sm text-outline py-8 text-center">No recent activity</div>
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
