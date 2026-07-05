import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import type { OkfStatusResponse } from '../../hooks/use-okf';

function pointerStatus(status: OkfStatusResponse): { label: string; tone: StatusTone } {
  if (!status.agentsPointer.present) return { label: 'Missing', tone: 'outline' };
  if (status.agentsPointer.stale) return { label: 'Stale', tone: 'ochre' };
  return { label: 'Present', tone: 'sage' };
}

export interface OkfDiscoveryPanelProps {
  status: OkfStatusResponse;
}

export function OkfDiscoveryPanel({ status }: OkfDiscoveryPanelProps) {
  const pointer = pointerStatus(status);

  return (
    <Panel eyebrow="Agent discovery" title="Discovery">
      <div className="flex items-center justify-between py-1">
        <span className="text-sm text-on-surface">AGENTS.md pointer</span>
        <div className="flex items-center gap-1.5">
          <StatusDot tone={pointer.tone} />
          <span className="font-mono text-xs text-on-surface-variant">{pointer.label}</span>
        </div>
      </div>
      <p className="mt-2 text-xs text-on-surface-variant">
        Coding agents discover the OKF bundle through a managed pointer block in AGENTS.md.
        Per-symbiont readiness (which agents can use OKF tools vs. read the markdown directly)
        lives on the{' '}
        <Link to="/symbionts" className="text-primary hover:underline">
          Symbionts
        </Link>{' '}
        page.
      </p>
    </Panel>
  );
}
