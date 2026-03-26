import { useState } from 'react';
import { ArrowLeft, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { useAgentRun, useAgentReports, useAgentTurns, type ReportRow, type TurnRow } from '../../hooks/use-agent';
import { cn } from '../../lib/cn';
import { formatEpochAgo, truncate, capitalize } from '../../lib/format';
import { formatCost, formatTokens, formatDuration } from './helpers';
import { PhaseTimeline, type PhaseResult } from './PhaseTimeline';

/* ---------- Constants ---------- */

/** Max characters to show in turn input/output preview columns. */
const TURN_PREVIEW_CHARS = 80;

/** Milliseconds per second for epoch conversion. */
const MS_PER_SECOND = 1_000;

/* ---------- Helpers ---------- */

/** Map run status to Badge variant. */
function statusBadgeVariant(status: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'running':   return 'warning';
    case 'failed':    return 'destructive';
    default:          return 'secondary';
  }
}

/** Map action type to Badge variant. */
function actionBadgeVariant(action: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  const a = action.toLowerCase();
  if (a.includes('extract') || a.includes('create')) return 'default';
  if (a.includes('supersed') || a.includes('update')) return 'default';
  if (a.includes('skip') || a.includes('no-op')) return 'secondary';
  if (a.includes('error') || a.includes('fail')) return 'destructive';
  return 'default';
}

function formatEpochRelative(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return formatEpochAgo(epoch);
}

function formatEpochAbsoluteTime(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return new Date(epoch * MS_PER_SECOND).toLocaleTimeString();
}

function truncatePreview(text: string | null, limit: number): string {
  if (!text) return '\u2014';
  return truncate(text, limit) || '\u2014';
}

/* ---------- Sub-components ---------- */

