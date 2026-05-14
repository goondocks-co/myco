import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useAgentTurns, useAgentRunAudit } from '../../hooks/use-agent';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { cn } from '../../lib/cn';
import { tryParseJson } from '@myco/utils/json';
import type { PhaseAuditEntry, TurnRow } from '../../hooks/use-agent';
import { formatCost, formatTokens } from './helpers';

/* ---------- Props ---------- */

export interface AuditTrailProps {
  runId: string;
  runStatus?: string;
  className?: string;
}

/* ---------- Helpers ---------- */

const MS_PER_SECOND = 1_000;
const TURN_PREVIEW_CHARS = 80;

function phaseStatusVariant(status: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'failed':    return 'destructive';
    case 'skipped':   return 'secondary';
    default:          return 'warning';
  }
}

function truncatePreview(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}

/* ---------- Phase summary card ---------- */

function PhaseCard({ entry }: { entry: PhaseAuditEntry }) {
  const [open, setOpen] = useState(false);
  const toolBadges = Object.entries(entry.toolCalls);
  const writeIntentBadges = entry.writeIntents ? Object.entries(entry.writeIntents.byTool) : [];

  return (
    <Surface level="low" className="overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-container-high/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 mt-1 shrink-0 text-on-surface-variant" />
          : <ChevronRight className="h-3.5 w-3.5 mt-1 shrink-0 text-on-surface-variant" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-sans text-sm font-medium text-on-surface">{entry.phaseName}</span>
            <Badge variant={phaseStatusVariant(entry.status)}>{entry.status}</Badge>
            <span className="font-mono text-xs text-on-surface-variant">
              {entry.turnsUsed} turn{entry.turnsUsed === 1 ? '' : 's'}
              {entry.maxTurns ? ` / ${entry.maxTurns}` : ''}
            </span>
            <span className="font-mono text-xs text-on-surface-variant">
              {formatTokens(entry.tokensUsed)} tok
            </span>
            <span className="font-mono text-xs text-on-surface-variant">
              {formatCost(entry.costUsd, (entry.costSource ?? null) as 'actual' | 'estimated' | 'unavailable' | null)}
            </span>
            {entry.durationMs !== null && (
              <span className="font-mono text-xs text-on-surface-variant">
                {(entry.durationMs / MS_PER_SECOND).toFixed(1)}s
              </span>
            )}
          </div>
          {entry.skipReason && (
            <p className="font-sans text-xs text-secondary mt-1">Skipped: {entry.skipReason}</p>
          )}
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-outline-variant/20 px-4 py-3">
          {toolBadges.length > 0 && (
            <div>
              <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Tool calls
              </p>
              <div className="flex flex-wrap gap-1.5">
                {toolBadges.map(([tool, count]) => (
                  <Badge key={tool} variant="secondary" className="font-mono">
                    {tool} × {count}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {entry.writeIntents && (
            <div>
              <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Write intents ({entry.writeIntents.total})
              </p>
              {writeIntentBadges.length === 0 ? (
                <span className="font-sans text-xs text-on-surface-variant">None attributed to this phase.</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {writeIntentBadges.map(([tool, count]) => (
                    <Badge key={tool} variant="warning" className="font-mono">
                      {tool} × {count}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
          {entry.summary && (
            <div>
              <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Summary
              </p>
              <p className="font-sans text-xs text-on-surface whitespace-pre-wrap">{entry.summary}</p>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

/* ---------- Per-turn row ---------- */

function TurnItem({ turn }: { turn: TurnRow }) {
  const [expanded, setExpanded] = useState(false);

  const parsedInput: unknown = turn.tool_input
    ? tryParseJson(turn.tool_input) ?? turn.tool_input
    : null;

  const inputPreview = turn.tool_input
    ? truncatePreview(turn.tool_input, TURN_PREVIEW_CHARS)
    : '—';
  const hasExpandableInput = turn.tool_input !== null && turn.tool_input.length > TURN_PREVIEW_CHARS;

  return (
    <div
      role="button"
      tabIndex={0}
      className="px-4 py-2.5 hover:bg-surface-container-high/30 transition-colors border-b border-outline-variant/10 last:border-b-0 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(!expanded);
        }
      }}
      aria-expanded={expanded}
    >
      <div className="flex items-start gap-3">
        <span className="font-mono text-xs text-on-surface-variant w-5 shrink-0 pt-0.5 text-right">
          {turn.turn_number}
        </span>
        <span className="font-mono text-xs font-medium text-on-surface shrink-0 pt-0.5 min-w-[140px]">
          {turn.tool_name}
        </span>
        <div className="flex-1 min-w-0">
          {hasExpandableInput ? (
            <div className="flex items-start gap-1 font-mono text-xs text-on-surface-variant w-full">
              {expanded
                ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" />
                : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />}
              <span className={expanded ? undefined : 'truncate'}>{inputPreview}</span>
            </div>
          ) : (
            <span className="font-mono text-xs text-on-surface-variant truncate block">
              {inputPreview}
            </span>
          )}

          {expanded && parsedInput !== null && (
            <pre className="mt-1.5 ml-4 rounded-md bg-surface-container-lowest p-2.5 font-mono text-xs overflow-auto max-h-48 text-on-surface-variant">
              {typeof parsedInput === 'string'
                ? parsedInput
                : JSON.stringify(parsedInput, null, 2)}
            </pre>
          )}

          {expanded && turn.tool_output_summary && (
            <div className="mt-1.5 ml-4">
              <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant mb-1">
                Output
              </p>
              <p className="font-sans text-xs text-on-surface whitespace-pre-wrap">
                {turn.tool_output_summary}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- AuditTrail ---------- */

/**
 * Unified audit view for a run. Fetches phase summaries (from the audit
 * endpoint) and per-turn tool call details (from the turns endpoint) and
 * renders them together: collapsible phase summary cards followed by a
 * flat turn-by-turn trace.
 *
 * Both queries are fetched on mount — the caller controls whether to mount
 * this component at all. Note: agent_turns has no phase column, so turns
 * are listed in chronological order rather than grouped per-phase.
 */
export function AuditTrail({ runId, runStatus, className }: AuditTrailProps) {
  const auditQuery = useAgentRunAudit(runId);
  const turnsQuery = useAgentTurns(runId, runStatus);

  const phases = auditQuery.data?.audit.phases ?? [];
  const turns: TurnRow[] = turnsQuery.data ?? [];
  const isLoading = auditQuery.isPending || turnsQuery.isPending;

  const isEmpty = !isLoading && phases.length === 0 && turns.length === 0;

  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2 text-on-surface-variant py-4', className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-sans text-sm">Loading audit trail...</span>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <Surface level="low" className={cn('flex h-20 items-center justify-center', className)}>
        <span className="font-sans text-sm text-on-surface-variant italic">
          This run had no recorded tool calls.
        </span>
      </Surface>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Phase summaries */}
      {phases.length > 0 && (
        <div className="space-y-2">
          <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
            Phases
          </p>
          {phases.map((entry) => (
            <PhaseCard key={entry.phaseName} entry={entry} />
          ))}
        </div>
      )}

      {/* Turn-by-turn trace */}
      {turns.length > 0 && (
        <div className="space-y-2">
          <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
            Turn trace ({turns.length})
          </p>
          <Surface level="low" className="overflow-hidden">
            {turns.map((turn) => (
              <TurnItem key={turn.id} turn={turn} />
            ))}
          </Surface>
        </div>
      )}
    </div>
  );
}
