import { Cpu, Server } from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import { PageHeader } from '../components/ui/page-header';
import { PageContainer } from '../components/ui/page-container';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { GrovesOverviewCard } from '../components/operations/GrovesOverviewCard';
import { ProjectsActivityCard } from '../components/operations/ProjectsActivityCard';
import { cn } from '../lib/cn';

/* ---------- Helpers ---------- */

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* ---------- Cards ---------- */

function DaemonStatsCard() {
  const { data: stats } = useDaemon();
  if (!stats) {
    return (
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <SectionHeader>Daemon</SectionHeader>
        </div>
        <p className="font-sans text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    );
  }
  const { pid, port, version, uptime_seconds, active_sessions } = stats.daemon;
  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <SectionHeader>Daemon</SectionHeader>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Stat label="PID" value={String(pid)} mono />
        <Stat label="Running port" value={String(port)} mono />
        <Stat label="Version" value={version} mono />
        <Stat label="Uptime" value={formatUptime(uptime_seconds)} />
        <Stat label="Active sessions" value={String(active_sessions.length)} />
      </dl>
    </Surface>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-sans text-[11px] uppercase tracking-wider text-on-surface-variant">
        {label}
      </dt>
      <dd className={cn('mt-0.5 text-sm text-on-surface', mono && 'font-mono')}>
        {value}
      </dd>
    </div>
  );
}

/* ---------- Page ---------- */

export default function MachineDashboard() {
  return (
    <PageContainer>
      <div className="flex items-center gap-3">
        <Cpu className="h-5 w-5 text-primary" />
        <PageHeader
          title="Machine"
          subtitle="Status of the Myco daemon and every Grove on this machine."
          className="flex-1 pb-0"
        />
      </div>

      <DaemonStatsCard />
      <GrovesOverviewCard />
      <ProjectsActivityCard />
    </PageContainer>
  );
}
