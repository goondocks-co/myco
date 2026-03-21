import { Activity, Brain, HardDrive, Search, Sparkles, Timer } from 'lucide-react';
import { type StatsResponse } from '../../hooks/use-daemon';
import { totalSpores } from '../../lib/vault';
import { formatUptime, formatTimeAgo } from '../../lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';

/* ---------- Constants ---------- */

const TOP_SPORE_TYPES_LIMIT = 6;

/* ---------- Helpers ---------- */

export function topSporeTypes(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SPORE_TYPES_LIMIT);
}

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

export function ModelRow({
  label,
  info,
}: {
  label: string;
  info: { provider: string; model: string } | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      {info ? (
        <span className="truncate font-mono text-xs text-foreground" title={`${info.provider}/${info.model}`}>
          {info.model}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/60">none</span>
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
        <StatRow label="Spores" value={String(totalSpores(stats.vault.spore_counts))} />
        <StatRow label="Plans" value={String(stats.vault.plan_count)} />
        <StatRow label="Name" value={stats.vault.name} />
      </CardContent>
    </Card>
  );
}

export function SporesCard({ stats }: { stats: StatsResponse }) {
  const types = topSporeTypes(stats.vault.spore_counts);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          Spores by Type
        </CardTitle>
      </CardHeader>
      <CardContent>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spores yet</p>
        ) : (
          <div className="space-y-1.5">
            {types.map(([type, count]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{type}</span>
                <Badge variant="secondary" className="text-xs font-mono">
                  {count}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function IndexCard({ stats }: { stats: StatsResponse }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Search className="h-4 w-4 text-primary" />
          Index
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <StatRow label="FTS entries" value={String(stats.index.fts_entries)} />
        <StatRow label="Vectors" value={String(stats.index.vector_count)} />
      </CardContent>
    </Card>
  );
}

export function DigestCard({ stats }: { stats: StatsResponse }) {
  const digest = stats.digest;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Timer className="h-4 w-4 text-primary" />
          Digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!digest ? (
          <p className="text-muted-foreground">Disabled</p>
        ) : (
          <>
            <StatRow
              label="Metabolism"
              value={digest.metabolism_state ?? 'dormant'}
              badge
              badgeVariant={
                digest.metabolism_state === 'active'
                  ? 'default'
                  : 'secondary'
              }
            />
            <StatRow label="Queue" value={String(digest.substrate_queue)} />
            {digest.last_cycle ? (
              <>
                <StatRow
                  label="Last cycle"
                  value={formatTimeAgo(digest.last_cycle.timestamp)}
                />
                <StatRow label="Tier" value={`T${digest.last_cycle.tier}`} />
                <StatRow
                  label="Substrate"
                  value={String(digest.last_cycle.substrate_count)}
                />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No cycles yet</p>
            )}
          </>
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
          Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ModelRow label="Processor" info={stats.intelligence.processor} />
        <ModelRow label="Digest" info={stats.intelligence.digest} />
        <ModelRow label="Embedding" info={stats.intelligence.embedding} />
      </CardContent>
    </Card>
  );
}
