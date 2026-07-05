import { Panel } from '../ui/panel';
import { MetricCard } from '../ui/metric-card';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { formatTimeAgo } from '../../lib/format';
import type { OkfStatusResponse } from '../../hooks/use-okf';

/**
 * Resolve the leading status chip tone + label from the status response.
 * "Failed" (lastResult) takes priority over stale/valid so a broken last
 * run is never masked by an otherwise-fresh bundle.
 */
function describeBundleStatus(status: OkfStatusResponse): { label: string; tone: StatusTone } {
  if (!status.bundleExists) return { label: 'Not generated', tone: 'outline' };
  if (status.lastResult && status.lastResult !== 'published' && status.lastResult !== 'cleanup_pending') {
    return { label: 'Failed', tone: 'terracotta' };
  }
  if (status.stale) return { label: 'Stale', tone: 'ochre' };
  if (status.validation && !status.validation.ok) return { label: 'Invalid', tone: 'terracotta' };
  return { label: 'Valid', tone: 'sage' };
}

export interface OkfStatusPanelProps {
  status: OkfStatusResponse;
}

export function OkfStatusPanel({ status }: OkfStatusPanelProps) {
  const chip = describeBundleStatus(status);

  return (
    <Panel
      eyebrow="Bundle"
      title="Status"
      actions={
        <div className="flex items-center gap-1.5" data-testid="okf-status-chip">
          <StatusDot tone={chip.tone} />
          <span className="font-mono text-xs text-on-surface-variant">{chip.label}</span>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label="Generated at"
          value={status.generatedAt ? formatTimeAgo(status.generatedAt) : 'Never'}
        />
        <MetricCard
          label="Concepts"
          value={status.conceptCount ?? '—'}
        />
        <MetricCard
          label="Generation"
          value={status.bundleGeneration ?? '—'}
        />
        <MetricCard
          label="Output path"
          value={status.outputPath}
          mono
        />
      </div>
    </Panel>
  );
}
