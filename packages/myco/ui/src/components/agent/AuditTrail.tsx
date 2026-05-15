import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useAgentTurns, useAgentRunAudit } from '../../hooks/use-agent';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { cn } from '../../lib/cn';
import { tryParseJson } from '../../lib/json';
import type { PhaseAuditEntry, TurnRow } from '../../hooks/use-agent';
import { formatCost, formatTokens } from './helpers';
import { MS_PER_SECOND } from '../../lib/constants';

/* ---------- Props ---------- */

export interface AuditTrailProps {
  runId: string;
  runStatus?: string;
  className?: string;
}

/* ---------- Helpers ---------- */

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
        aria-expanded={open}
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
            <pre className="mt-1.5 ml-4 rounded-md bg-surface-container-lowest p-2.5 font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-48 text-on-surface-variant">
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

/* ---------- Phase grouping ---------- */

/**
 * Sort phases by their best-available start signal. `startedAt` is null in
 * the current audit view for multi-phase runs (the checkpoint persists only
 * `updatedAt`), so we fall back to `completedAt` and finally to insertion
 * order to keep the render deterministic.
 */
function sortPhases(phases: PhaseAuditEntry[]): PhaseAuditEntry[] {
  return phases.slice().sort((a, b) => {
    const aKey = a.startedAt ?? a.completedAt ?? Number.MAX_SAFE_INTEGER;
    const bKey = b.startedAt ?? b.completedAt ?? Number.MAX_SAFE_INTEGER;
    return aKey - bKey;
  });
}

/**
 * Group turns under the phase that contains their `started_at` timestamp.
 *
 * Phase boundaries are derived from `completedAt` values (since `startedAt`
 * is always null for phased runs). The interval for phase N is
 * (prev.completedAt, N.completedAt]; the first phase covers everything up
 * to its own completedAt. Turns that fall outside every interval — or
 * runs whose phases have no completedAt at all — land in the trailing
 * `_unphased` bucket.
 */
function groupTurnsByPhase(
  turns: TurnRow[],
  sortedPhases: PhaseAuditEntry[],
): { phaseName: string; turns: TurnRow[] }[] {
  const buckets = new Map<string, TurnRow[]>();
  for (const phase of sortedPhases) buckets.set(phase.phaseName, []);
  buckets.set('_unphased', []);

  for (const turn of turns) {
    const t = turn.started_at;
    let assigned: string | null = null;
    if (t !== null) {
      // First phase has no predecessor; open lower bound matches any turn before this phase ended.
      let lower = -Infinity;
      for (const phase of sortedPhases) {
        const upper = phase.completedAt ?? Infinity;
        if (t > lower && t <= upper) {
          assigned = phase.phaseName;
          break;
        }
        if (phase.completedAt !== null) lower = phase.completedAt;
      }
    }
    if (assigned === null) {
      buckets.get('_unphased')!.push(turn);
    } else {
      buckets.get(assigned)!.push(turn);
    }
  }

  // Sort each bucket by turn_number ASC for deterministic order
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.turn_number - b.turn_number);
  }

  const result: { phaseName: string; turns: TurnRow[] }[] = [];
  for (const phase of sortedPhases) {
    result.push({ phaseName: phase.phaseName, turns: buckets.get(phase.phaseName)! });
  }
  const unphased = buckets.get('_unphased')!;
  if (unphased.length > 0) {
    result.push({ phaseName: '_unphased', turns: unphased });
  }
  return result;
}

/* ---------- AuditTrail ---------- */

/**
 * Unified audit view for a run. Fetches phase summaries (from the audit
 * endpoint) and per-turn tool call details (from the turns endpoint) and
 * renders them as a phase-grouped trail: each phase header card is followed
 * inline by the turns whose `started_at` falls within that phase's
 * timestamp range. Turns that don't map to any phase land in a trailing
 * "misc" bucket.
 *
 * Both queries are fetched on mount — the caller controls whether to mount
 * this component at all.
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

  const sortedPhases = sortPhases(phases);
  const groups = groupTurnsByPhase(turns, sortedPhases);
  const phaseLookup = new Map(sortedPhases.map((p) => [p.phaseName, p]));

  return (
    <div className={cn('space-y-3', className)}>
      <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
        Audit Trail
      </p>
      {groups.map((group) => {
        const phase = phaseLookup.get(group.phaseName);
        return (
          <div key={group.phaseName} className="space-y-1.5">
            {phase ? (
              <PhaseCard entry={phase} />
            ) : (
              <div className="px-4 py-2 rounded-md bg-surface-container/30">
                <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                  misc ({group.turns.length})
                </span>
              </div>
            )}
            {group.turns.length > 0 && (
              <Surface level="low" className="overflow-hidden ml-3">
                {group.turns.map((turn) => (
                  <TurnItem key={turn.id} turn={turn} />
                ))}
              </Surface>
            )}
          </div>
        );
      })}
    </div>
  );
}
