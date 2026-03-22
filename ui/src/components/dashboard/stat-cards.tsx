import { Activity, Brain, HardDrive, Timer } from 'lucide-react';
import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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
      <span className="text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant={badgeVariant ?? 'secondary'} className="text-xs">
          {value}
        </Badge>
      ) : (
        <span className="font-mono text-foreground">{value}</span>
      )}
    </div>
  );
}

/* ---------- Stat Cards ---------- */

export function DaemonCard({ stats }: { stats: StatsResponse }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-primary" />
          Daemon
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <StatRow label="Uptime" value={formatUptime(stats.daemon.uptime_seconds)} />
        <StatRow label="Version" value={`v${stats.daemon.version}`} />
        <StatRow label="Port" value={String(stats.daemon.port)} />
        <StatRow label="PID" value={String(stats.daemon.pid)} />
      </CardContent>
    </Card>
  );
}

export function VaultCard({ stats }: { stats: StatsResponse }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <HardDrive className="h-4 w-4 text-primary" />
          Vault
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <StatRow label="Sessions" value={String(stats.vault.session_count)} />
        <StatRow label="Spores" value={String(stats.vault.spore_count)} />
        <StatRow label="Plans" value={String(stats.vault.plan_count)} />
        <StatRow label="Artifacts" value={String(stats.vault.artifact_count)} />
        <StatRow label="Entities" value={String(stats.vault.entity_count)} />
        <StatRow label="Name" value={stats.vault.name} />
      </CardContent>
    </Card>
  );
}

export function DigestCard({ stats }: { stats: StatsResponse }) {
  const { digest } = stats;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Timer className="h-4 w-4 text-primary" />
          Digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <StatRow label="Tiers available" value={String(digest.tiers_available.length)} />
        {digest.freshest_tier !== null ? (
          <StatRow label="Freshest tier" value={`T${digest.freshest_tier}`} />
        ) : (
          <p className="text-xs text-muted-foreground">No tiers yet</p>
        )}
        {digest.generated_at !== null && (
          <StatRow label="Generated" value={formatEpochAgo(digest.generated_at)} />
        )}
      </CardContent>
    </Card>
  );
}

export function IntelligenceCard({ stats }: { stats: StatsResponse }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="h-4 w-4 text-primary" />
          Embedding
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <StatRow label="Provider" value={stats.embedding.provider} />
        <StatRow label="Model" value={stats.embedding.model} />
        <StatRow label="Embedded" value={`${stats.embedding.embedded_count} / ${stats.embedding.total_embeddable}`} />
        <StatRow label="Queue" value={String(stats.embedding.queue_depth)} />
      </CardContent>
    </Card>
  );
}
