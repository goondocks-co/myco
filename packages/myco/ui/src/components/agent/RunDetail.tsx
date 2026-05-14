import { useState, useMemo } from 'react';
import { ArrowLeft, AlertCircle, Loader2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { MarkdownContent } from '../ui/markdown-content';
import { RefreshIndicator } from '../ui/refresh-indicator';
import { POLL_INTERVALS } from '../../lib/constants';
import {
  useAgentRun,
  useAgentReports,
  useAgentTurns,
  useAgentTasks,
  useResumeRun,
  useAgentRunWriteIntents,
  useAgentRunAudit,
  useDigestRevisions,
  useRestoreDigestRevision,
  type ReportRow,
  type TurnRow,
  type WriteIntentRow,
  type PhaseAuditEntry,
  type DigestRevisionRow,
} from '../../hooks/use-agent';
import { RunTaskDialog } from './RunTaskDialog';
import { cn } from '../../lib/cn';
import { formatEpochRelative, truncate, capitalize } from '../../lib/format';
import { formatCost, formatTokens, formatDuration, resolveTaskName } from './helpers';
import { PhaseTimeline, type PhaseResult } from './PhaseTimeline';
import type { CostResolution } from '@myco/agent/cost/types';
import type { HarnessTokenBudget } from '@myco/agent/types';
import { tryParseJson } from '@myco/utils/json';

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

function formatBudgetSource(source: HarnessTokenBudget['contextWindowSource'] | undefined): string {
  if (!source) return '\u2014';
  switch (source) {
    case 'provider-config':
      return 'provider config';
    case 'provider-metadata':
      return 'provider metadata';
    case 'provider-default':
      return 'inferred provider default';
    default:
      return source;
  }
}

type ParsedCostData = CostResolution;

interface ParsedUsageData {
  run?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    requests?: number;
  };
  runBudget?: HarnessTokenBudget;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParsedCostData(value: unknown): value is ParsedCostData {
  return isPlainObject(value);
}

function isParsedUsageData(value: unknown): value is ParsedUsageData {
  return isPlainObject(value);
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-container-lowest px-3 py-2">
      <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">{label}</p>
      <p className="font-mono text-sm text-on-surface">{value}</p>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function ReportCard({ report }: { report: ReportRow }) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const hasDetails = report.details !== null && report.details.length > 0;
  const isLongSummary = report.summary.length > 200 || report.summary.includes('\n');

  const parsedDetails: unknown = hasDetails
    ? tryParseJson(report.details) ?? report.details
    : null;

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

  const parsedInput: unknown = turn.tool_input
    ? tryParseJson(turn.tool_input) ?? turn.tool_input
    : null;

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

/* ---------- Write-intents panel ---------- */

/** Group intents by tool_name, preserving their original order. */
function groupIntentsByTool(intents: WriteIntentRow[]): Array<{ tool: string; items: WriteIntentRow[] }> {
  const map = new Map<string, WriteIntentRow[]>();
  for (const intent of intents) {
    const list = map.get(intent.tool_name) ?? [];
    list.push(intent);
    map.set(intent.tool_name, list);
  }
  return Array.from(map.entries()).map(([tool, items]) => ({ tool, items }));
}

function IntentGroupCard({ tool, items }: { tool: string; items: WriteIntentRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md bg-surface-container-lowest">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-container-high/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" />
          : <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />}
        <span className="font-mono text-xs text-on-surface">{tool}</span>
        <Badge variant="secondary" className="ml-auto">
          {items.length}
        </Badge>
      </button>
      {open && (
        <div className="space-y-2 border-t border-outline-variant/20 px-3 py-3">
          {items.map((intent) => (
            <div key={intent.id} className="space-y-1">
              {intent.stub_id && (
                <p className="font-mono text-[11px] text-on-surface-variant">
                  stub: <span className="text-on-surface">{intent.stub_id}</span>
                </p>
              )}
              <pre className="rounded-md bg-surface-container p-2 font-mono text-[11px] overflow-auto max-h-40 text-on-surface-variant">
                {JSON.stringify(intent.tool_input, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IntendedWritesPanel({ runId }: { runId: string }) {
  const { data, isLoading, isError } = useAgentRunWriteIntents(runId);
  const intents = data?.intents ?? [];
  const groups = useMemo(() => groupIntentsByTool(intents), [intents]);

  return (
    <div className="space-y-3">
      <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
        Intended Writes
        {intents.length > 0 && (
          <span className="ml-2 text-on-surface normal-case font-normal">
            {intents.length} {intents.length === 1 ? 'intent' : 'intents'}
          </span>
        )}
      </h2>

      {isLoading ? (
        <div className="flex items-center gap-2 text-on-surface-variant py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-sans text-sm">Loading write intents...</span>
        </div>
      ) : isError ? (
        <Surface level="low" className="flex h-20 items-center justify-center">
          <span className="font-sans text-sm text-tertiary">Failed to load write intents</span>
        </Surface>
      ) : intents.length === 0 ? (
        <Surface level="low" className="flex h-24 items-center justify-center">
          <span className="font-sans text-sm text-on-surface-variant">No writes attempted</span>
        </Surface>
      ) : (
        <>
          <div className="space-y-2">
            {groups.map((g) => (
              <IntentGroupCard key={g.tool} tool={g.tool} items={g.items} />
            ))}
          </div>
          <p className="font-sans text-xs text-on-surface-variant italic">
            {intents.length} {intents.length === 1 ? 'write' : 'writes'} would have been performed —
            no vault data was mutated.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- Phase audit section ---------- */

function PhaseAuditCard({ entry }: { entry: PhaseAuditEntry }) {
  const [open, setOpen] = useState(false);
  const toolBadges = Object.entries(entry.toolCalls);
  const writeIntentBadges = entry.writeIntents ? Object.entries(entry.writeIntents.byTool) : [];

  return (
    <Surface level="low" className="overflow-hidden">
      <button
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

function phaseStatusVariant(status: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'failed':    return 'destructive';
    case 'skipped':   return 'secondary';
    default:          return 'warning';
  }
}

function PhaseAuditSection({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useAgentRunAudit(open ? runId : null);
  const phases = data?.audit.phases ?? [];

  return (
    <div className="space-y-3">
      <button
        className="flex items-center gap-2 font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide hover:text-on-surface transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open
          ? <ChevronDown className="h-4 w-4" />
          : <ChevronRight className="h-4 w-4" />}
        Phase Audit
        <span className="normal-case font-normal text-xs">(per-phase join)</span>
      </button>

      {open && (
        isLoading ? (
          <div className="flex items-center gap-2 text-on-surface-variant py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-sans text-sm">Loading audit...</span>
          </div>
        ) : phases.length === 0 ? (
          <Surface level="low" className="flex h-20 items-center justify-center">
            <span className="font-sans text-sm text-on-surface-variant">No phase data recorded</span>
          </Surface>
        ) : (
          <div className="space-y-2">
            {phases.map((entry) => (
              <PhaseAuditCard key={entry.phaseName} entry={entry} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/* ---------- Digest revisions section ---------- */

/** Default digest tier to surface in the revisions panel (matches vault-evolve writes). */
const DEFAULT_DIGEST_TIER = 5000;

function DigestRevisionRowView({
  revision,
  onRestore,
  isPending,
}: {
  revision: DigestRevisionRow;
  onRestore: () => void;
  isPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = revision.content.length > 240
    ? revision.content.slice(0, 240) + '\u2026'
    : revision.content;
  return (
    <Surface level="low" className="p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-on-surface">#{revision.id}</span>
            <span className="font-mono text-xs text-on-surface-variant">
              {formatEpochRelative(revision.created_at)}
            </span>
            {revision.run_id && (
              <span className="font-mono text-[10px] text-on-surface-variant">
                run: {revision.run_id.slice(0, 8)}
              </span>
            )}
          </div>
          <button
            className="mt-1 text-left font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors whitespace-pre-wrap"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? revision.content : preview}
          </button>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRestore}
          disabled={isPending}
          className="shrink-0"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Restore'}
        </Button>
      </div>
    </Surface>
  );
}

function DigestRevisionsSection({ agentId, tier }: { agentId: string; tier: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useDigestRevisions(open ? agentId : '', tier);
  const restore = useRestoreDigestRevision();
  const revisions = data?.revisions ?? [];

  const handleRestore = (id: number) => {
    if (!window.confirm(`Restore revision #${id}? The current digest content will be preserved as a new revision.`)) {
      return;
    }
    restore.mutate({ revisionId: id });
  };

  return (
    <div className="space-y-3">
      <button
        className="flex items-center gap-2 font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide hover:text-on-surface transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open
          ? <ChevronDown className="h-4 w-4" />
          : <ChevronRight className="h-4 w-4" />}
        Digest Revisions
        <span className="normal-case font-normal text-xs">(tier {tier})</span>
      </button>

      {open && (
        isLoading ? (
          <div className="flex items-center gap-2 text-on-surface-variant py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-sans text-sm">Loading revisions...</span>
          </div>
        ) : revisions.length === 0 ? (
          <Surface level="low" className="flex h-20 items-center justify-center">
            <span className="font-sans text-sm text-on-surface-variant">No revisions recorded</span>
          </Surface>
        ) : (
          <div className="space-y-2">
            {restore.isError && (
              <p className="font-sans text-xs text-tertiary">
                {restore.error instanceof Error ? restore.error.message : 'Restore failed'}
              </p>
            )}
            {revisions.map((rev) => (
              <DigestRevisionRowView
                key={rev.id}
                revision={rev}
                onRestore={() => handleRestore(rev.id)}
                isPending={restore.isPending}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** Return true if any turn recorded a digest write (real or intercepted). */
function hasDigestWrites(turns: TurnRow[]): boolean {
  return turns.some((t) => t.tool_name === 'vault_write_digest');
}

/* ---------- Component ---------- */

export interface RunDetailProps {
  runId: string;
  onBack: () => void;
}

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const [showAudit, setShowAudit] = useState(false);
  // "Rerun with same settings" state — opens RunTaskDialog pre-filled from
  // the current run. The dialog is the confirmation step; submission starts
  // a brand-new run and never modifies this one.
  const [rerunOpen, setRerunOpen] = useState(false);

  const {
    data: runData,
    isLoading: runLoading,
    isError: runError,
    isFetching: runFetching,
    refetch: refetchRun,
  } = useAgentRun(runId);
  const runStatus = runData?.run?.status;
  const { data: reportsData, isLoading: reportsLoading } = useAgentReports(runId, runStatus);
  const { data: turnsData, isLoading: turnsLoading } = useAgentTurns(showAudit ? runId : undefined, runStatus);
  const { data: tasksData } = useAgentTasks();
  const resumeMutation = useResumeRun();
  const tasksList = useMemo(() => tasksData?.tasks ?? [], [tasksData]);
  const parsedCost = useMemo(
    () => tryParseJson(runData?.run?.cost_data, isParsedCostData),
    [runData?.run?.cost_data],
  );
  const parsedUsage = useMemo(
    () => tryParseJson(runData?.run?.usage_data, isParsedUsageData),
    [runData?.run?.usage_data],
  );
  const phaseResults = useMemo(() => {
    const parsed = tryParseJson(runData?.run?.actions_taken, isPlainObject);
    return parsed?.phases && Array.isArray(parsed.phases)
      ? parsed.phases as PhaseResult[]
      : null;
  }, [runData?.run?.actions_taken]);

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
  const costCardLabel = run.cost_source === 'estimated' ? 'Estimated Cost' : 'Cost';
  const isDryRun = run.dry_run === true;
  const isTerminal = ['completed', 'failed', 'skipped'].includes(run.status);
  // Detect whether this run produced digest writes so we know whether to
  // render the revisions section. turns is empty until the audit trail is
  // opened; fall back to task name ('vault-evolve' always writes a
  // digest) to avoid hiding the section on initial page load.
  const hasDigestActivity = !isDryRun && (run.task === 'vault-evolve' || hasDigestWrites(turns));

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Runs
        </Button>
        {isDryRun && (
          <Badge variant="warning" title="Writes were intercepted and recorded as intents">
            Dry Run
          </Badge>
        )}
        {!isTerminal && (
          <RefreshIndicator
            className="ml-auto"
            intervalMs={POLL_INTERVALS.RUN_DETAIL}
            isFetching={runFetching}
            onManualRefresh={() => { void refetchRun(); }}
          />
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Status" value={capitalize(run.status)} accent="sage" />
        <StatCard label="Task" value={resolveTaskName(run.task, tasksList)} accent="outline" />
        <StatCard label="Started" value={formatEpochRelative(run.started_at)} accent="outline" />
        <StatCard label="Duration" value={formatDuration(run.started_at, run.completed_at)} accent="outline" />
        <StatCard label="Tokens" value={formatTokens(run.tokens_used)} accent="ochre" />
        <StatCard label={costCardLabel} value={formatCost(run.cost_usd, run.cost_source)} accent="ochre" />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {run.resumable && run.status === 'failed' && (
          <>
            <Button
              size="sm"
              onClick={() => resumeMutation.mutate({ runId: run.id, mode: 'manual' })}
              disabled={resumeMutation.isPending}
            >
              {resumeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Resume Run
            </Button>
            <span className="font-sans text-xs text-on-surface-variant">
              Resume status: {run.resume_status ?? 'ready'}
            </span>
          </>
        )}
        {/* Rerun with same settings — visible for any completed/failed run.
            Opens the existing RunTaskDialog pre-filled with the source run's
            task, instruction, dry-run flag, and execution overrides. The
            dialog is the confirmation step; it always starts a NEW run. */}
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => setRerunOpen(true)}
          title="Start a new run with the same settings as this one"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Rerun with same settings
        </Button>
      </div>

      {/* Model / Provider info */}
      {(run.harness || run.provider || run.model) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          {run.harness && (
            <span className="font-sans text-xs text-on-surface-variant">
              Harness: <span className="font-mono text-on-surface">{run.harness}</span>
            </span>
          )}
          {run.provider && (
            <span className="font-sans text-xs text-on-surface-variant">
              Provider: <span className="font-mono text-on-surface">{run.provider}</span>
            </span>
          )}
          {run.model && (
            <span className="font-sans text-xs text-on-surface-variant">
              Model: <span className="font-mono text-on-surface">{run.model}</span>
            </span>
          )}
          {run.cost_source && run.cost_source !== 'unavailable' && (
            <span className="font-sans text-xs text-on-surface-variant">
              Cost source: <span className="font-mono text-on-surface">{run.cost_source}</span>
            </span>
          )}
        </div>
      )}

      {(parsedCost || parsedUsage?.run) && (
        <Surface level="low" className="p-4 space-y-3">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Cost Diagnostics
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatTile label="Input" value={formatTokens(parsedCost?.breakdown.inputTokens ?? parsedUsage?.run?.inputTokens ?? null)} />
            <StatTile label="Cached Input" value={formatTokens(parsedCost?.breakdown.cachedInputTokens ?? parsedUsage?.run?.cachedTokens ?? null)} />
            <StatTile label="Uncached Input" value={formatTokens(parsedCost?.breakdown.uncachedInputTokens ?? null)} />
            <StatTile label="Output" value={formatTokens(parsedCost?.breakdown.outputTokens ?? parsedUsage?.run?.outputTokens ?? null)} />
            <StatTile label="Requests" value={formatTokens(parsedCost?.breakdown.requestCount ?? parsedUsage?.run?.requests ?? null)} />
            <StatTile label="Cache Savings" value={formatCost(parsedCost?.breakdown.cacheSavingsUsd ?? null, 'estimated')} />
          </div>
          {parsedCost?.message && (
            <p className="font-sans text-xs text-on-surface-variant">{parsedCost.message}</p>
          )}
        </Surface>
      )}

      {parsedUsage?.runBudget && (
        <Surface level="low" className="p-4 space-y-3">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Token Budget
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatTile label="Context Window" value={formatTokens(parsedUsage.runBudget.contextWindowTokens)} />
            <StatTile label="Peak Request" value={formatTokens(parsedUsage.runBudget.peakRequestTotalTokens)} />
            <StatTile label="Peak Input" value={formatTokens(parsedUsage.runBudget.peakRequestInputTokens)} />
            <StatTile label="Peak Output" value={formatTokens(parsedUsage.runBudget.peakRequestOutputTokens)} />
            <StatTile label="Budget Used" value={parsedUsage.runBudget.utilizationPercent != null ? `${parsedUsage.runBudget.utilizationPercent}%` : '\u2014'} />
            <StatTile label="Headroom" value={formatTokens(parsedUsage.runBudget.headroomTokens)} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
            <span className="font-sans text-xs text-on-surface-variant">
              Budget status: <span className="font-mono text-on-surface">{parsedUsage.runBudget.status}</span>
            </span>
            <span className="font-sans text-xs text-on-surface-variant">
              Context source: <span className="font-mono text-on-surface">{formatBudgetSource(parsedUsage.runBudget.contextWindowSource)}</span>
            </span>
          </div>
          {parsedUsage.runBudget.message && (
            <p className="font-sans text-xs text-on-surface-variant">{parsedUsage.runBudget.message}</p>
          )}
        </Surface>
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

      {run.phase_checkpoints && run.phase_checkpoints.length > 0 && (
        <Surface level="low" className="p-4 space-y-2">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Checkpoints
          </h2>
          <div className="space-y-2">
            {run.phase_checkpoints.map((phase) => (
              <div key={phase.name} className="flex items-center justify-between gap-3 rounded-md bg-surface-container-lowest px-3 py-2">
                <div>
                  <p className="font-sans text-sm text-on-surface">{phase.name}</p>
                  <p className="font-mono text-xs text-on-surface-variant">
                    {phase.status}{phase.costSource ? ` • ${phase.costSource}` : ''}
                  </p>
                </div>
                <p className="font-mono text-xs text-on-surface-variant">{formatEpochRelative(Math.floor(phase.updatedAt))}</p>
              </div>
            ))}
          </div>
        </Surface>
      )}

      {/* Intended writes (dry-run only) */}
      {isDryRun && <IntendedWritesPanel runId={run.id} />}

      {/* Digest revisions (real runs that produce a digest) */}
      {hasDigestActivity && (
        <DigestRevisionsSection agentId={run.agent_id} tier={DEFAULT_DIGEST_TIER} />
      )}

      {/* Phase audit — always available */}
      <PhaseAuditSection runId={run.id} />

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

      {/* Rerun confirmation dialog — pre-filled from `run` so the operator
          can review settings before kicking off a new run. */}
      <RunTaskDialog
        open={rerunOpen}
        onOpenChange={setRerunOpen}
        sourceRun={run}
      />
    </div>
  );
}
