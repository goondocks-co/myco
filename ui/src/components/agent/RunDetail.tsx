import { useState } from 'react';
import { ArrowLeft, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useAgentRun, useAgentReports, useAgentTurns, type ReportRow, type TurnRow } from '../../hooks/use-agent';
import { cn } from '../../lib/cn';
import { formatEpochAgo, truncate, capitalize } from '../../lib/format';
import { runStatusClass, formatCost, formatTokens, formatDuration } from './helpers';

/* ---------- Constants ---------- */

/** Max characters to show in turn input/output preview columns. */
const TURN_PREVIEW_CHARS = 80;

/** Milliseconds per second for epoch conversion. */
const MS_PER_SECOND = 1_000;

/* ---------- Helpers ---------- */

function actionClass(action: string): string {
  const a = action.toLowerCase();
  if (a.includes('extract') || a.includes('create')) return 'bg-green-500/15 text-green-700 border-green-500/30 dark:text-green-400';
  if (a.includes('supersed') || a.includes('update')) return 'bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400';
  if (a.includes('skip') || a.includes('no-op'))      return 'bg-muted text-muted-foreground border-border';
  if (a.includes('error') || a.includes('fail'))      return 'bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400';
  return 'bg-purple-500/15 text-purple-600 border-purple-500/30 dark:text-purple-400';
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

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold',
        runStatusClass(status),
      )}
    >
      {capitalize(status)}
    </span>
  );
}

function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold shrink-0',
        actionClass(action),
      )}
    >
      {action}
    </span>
  );
}

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
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-start gap-3">
        <ActionBadge action={report.action} />
        <p className="text-sm text-foreground flex-1 leading-relaxed">{report.summary}</p>
        <span className="text-xs text-muted-foreground shrink-0 font-mono">
          {formatEpochAbsoluteTime(report.created_at)}
        </span>
      </div>

      {hasDetails && (
        <div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>

          {expanded && (
            <pre className="mt-2 rounded bg-muted p-3 text-xs font-mono overflow-auto max-h-48 text-muted-foreground">
              {typeof parsedDetails === 'string'
                ? parsedDetails
                : JSON.stringify(parsedDetails, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TurnTableRow({ turn }: { turn: TurnRow }) {
  const durationMs =
    turn.started_at !== null && turn.completed_at !== null
      ? (turn.completed_at - turn.started_at) * 1000
      : null;

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-3 py-2 text-xs text-muted-foreground font-mono">{turn.turn_number}</td>
      <td className="px-3 py-2 text-xs font-mono text-foreground">{turn.tool_name}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground font-mono max-w-[200px] truncate">
        {truncatePreview(turn.tool_input, TURN_PREVIEW_CHARS)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground font-mono max-w-[200px] truncate">
        {truncatePreview(turn.tool_output_summary, TURN_PREVIEW_CHARS)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
        {durationMs !== null
          ? durationMs < 1_000
            ? `${durationMs}ms`
            : `${(durationMs / 1_000).toFixed(1)}s`
          : '—'}
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
  const { data: reportsData, isLoading: reportsLoading } = useAgentReports(runId);
  const { data: turnsData, isLoading: turnsLoading } = useAgentTurns(showAudit ? runId : undefined);

  if (runLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading run...</span>
      </div>
    );
  }

  if (runError || !runData?.run) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Runs
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">Run not found</span>
        </div>
      </div>
    );
  }

  const run = runData.run;
  const reports = reportsData?.reports ?? [];
  const turns = turnsData ?? [];

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-muted-foreground">
        <ArrowLeft className="h-4 w-4" />
        Runs
      </Button>

      {/* Summary bar */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-4">
          <StatusBadge status={run.status} />

          <span className="text-sm text-muted-foreground">
            Task: <span className="text-foreground font-medium">{run.task ?? 'Default task'}</span>
          </span>

          <span className="text-sm text-muted-foreground">
            Started: <span className="text-foreground font-mono">{formatEpochRelative(run.started_at)}</span>
          </span>

          <span className="text-sm text-muted-foreground">
            Duration: <span className="text-foreground font-mono">{formatDuration(run.started_at, run.completed_at)}</span>
          </span>

          <span className="text-sm text-muted-foreground">
            Tokens: <span className="text-foreground font-mono">{formatTokens(run.tokens_used)}</span>
          </span>

          <span className="text-sm text-muted-foreground">
            Cost: <span className="text-foreground font-mono">{formatCost(run.cost_usd)}</span>
          </span>
        </div>

        {run.error && (
          <div className="mt-3 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
            <p className="text-xs text-destructive font-mono">{run.error}</p>
          </div>
        )}
      </div>

      {/* Decisions / Reports */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Decisions
          {reports.length > 0 && (
            <span className="ml-2 text-foreground normal-case font-normal">
              {reports.length} {reports.length === 1 ? 'action' : 'actions'}
            </span>
          )}
        </h2>

        {reportsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading decisions...</span>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-border text-muted-foreground">
            <span className="text-sm">No decisions recorded for this run</span>
          </div>
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
          className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          onClick={() => setShowAudit(!showAudit)}
        >
          {showAudit
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
          Audit Trail
          <span className="normal-case font-normal text-xs">(diagnostics)</span>
        </button>

        {showAudit && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Turn-by-turn trace</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {turnsLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground p-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading turns...</span>
                </div>
              ) : turns.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">No turns recorded.</p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">#</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Tool</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Input</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Time</th>
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
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
