import { Cpu, Database, HardDrive, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEmbeddingDetails } from '../hooks/use-embedding-details';
import { useDatabaseDetails } from '../hooks/use-database-details';
import { useProjectSelection } from '../hooks/use-project-selection';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { StatCard } from '../components/ui/stat-card';
import { formatBytes } from '../lib/format';
import { cn } from '../lib/cn';

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
    </Surface>
  );
}

/* ---------- Page ---------- */

export default function GroveDashboard() {
  const selection = useProjectSelection();
  const groveSlug = selection?.grove.slug ?? '';
  const groveMaintenancePath = `/g/${groveSlug}/maintenance`;

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
    </div>
  );
}
