import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime } from '../../lib/format';
import { Surface } from '../ui/surface';
import { Sparkline } from '../ui/sparkline';

/* ---------- Constants ---------- */

/** Placeholder sparkline data — replaced with real data once telemetry is wired. */
const PLACEHOLDER_SPARKLINE = [1, 2, 3, 4, 3, 5, 4, 6, 5, 7];

/* ---------- Sub-components ---------- */

interface StatCardProps {
  label: string;
  value: string;
  sparkData?: number[];
}

function StatCard({ label, value, sparkData }: StatCardProps) {
  return (
    <Surface level="low" className="flex flex-col gap-2 p-4">
      <span className="font-sans text-xs font-medium uppercase tracking-wide text-on-surface-variant">
        {label}
      </span>
      <span className="font-mono text-2xl text-on-surface">
        {value}
      </span>
      {sparkData && sparkData.length >= 2 && (
        <Sparkline data={sparkData} height={32} className="w-full" />
      )}
    </Surface>
  );
}

/* ---------- Component ---------- */

export function StatCards({ stats }: { stats: StatsResponse }) {
  const activeSessions = stats.daemon.active_sessions.length;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Active Sessions"
        value={String(activeSessions)}
        sparkData={PLACEHOLDER_SPARKLINE}
      />
      <StatCard
        label="Total Spores"
        value={String(stats.vault.spore_count)}
        sparkData={PLACEHOLDER_SPARKLINE}
      />
      <StatCard
        label="Daemon Uptime"
        value={formatUptime(stats.daemon.uptime_seconds)}
      />
      <StatCard
        label="Embedded"
        value={`${stats.embedding.embedded_count}/${stats.embedding.total_embeddable}`}
        sparkData={PLACEHOLDER_SPARKLINE}
      />
    </div>
  );
}
