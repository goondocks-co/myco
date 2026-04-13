import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { StatCard } from '../ui/stat-card';

/* ---------- Component ---------- */

export function VaultStats({ stats }: { stats: StatsResponse }) {
  const embeddingPercent =
    stats.embedding.total_embeddable > 0
      ? Math.round(
          (stats.embedding.embedded_count / stats.embedding.total_embeddable) * 100,
        )
      : 0;

  const digestLabel =
    stats.digest.tiers_available.length > 0
      ? `${stats.digest.tiers_available.length} tiers`
      : 'None';

  const agentLabel =
    stats.agent.last_run_at
      ? formatEpochAgo(stats.agent.last_run_at)
      : 'Never';

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      <StatCard
        label="Sessions"
        value={String(stats.vault.session_count)}
        sublabel={`${stats.daemon.active_sessions.length} active`}
        accent="sage"
        href="/sessions"
      />
      <StatCard
        label="Spores"
        value={String(stats.vault.spore_count)}
        sublabel={`${stats.vault.entity_count} entities`}
        accent="sage"
        href="/mycelium?tab=spores"
      />
      <StatCard
        label="Embedding"
        value={`${embeddingPercent}%`}
        sublabel={`${stats.embedding.embedded_count}/${stats.embedding.total_embeddable}`}
        accent={stats.embedding.queue_depth > 0 ? 'ochre' : 'sage'}
        href="/operations"
      />
      <StatCard
        label="Agent"
        value={`${stats.agent.total_runs}`}
        sublabel={`last: ${agentLabel}`}
        accent={stats.agent.last_run_status === 'error' ? 'terracotta' : 'outline'}
        href="/agent"
      />
      <StatCard
        label="Digest"
        value={digestLabel}
        sublabel={stats.digest.generated_at ? formatEpochAgo(stats.digest.generated_at) : undefined}
        accent="outline"
        href="/mycelium?tab=digest"
      />
      <StatCard
        label="Uptime"
        value={formatUptime(stats.daemon.uptime_seconds)}
        sublabel={`v${stats.daemon.version}`}
        accent="outline"
      />
    </div>
  );
}