function ReportCard({ report }: { report: ReportRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = report.details !== null && report.details.length > 0;

  let parsedDetails: unknown = null;
  if (hasDetails) {
    try {
      parsedDetails = JSON.parse(report.details!);
    } catch {
      parsedDetails = report.details;
    }
  }

  return (
    <Surface level="low" className="p-4 space-y-2">
      <div className="flex items-start gap-3">
        <Badge variant={actionBadgeVariant(report.action)}>{report.action}</Badge>
        <p className="font-sans text-sm text-on-surface flex-1 leading-relaxed">{report.summary}</p>
        <span className="font-mono text-xs text-on-surface-variant shrink-0">
          {formatEpochAbsoluteTime(report.created_at)}
        </span>
      </div>

      {hasDetails && (
        <div>
          <button
            className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>

          {expanded && (
            <pre className="mt-2 rounded-md bg-surface-container-lowest p-3 font-mono text-xs overflow-auto max-h-48 text-on-surface-variant">
              {typeof parsedDetails === 'string'
                ? parsedDetails
                : JSON.stringify(parsedDetails, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Surface>
  );
}

function TurnTableRow({ turn }: { turn: TurnRow }) {
  const durationMs =
    turn.started_at !== null && turn.completed_at !== null
      ? (turn.completed_at - turn.started_at) * MS_PER_SECOND
      : null;

  return (
    <tr className="hover:bg-surface-container-high/50 transition-colors align-top">
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">{turn.turn_number}</td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface">{turn.tool_name}</td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant max-w-[200px] truncate">
        {truncatePreview(turn.tool_input, TURN_PREVIEW_CHARS)}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant max-w-[200px] truncate">
        {truncatePreview(turn.tool_output_summary, TURN_PREVIEW_CHARS)}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
        {durationMs !== null
          ? durationMs < MS_PER_SECOND
            ? `${durationMs}ms`
            : `${(durationMs / MS_PER_SECOND).toFixed(1)}s`
          : '\u2014'}
      </td>
    </tr>
  );
}

/* ---------- Component ---------- */

export interface RunDetailProps {
  runId: string;
  onBack: () => void;
}

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const [showAudit, setShowAudit] = useState(false);

  const { data: runData, isLoading: runLoading, isError: runError } = useAgentRun(runId);
  const runStatus = runData?.run?.status;
  const { data: reportsData, isLoading: reportsLoading } = useAgentReports(runId, runStatus);
  const { data: turnsData, isLoading: turnsLoading } = useAgentTurns(showAudit ? runId : undefined, runStatus);

  if (runLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans">Loading run...</span>
      </div>
    );
  }

  if (runError || !runData?.run) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Runs
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Run not found</span>
        </div>
      </div>
    );
  }

  const run = runData.run;
  const reports = reportsData?.reports ?? [];
  const turns = turnsData ?? [];

  // Parse phase results from actions_taken if present
  let phaseResults: PhaseResult[] | null = null;
  if (run.actions_taken) {
    try {
      const parsed = JSON.parse(run.actions_taken) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'phases' in parsed &&
        Array.isArray((parsed as { phases: unknown }).phases)
      ) {
        phaseResults = (parsed as { phases: PhaseResult[] }).phases;
      }
    } catch {
      // Malformed JSON -- silently ignore, don't render timeline
    }
  }

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
        <ArrowLeft className="h-4 w-4" />
        Runs
      </Button>

      {/* Summary bar */}
      <Surface level="low" className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          <Badge variant={statusBadgeVariant(run.status)}>
            {capitalize(run.status)}
          </Badge>

          <span className="font-sans text-sm text-on-surface-variant">
            Task: <span className="text-on-surface font-medium">{run.task ?? 'Default task'}</span>
          </span>

          <span className="font-sans text-sm text-on-surface-variant">
            Started: <span className="font-mono text-on-surface">{formatEpochRelative(run.started_at)}</span>
          </span>

          <span className="font-sans text-sm text-on-surface-variant">
            Duration: <span className="font-mono text-on-surface">{formatDuration(run.started_at, run.completed_at)}</span>
          </span>

          <span className="font-sans text-sm text-on-surface-variant">
            Tokens: <span className="font-mono text-on-surface">{formatTokens(run.tokens_used)}</span>
          </span>

          <span className="font-sans text-sm text-on-surface-variant">
            Cost: <span className="font-mono text-on-surface">{formatCost(run.cost_usd)}</span>
          </span>
        </div>

        {run.error && (
          <div className="mt-3 rounded-md bg-tertiary-container/20 px-3 py-2">
            <p className="font-mono text-xs text-tertiary">{run.error}</p>
          </div>
        )}
      </Surface>

      {/* Phase Timeline (only shown for phased runs) */}
      {phaseResults && phaseResults.length > 0 && (
        <Surface level="low" className="p-4">
          <PhaseTimeline phases={phaseResults} />
        </Surface>
      )}

      {/* Decisions / Reports */}
      <div className="space-y-3">
        <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
          Decisions
          {reports.length > 0 && (
            <span className="ml-2 text-on-surface normal-case font-normal">
              {reports.length} {reports.length === 1 ? 'action' : 'actions'}
            </span>
          )}
        </h2>

        {reportsLoading ? (
          <div className="flex items-center gap-2 text-on-surface-variant py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-sans text-sm">Loading decisions...</span>
          </div>
        ) : reports.length === 0 ? (
          <Surface level="low" className="flex h-24 items-center justify-center">
            <span className="font-sans text-sm text-on-surface-variant">No decisions recorded for this run</span>
          </Surface>
        ) : (
          <div className="space-y-2">
            {reports.map((report) => (
              <ReportCard key={report.id} report={report} />
            ))}
          </div>
        )}
      </div>

      {/* Audit trail (collapsed by default) */}
      <div className="space-y-3">
        <button
          className="flex items-center gap-2 font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide hover:text-on-surface transition-colors"
          onClick={() => setShowAudit(!showAudit)}
        >
          {showAudit
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
          Audit Trail
          <span className="normal-case font-normal text-xs">(diagnostics)</span>
        </button>

        {showAudit && (
          <Surface level="low" className={cn('overflow-hidden')}>
            <div className="p-4 pb-2">
              <h3 className="font-sans text-sm font-medium text-on-surface">Turn-by-turn trace</h3>
            </div>
            <div className="p-0">
              {turnsLoading ? (
                <div className="flex items-center gap-2 text-on-surface-variant p-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="font-sans text-sm">Loading turns...</span>
                </div>
              ) : turns.length === 0 ? (
                <p className="font-sans text-sm text-on-surface-variant p-4">No turns recorded.</p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-surface-container-high/50">
                        <th className="px-3 py-2 font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">#</th>
                        <th className="px-3 py-2 font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">Tool</th>
                        <th className="px-3 py-2 font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">Input</th>
                        <th className="px-3 py-2 font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">Output</th>
                        <th className="px-3 py-2 font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {turns.map((turn) => (
                        <TurnTableRow key={turn.id} turn={turn} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Surface>
        )}
      </div>
    </div>
  );
}
