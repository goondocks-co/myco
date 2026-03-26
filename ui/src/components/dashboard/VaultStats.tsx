import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Types ---------- */

interface StatCardProps {
  label: string;
  value: string;
  sublabel?: string;
  accent: 'sage' | 'ochre' | 'terracotta' | 'outline';
}

/* ---------- Constants ---------- */

const ACCENT_BORDER: Record<StatCardProps['accent'], string> = {
  sage: 'border-t-sage',
  ochre: 'border-t-ochre',
  terracotta: 'border-t-terracotta',
  outline: 'border-t-outline',
};

const ACCENT_VALUE: Record<StatCardProps['accent'], string> = {
  sage: 'text-sage',
  ochre: 'text-ochre',
  terracotta: 'text-terracotta',
  outline: 'text-on-surface',
};

/* ---------- Sub-components ---------- */

function StatCard({ label, value, sublabel, accent }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-outline-variant/10 bg-surface-container/60 p-4 border-t-2',
        ACCENT_BORDER[accent],
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-outline mb-2">
        {label}
      </p>
      <p className={cn('font-serif text-2xl font-bold', ACCENT_VALUE[accent])}>
        {value}
      </p>
      {sublabel && (
        <p className="font-mono text-[10px] text-outline mt-1">{sublabel}</p>
      )}
    </div>
  );
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

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      <StatCard
        label="Sessions"
        value={String(stats.vault.session_count)}
        sublabel={`${stats.daemon.active_sessions.length} active`}
        accent="sage"
      />
      <StatCard
        label="Spores"
        value={String(stats.vault.spore_count)}
        sublabel={`${stats.vault.entity_count} entities`}
        accent="sage"
      />
      <StatCard
        label="Embedding"
        value={`${embeddingPercent}%`}
        sublabel={`${stats.embedding.embedded_count}/${stats.embedding.total_embeddable}`}
        accent={stats.embedding.queue_depth > 0 ? 'ochre' : 'sage'}
      />
      <StatCard
        label="Agent"
        value={`${stats.agent.total_runs}`}
        sublabel={`last: ${agentLabel}`}
        accent={stats.agent.last_run_status === 'error' ? 'terracotta' : 'outline'}
      />
      <StatCard
        label="Digest"
        value={digestLabel}
        sublabel={stats.digest.generated_at ? formatEpochAgo(stats.digest.generated_at) : undefined}
        accent="outline"
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
