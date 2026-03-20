import { useState, useCallback } from 'react';
import {
  RefreshCw,
  Sparkles,
  RotateCcw,
  FolderOpen,
  ExternalLink,
  Activity,
  Database,
  Brain,
  HardDrive,
  Search,
  Timer,
} from 'lucide-react';
import { useDaemon, type StatsResponse } from '../hooks/use-daemon';
import { totalSpores } from '../lib/vault';
import { MycoTopology } from '../components/topology/MycoTopology';
import { postJson } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
const ACTION_FEEDBACK_DURATION_MS = 2_000;
const TOP_SPORE_TYPES_LIMIT = 6;
const DROPDOWN_CLOSE_DELAY_MS = 150;

/* ---------- Helpers ---------- */

function formatUptime(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${Math.floor(seconds)}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < SECONDS_PER_DAY) {
    const h = Math.floor(seconds / SECONDS_PER_HOUR);
    const m = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / SECONDS_PER_DAY);
  const h = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  return `${d}d ${h}h`;
}

function formatTimeAgo(timestamp: string): string {
  const diff = (Date.now() - new Date(timestamp).getTime()) / 1_000;
  if (diff < SECONDS_PER_MINUTE) return 'just now';
  if (diff < SECONDS_PER_HOUR) return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  if (diff < SECONDS_PER_DAY) return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
}

function topSporeTypes(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SPORE_TYPES_LIMIT);
}

function obsidianUri(name: string): string {
  return `obsidian://open?vault=${encodeURIComponent(name)}`;
}

function vscodeUri(path: string): string {
  return `vscode://file${path}`;
}

function finderUri(path: string): string {
  return `file://${path}`;
}

/* ---------- Action button hook ---------- */

type ActionState = 'idle' | 'loading' | 'success' | 'error';

function useAction(fn: () => Promise<unknown>) {
  const [state, setState] = useState<ActionState>('idle');

  const execute = useCallback(async () => {
    setState('loading');
    try {
      await fn();
      setState('success');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), ACTION_FEEDBACK_DURATION_MS);
  }, [fn]);

  return { state, execute };
}

/* ---------- Quick Actions ---------- */

function QuickActions({ stats }: { stats: StatsResponse }) {
  const runDigest = useAction(
    useCallback(() => postJson('/digest', {}), []),
  );
  const runCuration = useAction(
    useCallback(() => postJson('/curate', { dry_run: true }), []),
  );
  const restartDaemon = useAction(
    useCallback(() => postJson('/restart', {}), []),
  );

  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton
        label="Run Digest"
        icon={<Sparkles className="h-4 w-4" />}
        state={runDigest.state}
        onClick={runDigest.execute}
      />
      <ActionButton
        label="Run Curation"
        icon={<RefreshCw className="h-4 w-4" />}
        state={runCuration.state}
        onClick={runCuration.execute}
      />
      <ActionButton
        label="Restart Daemon"
        icon={<RotateCcw className="h-4 w-4" />}
        state={restartDaemon.state}
        onClick={restartDaemon.execute}
      />

      {/* Open Vault dropdown */}
      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setVaultMenuOpen((prev) => !prev)}
          onBlur={() => setTimeout(() => setVaultMenuOpen(false), DROPDOWN_CLOSE_DELAY_MS)}
        >
          <FolderOpen className="h-4 w-4" />
          Open Vault
        </Button>
        {vaultMenuOpen && (
          <div className="absolute top-full left-0 z-10 mt-1 min-w-[140px] rounded-md border border-border bg-card p-1 shadow-md">
            <VaultLink
              label="Obsidian"
              href={obsidianUri(stats.vault.name)}
            />
            <VaultLink
              label="VS Code"
              href={vscodeUri(stats.vault.path)}
            />
            <VaultLink
              label="Finder"
              href={finderUri(stats.vault.path)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function VaultLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {label}
      <ExternalLink className="h-3 w-3 opacity-50" />
    </a>
  );
}

function ActionButton({
  label,
  icon,
  state,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  state: ActionState;
  onClick: () => void;
}) {
  const stateLabel =
    state === 'loading'
      ? 'Running...'
      : state === 'success'
        ? 'Done'
        : state === 'error'
          ? 'Failed'
          : label;

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'gap-2 transition-colors',
        state === 'success' && 'border-primary/50 text-primary',
        state === 'error' && 'border-destructive/50 text-destructive',
      )}
      disabled={state === 'loading'}
      onClick={onClick}
    >
      {state === 'loading' ? (
        <RefreshCw className="h-4 w-4 animate-spin" />
      ) : (
        icon
      )}
      {stateLabel}
    </Button>
  );
}

/* ---------- Stats Cards ---------- */

function DaemonCard({ stats }: { stats: StatsResponse }) {
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

function VaultCard({ stats }: { stats: StatsResponse }) {
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

function SporesCard({ stats }: { stats: StatsResponse }) {
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

function IndexCard({ stats }: { stats: StatsResponse }) {
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

function DigestCard({ stats }: { stats: StatsResponse }) {
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

function IntelligenceCard({ stats }: { stats: StatsResponse }) {
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

/* ---------- Shared primitives ---------- */

function StatRow({
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

function ModelRow({
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

/* ---------- Dashboard ---------- */

export default function Dashboard() {
  const { data: stats, isLoading, isError } = useDaemon();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-6 w-6 animate-spin" />
          <span className="text-sm">Connecting to daemon...</span>
        </div>
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Database className="h-6 w-6 opacity-50" />
          <span className="text-sm">Unable to reach daemon</span>
          <span className="text-xs opacity-60">Check that the daemon is running</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Topology visualization */}
      <Card className="overflow-hidden">
        <CardContent className="p-4">
          <MycoTopology stats={stats} />
        </CardContent>
      </Card>

      {/* Quick actions */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Quick Actions
        </h2>
        <QuickActions stats={stats} />
      </section>

      {/* Stats cards grid */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          System Status
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DaemonCard stats={stats} />
          <VaultCard stats={stats} />
          <SporesCard stats={stats} />
          <IndexCard stats={stats} />
          <DigestCard stats={stats} />
          <IntelligenceCard stats={stats} />
        </div>
      </section>
    </div>
  );
}
