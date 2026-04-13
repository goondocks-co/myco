import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { Surface } from '../ui/surface';

/* ---------- Sub-components ---------- */

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="font-sans text-xs font-medium text-on-surface-variant">{label}</span>
      <span className="font-mono text-xs text-on-surface">{value}</span>
    </div>
  );
}

/* ---------- Component ---------- */

export function SystemStatus({ stats }: { stats: StatsResponse }) {
  return (
    <Surface level="low" className="p-4 space-y-1">
      <h3 className="font-serif text-sm text-on-surface mb-2">System Status</h3>
      <StatusRow label="Daemon uptime" value={formatUptime(stats.daemon.uptime_seconds)} />
      <StatusRow label="Version" value={`v${stats.daemon.version}`} />
      <StatusRow
        label="Last digest"
        value={stats.digest.generated_at ? formatEpochAgo(stats.digest.generated_at) : 'None'}
      />
      <StatusRow label="Digest tiers" value={String(stats.digest.tiers_available.length)} />
      <StatusRow label="FTS indexed" value={String(stats.vault.session_count + stats.vault.spore_count)} />
      <StatusRow
        label="Vectors"
        value={`${stats.embedding.embedded_count}/${stats.embedding.total_embeddable}`}
      />
      <StatusRow label="Queue depth" value={String(stats.embedding.queue_depth)} />
      <StatusRow label="Unprocessed" value={String(stats.unprocessed_batches)} />
    </Surface>
  );
}
