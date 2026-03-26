import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { formatTokens, formatCost } from './helpers';

/* ---------- Types ---------- */

export interface PhaseResult {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  turnsUsed: number;
  tokensUsed: number;
  costUsd: number;
  summary: string;
}

export interface PhaseTimelineProps {
  phases: PhaseResult[];
}

/* ---------- Helpers ---------- */

/** Map phase status to Badge variant. */
function statusBadgeVariant(status: string): 'default' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'failed':    return 'destructive';
    default:          return 'secondary';
  }
}

/* ---------- Component ---------- */

export function PhaseTimeline({ phases }: PhaseTimelineProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-sans text-sm font-medium text-on-surface">Phase Execution</h3>
      {phases.map((phase, i) => (
        <div key={phase.name} className="flex items-start gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container-high font-mono text-sm font-medium text-on-surface-variant shrink-0">
            {i + 1}
          </div>
          <Surface level="default" className="flex-1 p-3">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="font-sans text-sm font-medium text-on-surface">{phase.name}</span>
                <Badge variant={statusBadgeVariant(phase.status)}>
                  {phase.status}
                </Badge>
              </div>
              <div className="flex gap-3 font-mono text-xs text-on-surface-variant">
                <span>{phase.turnsUsed} turns</span>
                <span>{formatTokens(phase.tokensUsed)}</span>
                <span>{formatCost(phase.costUsd)}</span>
              </div>
            </div>
            {phase.summary && (
              <p className="font-sans text-sm text-on-surface-variant mt-1 line-clamp-2">{phase.summary}</p>
            )}
          </Surface>
        </div>
      ))}
    </div>
  );
}
