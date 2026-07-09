/**
 * Read-only OKF readiness section for the Symbionts page. Renders project
 * OKF state (enabled/disabled, bundle path, validation, AGENTS pointer) and
 * per-symbiont tool readiness (MCP tools vs CLI fallback). This is the ONLY
 * place project-level OKF state is shown outside the OKF page itself — the
 * SymbiontRow capability chip is symbiont-derived only (see capability-map.ts).
 *
 * Deliberately excludes: Validate/Copy-path actions, output-path editing,
 * and publish acknowledgement — those are OKF-page-only actions; this panel
 * links to /okf for anything actionable.
 */

import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import { useOkfStatusForSelection } from '../../hooks/use-okf';
import type { SymbiontInfo } from '../../hooks/use-symbionts';

function enabledTone(enabled: boolean): { label: string; tone: StatusTone } {
  return enabled ? { label: 'Enabled', tone: 'sage' } : { label: 'Disabled', tone: 'outline' };
}

function validationTone(status: { validation: { ok: boolean } | null }): { label: string; tone: StatusTone } {
  if (!status.validation) return { label: 'Not validated', tone: 'outline' };
  return status.validation.ok ? { label: 'Valid', tone: 'sage' } : { label: 'Invalid', tone: 'terracotta' };
}

function pointerTone(present: boolean, stale: boolean): { label: string; tone: StatusTone } {
  if (!present) return { label: 'Missing', tone: 'outline' };
  if (stale) return { label: 'Stale', tone: 'ochre' };
  return { label: 'Present', tone: 'sage' };
}

export interface OkfReadinessPanelProps {
  symbionts: SymbiontInfo[];
}

export function OkfReadinessPanel({ symbionts }: OkfReadinessPanelProps) {
  const selection = useActiveProjectSelection();
  const { data: status, isLoading } = useOkfStatusForSelection(selection);

  if (!selection) {
    return (
      <div className="space-y-2">
        <SectionHeader>OKF readiness</SectionHeader>
        <Surface className="px-4 py-6 text-sm text-on-surface-variant" data-testid="okf-readiness-unavailable">
          Select a project from the switcher to see OKF readiness.
        </Surface>
      </div>
    );
  }

  if (isLoading || !status) {
    return (
      <div className="space-y-2">
        <SectionHeader>OKF readiness</SectionHeader>
        <Surface className="px-4 py-6 text-sm text-on-surface-variant">Loading OKF status…</Surface>
      </div>
    );
  }

  const enabled = enabledTone(status.enabled);
  const validation = validationTone(status);
  const pointer = pointerTone(status.agentsPointer.present, status.agentsPointer.stale);

  return (
    <div className="space-y-2">
      <SectionHeader>OKF readiness</SectionHeader>
      <Surface className="px-4 py-3" data-testid="okf-readiness-panel">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface">OKF</span>
            <div className="flex items-center gap-1.5">
              <StatusDot tone={enabled.tone} />
              <span className="font-mono text-xs text-on-surface-variant">{enabled.label}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface">Bundle path</span>
            <span className="font-mono text-xs text-on-surface-variant">{status.outputPath}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface">Validation</span>
            <div className="flex items-center gap-1.5">
              <StatusDot tone={validation.tone} />
              <span className="font-mono text-xs text-on-surface-variant">{validation.label}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface">AGENTS.md pointer</span>
            <div className="flex items-center gap-1.5">
              <StatusDot tone={pointer.tone} />
              <span className="font-mono text-xs text-on-surface-variant">{pointer.label}</span>
            </div>
          </div>
        </div>

        <div className="mt-3 border-t border-outline-variant/15 pt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant mb-2">
            Per-symbiont readiness
          </div>
          <div className="flex flex-col divide-y divide-outline-variant/15">
            {symbionts.map((s) => {
              const ready = s.supportsMcp;
              return (
                <div key={s.name} className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-on-surface">{s.displayName}</span>
                  <span className="font-mono text-xs text-on-surface-variant">
                    {ready ? 'OKF tools' : 'CLI fallback'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 border-t border-outline-variant/15 pt-3">
          <Link to="/okf" className="text-xs text-primary hover:underline">
            Manage OKF →
          </Link>
        </div>
      </Surface>
    </div>
  );
}
