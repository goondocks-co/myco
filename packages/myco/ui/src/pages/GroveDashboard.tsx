import { useEffect, useState } from 'react';
import { Cpu, Database, HardDrive, Wrench, Settings as SettingsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEmbeddingDetails } from '../hooks/use-embedding-details';
import { useDatabaseDetails } from '../hooks/use-database-details';
import { useProjectSelection } from '../hooks/use-project-selection';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { fetchJson } from '../lib/api';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { StatCard } from '../components/ui/stat-card';
import { formatBytes } from '../lib/format';
import { cn } from '../lib/cn';

interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}
interface BackupListResponse {
  backups: BackupMeta[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const SECONDS_PER_HOUR = 3600;

/* ---------- Helpers ---------- */

function statusDot(state: string): string {
  if (state === 'healthy' || state === 'idle') return 'bg-primary';
  if (state === 'pending') return 'bg-secondary';
  return 'bg-tertiary';
}

/* ---------- Cards ---------- */

function EmbeddingCard({ groveMaintenancePath }: { groveMaintenancePath: string }) {
  const { data, isLoading } = useEmbeddingDetails('grove');

  if (isLoading || !data) {
    return (
      <Surface level="low" className="rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <SectionHeader>Embedding</SectionHeader>
        </div>
        <p className="font-sans text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    );
  }

  const totalPending = Object.values(data.pending).reduce((a, b) => a + b, 0);
  const totalStale = Object.values(data.by_namespace).reduce((a, ns) => a + ns.stale, 0);
  const status = totalPending > 0 ? 'pending' : 'idle';

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <SectionHeader>Embedding</SectionHeader>
        </div>
        <Link
          to={`${groveMaintenancePath}?tab=embedding`}
          className="font-sans text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          <Wrench className="h-3 w-3" />
          Manage
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 font-sans text-sm">
        <div className="flex items-center gap-2">
          <span className="text-on-surface-variant">Provider</span>
          <span className="font-mono text-on-surface">{data.provider.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-on-surface-variant">Model</span>
          <span className="font-mono text-xs text-on-surface truncate max-w-[200px]" title={data.provider.model}>
            {data.provider.model}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={cn('h-2 w-2 rounded-full', statusDot(status))} />
          <span className="text-on-surface-variant capitalize">{status}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Vectors" value={String(data.total)} accent="sage" />
        <StatCard label="Pending" value={String(totalPending)} accent={totalPending > 0 ? 'ochre' : 'outline'} />
        <StatCard label="Stale" value={String(totalStale)} accent={totalStale > 0 ? 'terracotta' : 'outline'} />
      </div>
    </Surface>
  );
}

function DatabaseCard({ groveMaintenancePath }: { groveMaintenancePath: string }) {
  const { data, isLoading } = useDatabaseDetails();
  const { effective } = useScopedConfig();

  if (isLoading || !data) {
    return (
      <Surface level="low" className="rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <SectionHeader>Database</SectionHeader>
        </div>
        <p className="font-sans text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    );
  }

  const fragmentation = data.file.fragmentation_pct;
  const fragmentationDisplay = fragmentation.toFixed(1) + '%';
  const fragmentationAccent = fragmentation > 25 ? 'ochre' : 'outline';

  const btreeCount = data.indexes.filter((i) => i.type === 'btree').length;
  const autoCount = data.indexes.filter((i) => i.type === 'auto').length;

  // Scheduled-maintenance summary derived from live config + last-run timestamps.
  const optimizeOn = effective?.maintenance.auto_optimize ?? false;
  const optimizeIntervalH = effective?.maintenance.auto_optimize_interval_hours ?? 24;
  const lastOptimizeAt = data.last_optimize_at;
  const nextOptimizeMs = lastOptimizeAt && optimizeOn
    ? new Date(lastOptimizeAt).getTime() + optimizeIntervalH * SECONDS_PER_HOUR * 1000 - Date.now()
    : null;
  const integrityOn = effective?.maintenance.auto_integrity_check ?? false;
  const lastIntegrity = data.last_integrity_check;

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <SectionHeader>Database</SectionHeader>
        </div>
        <Link
          to={`${groveMaintenancePath}?tab=database`}
          className="font-sans text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          <Wrench className="h-3 w-3" />
          Manage
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Database Size" value={formatBytes(data.file.size_bytes)} accent="sage" />
        <StatCard label="Fragmentation" value={fragmentationDisplay} accent={fragmentationAccent} />
        <StatCard label="WAL Size" value={formatBytes(data.file.wal_size_bytes)} accent="outline" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-sans text-xs">
        <div className="space-y-1">
          <span className="text-on-surface-variant uppercase tracking-wider text-[10px]">Indexes</span>
          <p className="text-on-surface">
            {btreeCount} btree
            {autoCount > 0 && <> · {autoCount} auto</>}
          </p>
        </div>
        <div className="space-y-1">
          <span className="text-on-surface-variant uppercase tracking-wider text-[10px]">Auto-optimize</span>
          <p className="text-on-surface">
            {optimizeOn ? (
              <>
                <span className="text-primary">on</span>, every {optimizeIntervalH}h
                {lastOptimizeAt && <> · last {formatRelative(lastOptimizeAt)}</>}
                {nextOptimizeMs !== null && nextOptimizeMs > 0 && (
                  <> · next in {Math.round(nextOptimizeMs / 3600_000)}h</>
                )}
              </>
            ) : (
              <span className="text-on-surface-variant">off</span>
            )}
          </p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <span className="text-on-surface-variant uppercase tracking-wider text-[10px]">Integrity check</span>
          <p className="text-on-surface">
            {integrityOn ? (
              <>
                <span className="text-primary">on</span>
                {lastIntegrity && (
                  <> · last {formatRelative(lastIntegrity.at)}{' '}
                    <span className={lastIntegrity.status === 'ok' ? 'text-primary' : 'text-tertiary'}>
                      ({lastIntegrity.status})
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="text-on-surface-variant">off</span>
            )}
          </p>
        </div>
      </div>
    </Surface>
  );
}

function BackupSnapshotCard({ groveSettingsPath }: { groveSettingsPath: string }) {
  const [backups, setBackups] = useState<BackupMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<BackupListResponse>('/backups')
      .then((res) => setBackups(res.backups))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load backups'));
  }, []);

  const lastBackup = backups && backups.length > 0 ? backups[0] : null;

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <SectionHeader>Backup</SectionHeader>
        </div>
        <Link
          to={groveSettingsPath}
          className="font-sans text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          <SettingsIcon className="h-3 w-3" />
          Manage
        </Link>
      </div>

      {error ? (
        <p className="font-sans text-sm text-tertiary">{error}</p>
      ) : !backups ? (
        <p className="font-sans text-sm text-on-surface-variant">Loading…</p>
      ) : lastBackup === null ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No backups yet. <Link to={groveSettingsPath} className="text-primary hover:text-primary/80">Run one →</Link>
        </p>
      ) : (
        <div className="space-y-1 font-sans text-sm">
          <p className="text-on-surface">
            Last backup{' '}
            <span className="text-primary">{formatRelative(lastBackup.modified_at)}</span>
            <span className="text-on-surface-variant"> · {formatBytes(lastBackup.size_bytes)}</span>
          </p>
          <p className="text-xs text-on-surface-variant font-mono">
            {lastBackup.file_name}
          </p>
        </div>
      )}
    </Surface>
  );
}

/* ---------- Page ---------- */

export default function GroveDashboard() {
  const selection = useProjectSelection();
  const groveSlug = selection?.grove.slug ?? '';
  const groveMaintenancePath = `/g/${groveSlug}/maintenance`;
  const groveSettingsPath = `/g/${groveSlug}/settings`;

  if (!selection) {
    return (
      <PageLoading isLoading={true} error={null} loadingText="Loading Grove…">
        <span />
      </PageLoading>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title={selection.grove.name}
        subtitle="Grove status — embedding, database, and backups."
      />

      <EmbeddingCard groveMaintenancePath={groveMaintenancePath} />
      <DatabaseCard groveMaintenancePath={groveMaintenancePath} />
      <BackupSnapshotCard groveSettingsPath={groveSettingsPath} />
    </div>
  );
}
