import { type StatsResponse } from '../../hooks/use-daemon';

/* ---------- Helpers ---------- */

function connectivityLabel(stats: StatsResponse): string {
  const { embedded_count, total_embeddable } = stats.embedding;
  if (total_embeddable === 0) return 'Initializing';
  const ratio = embedded_count / total_embeddable;
  if (ratio >= 0.95) return 'Optimal';
  if (ratio >= 0.7) return 'Good';
  return 'Degraded';
}

/* ---------- Component ---------- */

export function FooterStatus({ stats }: { stats: StatsResponse }) {
  const label = connectivityLabel(stats);

  return (
    <div className="flex items-center justify-between px-2 py-3 border-t border-outline-variant/10">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase text-sage">
          System Connectivity: {label}
        </span>
        <span className="w-1.5 h-1.5 rounded-full bg-sage animate-pulse" />
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono text-[10px] uppercase text-outline/50">
          {stats.vault.name}
        </span>
        <span className="font-mono text-[10px] uppercase text-outline/50">
          v{stats.daemon.version}
        </span>
      </div>
    </div>
  );
}
