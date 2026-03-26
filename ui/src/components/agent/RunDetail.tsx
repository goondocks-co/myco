import { useState, useMemo } from 'react';
import { ArrowLeft, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { MarkdownContent } from '../ui/markdown-content';
import { useAgentRun, useAgentReports, useAgentTurns, useAgentTasks, type ReportRow, type TurnRow } from '../../hooks/use-agent';
import { cn } from '../../lib/cn';
import { formatEpochRelative, truncate, capitalize } from '../../lib/format';
import { formatCost, formatTokens, formatDuration, resolveTaskName } from './helpers';
import { PhaseTimeline, type PhaseResult } from './PhaseTimeline';

/* ---------- Constants ---------- */

/** Max characters to show in turn input/output preview columns. */
const TURN_PREVIEW_CHARS = 80;

/** Milliseconds per second for epoch conversion. */
const MS_PER_SECOND = 1_000;

/* ---------- Helpers ---------- */

/** Map action type to Badge variant. */
function actionBadgeVariant(action: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  const a = action.toLowerCase();
  if (a.includes('extract') || a.includes('create')) return 'default';
  if (a.includes('supersed') || a.includes('update')) return 'default';
  if (a.includes('skip') || a.includes('no-op')) return 'secondary';
  if (a.includes('error') || a.includes('fail')) return 'destructive';
  return 'default';
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
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const hasDetails = report.details !== null && report.details.length > 0;
  const isLongSummary = report.summary.length > 200 || report.summary.includes('\n');

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
        <div className="flex-1 min-w-0">
          <div className={!summaryExpanded && isLongSummary ? 'line-clamp-3' : undefined}>
            <MarkdownContent content={report.summary} />
          </div>
          {isLongSummary && (
            <button
              className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors mt-1"
              onClick={() => setSummaryExpanded(!summaryExpanded)}
            >
              {summaryExpanded
                ? <><ChevronDown className="h-3 w-3" /> Show less</>
                : <><ChevronRight className="h-3 w-3" /> Show more</>}
            </button>
          )}
        </div>
        <span className="font-mono text-xs text-on-surface-variant shrink-0">
          {formatEpochAbsoluteTime(report.created_at)}
        </span>
      </div>

      {hasDetails && (
        <div>
          <button
            className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            onClick={() => setDetailsExpanded(!detailsExpanded)}
          >
            {detailsExpanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
            {detailsExpanded ? 'Hide details' : 'Show details'}
          </button>

          {detailsExpanded && (
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

function TurnCard({ turn }: { turn: TurnRow }) {
  const [expanded, setExpanded] = useState(false);

  let parsedInput: unknown = null;
  if (turn.tool_input) {
    try {
      parsedInput = JSON.parse(turn.tool_input);
    } catch {
      parsedInput = turn.tool_input;
    }
  }

  const inputPreview = turn.tool_input
    ? truncatePreview(turn.tool_input, TURN_PREVIEW_CHARS)
    : '\u2014';
  const hasExpandableInput = turn.tool_input !== null && turn.tool_input.length > TURN_PREVIEW_CHARS;

  return (
    <div className="px-4 py-2.5 hover:bg-surface-container-high/30 transition-colors border-b border-outline-variant/10 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className="font-mono text-xs text-on-surface-variant w-5 shrink-0 pt-0.5 text-right">
          {turn.turn_number}
        </span>
        <span className="font-mono text-xs font-medium text-on-surface shrink-0 pt-0.5 min-w-[140px]">
          {turn.tool_name}
        </span>
        <div className="flex-1 min-w-0">
          {hasExpandableInput ? (
            <button
              className="flex items-start gap-1 text-left font-mono text-xs text-on-surface-variant hover:text-on-surface transition-colors w-full"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" />
                : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />}
              <span className={expanded ? undefined : 'truncate'}>{inputPreview}</span>
            </button>
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
        </div>
      </div>
    </div>
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
  const { data: tasksData } = useAgentTasks();
  const tasksList = useMemo(() => tasksData?.tasks ?? [], [tasksData]);

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

  // Parse run metadata and phase results from actions_taken
  let phaseResults: PhaseResult[] | null = null;
  let runModel: string | undefined;
  let runProvider: string | undefined;
  if (run.actions_taken) {
    try {
      const parsed = JSON.parse(run.actions_taken) as Record<string, unknown>;
      if (parsed?.phases && Array.isArray(parsed.phases)) {
        phaseResults = parsed.phases as PhaseResult[];
      }
      if (typeof parsed?.model === 'string') runModel = parsed.model as string;
      if (typeof parsed?.provider === 'string') runProvider = parsed.provider as string;
    } catch {
      // Malformed JSON -- silently ignore
    }
  }

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
        <ArrowLeft className="h-4 w-4" />
        Runs
      </Button>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Status" value={capitalize(run.status)} accent="sage" />
        <StatCard label="Task" value={resolveTaskName(run.task, tasksList)} accent="outline" />
        <StatCard label="Started" value={formatEpochRelative(run.started_at)} accent="outline" />
        <StatCard label="Duration" value={formatDuration(run.started_at, run.completed_at)} accent="outline" />
        <StatCard label="Tokens" value={formatTokens(run.tokens_used)} accent="ochre" />
        <StatCard label="Cost" value={formatCost(run.cost_usd)} accent="ochre" />
      </div>

      {/* Model / Provider info */}
      {(runModel || runProvider) && (
        <div className="flex items-center gap-4 px-1">
          {runProvider && (
            <span className="font-sans text-xs text-on-surface-variant">
              Provider: <span className="font-mono text-on-surface">{runProvider}</span>
            </span>
          )}
          {runModel && (
            <span className="font-sans text-xs text-on-surface-variant">
              Model: <span className="font-mono text-on-surface">{runModel}</span>
            </span>
          )}
        </div>
      )}

      {run.error && (
        <div className="rounded-md bg-tertiary/10 px-3 py-2">
          <p className="font-mono text-xs text-tertiary">{run.error}</p>
        </div>
      )}

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
                <div>
                  {turns.map((turn) => (
                    <TurnCard key={turn.id} turn={turn} />
                  ))}
                </div>
              )}
            </div>
          </Surface>
        )}
      </div>
    </div>
  );
}
