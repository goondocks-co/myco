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

/* ---------- Constants ---------- */

/** Tailwind class map for phase status badge coloring. */
const PHASE_STATUS_CLASSES: Record<string, string> = {
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  skipped: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

/* ---------- Component ---------- */

export function PhaseTimeline({ phases }: PhaseTimelineProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium text-sm">Phase Execution</h3>
      {phases.map((phase, i) => (
        <div key={phase.name} className="flex items-start gap-3">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${PHASE_STATUS_CLASSES[phase.status] ?? PHASE_STATUS_CLASSES['skipped']}`}
          >
            {i + 1}
          </div>
          <div className="flex-1 p-3 rounded-lg border text-sm">
            <div className="flex justify-between items-center">
              <span className="font-medium">{phase.name}</span>
              <div className="flex gap-3 text-muted-foreground">
                <span>{phase.turnsUsed} turns</span>
                <span>{formatTokens(phase.tokensUsed)}</span>
                <span>{formatCost(phase.costUsd)}</span>
              </div>
            </div>
            {phase.summary && (
              <p className="text-muted-foreground mt-1 line-clamp-2">{phase.summary}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
