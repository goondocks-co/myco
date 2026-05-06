import { useNavigate } from 'react-router-dom';
import { useSessions, type SessionSummary } from '../../hooks/use-sessions';
import { formatEpochAgo } from '../../lib/format';
import { cn } from '../../lib/cn';
import { useProjectPathBuilder } from '../../hooks/use-project-selection';

const ACTIVE_LIMIT = 6;

function formatAgent(agent: string): string {
  return agent
    .split(/[-_]/)
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function ActiveSessionCard({
  session,
  onClick,
}: {
  session: SessionSummary;
  onClick: () => void;
}) {
  const startedAgo = formatEpochAgo(session.started_at);
  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group relative overflow-hidden rounded-xl border border-sage/30 bg-gradient-to-br from-sage/10 via-surface-container/40 to-transparent p-5 text-left',
        'transition-all duration-200 hover:border-sage/60 hover:shadow-[0_0_24px_rgba(120,160,135,0.18)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
      aria-label={`Active session: ${session.title || session.id}`}
    >
      {/* Live pulse dot in the corner */}
      <span className="absolute right-4 top-4 flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sage" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-sage">live</span>
      </span>

      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        {formatAgent(session.agent)}
      </div>

      <h4 className="mt-2 font-serif text-lg leading-tight text-on-surface line-clamp-2">
        {session.title || 'Untitled session'}
      </h4>

      <div className="mt-4 flex items-center justify-between text-[11px] font-mono">
        <div className="flex items-center gap-4 text-on-surface-variant">
          <span>
            <span className="tabular-nums text-on-surface">{session.prompt_count}</span>
            <span className="ml-1 uppercase tracking-wider text-outline">prompts</span>
          </span>
          <span>
            <span className="tabular-nums text-on-surface">{session.tool_count}</span>
            <span className="ml-1 uppercase tracking-wider text-outline">tools</span>
          </span>
        </div>
        <span className="tabular-nums text-on-surface-variant">{startedAgo}</span>
      </div>
    </button>
  );
}

export function ActiveSessions() {
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();
  const { data, isLoading } = useSessions({ status: 'active', limit: ACTIVE_LIMIT });

  // Hide entirely when there's nothing active. The recent activity feed
  // below already conveys "what's been happening" so an empty state on
  // top would just be noise.
  if (isLoading) return null;
  const sessions = data?.sessions ?? [];
  if (sessions.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-serif text-2xl text-on-surface">Active Sessions</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          {sessions.length} live
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sessions.map((session) => (
          <ActiveSessionCard
            key={session.id}
            session={session}
            onClick={() => navigate(projectPath(`/sessions/${session.id}`))}
          />
        ))}
      </div>
    </section>
  );
}
