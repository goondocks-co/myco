import { Activity, Brain, HardDrive, Timer } from 'lucide-react';
import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';

/* ---------- Shared primitives ---------- */

export function StatRow({
  label,
  value,
  badge,
  badgeVariant,
}: {
  label: string;
  value: string;
  badge?: boolean;
  badgeVariant?: 'default' | 'secondary';
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-sans text-xs text-on-surface-variant">{label}</span>
      {badge ? (
        <Badge variant={badgeVariant ?? 'secondary'}>
          {value}
        </Badge>
      ) : (
        <span className="font-mono text-xs text-on-surface">{value}</span>
      )}
    </div>
  );
}

/* ---------- Stat Cards ---------- */

export function DaemonCard({ stats }: { stats: StatsResponse }) {
  return (
    <Surface level="low" className="p-4 space-y-2">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        Daemon
      </h3>
      <div className="space-y-1.5 text-sm">
        <StatRow label="Uptime" value={formatUptime(stats.daemon.uptime_seconds)} />
        <StatRow label="Version" value={`v${stats.daemon.version}`} />
        <StatRow label="Port" value={String(stats.daemon.port)} />
        <StatRow label="PID" value={String(stats.daemon.pid)} />
      </div>
    </Surface>
  );
}

export function VaultCard({ stats }: { stats: StatsResponse }) {
  return (
    <Surface level="low" className="p-4 space-y-2">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-primary" />
        Vault
      </h3>
      <div className="space-y-1.5 text-sm">
        <StatRow label="Sessions" value={String(stats.vault.session_count)} />
        <StatRow label="Spores" value={String(stats.vault.spore_count)} />
        <StatRow label="Plans" value={String(stats.vault.plan_count)} />
        <StatRow label="Artifacts" value={String(stats.vault.artifact_count)} />
        <StatRow label="Entities" value={String(stats.vault.entity_count)} />
        <StatRow label="Name" value={stats.vault.name} />
      </div>
    </Surface>
  );
}

export function DigestCard({ stats }: { stats: StatsResponse }) {
  const { digest } = stats;

  return (
    <Surface level="low" className="p-4 space-y-2">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <Timer className="h-4 w-4 text-primary" />
        Digest
      </h3>
      <div className="space-y-1.5 text-sm">
        <StatRow label="Tiers available" value={String(digest.tiers_available.length)} />
        {digest.freshest_tier !== null ? (
          <StatRow label="Freshest tier" value={`T${digest.freshest_tier}`} />
        ) : (
          <p className="font-sans text-xs text-on-surface-variant">No tiers yet</p>
        )}
        {digest.generated_at !== null && (
          <StatRow label="Generated" value={formatEpochAgo(digest.generated_at)} />
        )}
      </div>
    </Surface>
  );
}

export function IntelligenceCard({ stats }: { stats: StatsResponse }) {
  return (
    <Surface level="low" className="p-4 space-y-2">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary" />
        Embedding
      </h3>
      <div className="space-y-1.5 text-sm">
        <StatRow label="Provider" value={stats.embedding.provider} />
        <StatRow label="Model" value={stats.embedding.model} />
        <StatRow label="Embedded" value={`${stats.embedding.embedded_count} / ${stats.embedding.total_embeddable}`} />
        <StatRow label="Queue" value={String(stats.embedding.queue_depth)} />
      </div>
    </Surface>
  );
}
