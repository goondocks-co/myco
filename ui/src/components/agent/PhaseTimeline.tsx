import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { formatTokens, formatCost, statusBadgeVariant } from './helpers';

/** Lines of summary text before we clamp and show expand toggle. */
const SUMMARY_CLAMP_LINES = 2;

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

/* ---------- Component ---------- */

function PhaseSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200 || text.includes('\n');

  return (
    <div className="mt-1">
      <div className={!expanded && isLong ? `line-clamp-${SUMMARY_CLAMP_LINES}` : undefined}>
        <MarkdownContent content={text} className="text-on-surface-variant [&>*]:text-on-surface-variant" />
      </div>
      {isLong && (
        <button
          className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors mt-1"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? <><ChevronDown className="h-3 w-3" /> Show less</>
            : <><ChevronRight className="h-3 w-3" /> Show more</>}
        </button>
      )}
    </div>
  );
}

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
            {phase.summary && <PhaseSummary text={phase.summary} />}
          </Surface>
        </div>
      ))}
    </div>
  );
}
