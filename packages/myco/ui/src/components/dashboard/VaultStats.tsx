import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { StatCard } from '../ui/stat-card';
import { useCanopyRollup } from '../../hooks/use-canopy';

/* ---------- Helpers ---------- */

const KILO = 1_000;
const MEGA = 1_000_000;

/** Compact, sign-preserving integer formatter for the Canopy headline. */
function formatTokens(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= MEGA) return `${sign}${(abs / MEGA).toFixed(1)}M`;
  if (abs >= KILO * 10) return `${sign}${Math.round(abs / KILO)}k`;
  if (abs >= KILO) return `${sign}${(abs / KILO).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString()}`;
}

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

  // Canopy lifetime rollup — folded into the dashboard stat row in place
  // of the wide banner that previously sat above search on the session
  // list page. Renders zeros while the endpoint is loading or returns
  // null (pre-feature install) so the grid layout is stable.
  const { data: canopy } = useCanopyRollup();
  const canopyTokensSaved = canopy?.total_tokens_saved ?? 0;
  const canopySessions = canopy?.sessions_with_canopy ?? 0;
  const canopySublabel = canopySessions > 0
    ? `across ${canopySessions} session${canopySessions === 1 ? '' : 's'}`
    : 'no data yet';

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
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
        label="Canopy"
        value={formatTokens(canopyTokensSaved)}
        sublabel={canopySublabel}
        accent="sage"
        href="/cortex?tab=canopy"
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
