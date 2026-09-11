import { heldByWords } from '@goondocks/myco-shared/run-holds';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { Row } from '../components/ui/row';
import { MetricCard } from '../components/ui/metric-card';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { SubtabPill } from '../components/ui/subtab-pill';
import { MEMORY_TASKS, taskRefusalText, useAgents, useDispatchMemoryTask, useRun, useRuns, type PhaseRow, type ReportRow, type RunDetailRow, type RunListRow, type RunToolCallRow } from '../hooks/use-intelligence';
import { ApiError } from '../lib/api';
import { formatCost, formatDateTime, formatDuration, formatRelative, formatTokens } from '../lib/format';
import { NotFound } from './NotFound';

/** The statuses a run is written with; anything else renders neutral rather than assuming the set is closed. */
const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
];

const STATUS_TONE: Record<string, StatusTone> = { queued: 'outline', skipped: 'outline', running: 'ochre', completed: 'sage', failed: 'terracotta' };

/** What a deploy did to a run, in the reader's words: nothing for an ordinary run. */
export function deployWords(run: { replaced: boolean; replaces: string | null }): string | null {
  if (run.replaced) return 'replaced during a deploy';
  if (run.replaces !== null) return `retry of ${run.replaces}`;
  return null;
}

/** A queued run's line: its place in the queue and what holds it. */
export function queuedWords(run: { position: number | null; heldBy: string | null }): string {
  const ahead = run.position ?? 0;
  const turn = ahead === 0 ? 'next in line' : `${ahead} ahead of it`;
  const holder = run.heldBy === null ? 'a limit' : (heldByWords(run.heldBy) ?? run.heldBy);
  return `waiting — ${turn} · held by ${holder}`;
}

const RESUME_TEXT: Record<string, string> = {
  ready: 'Can be resumed.',
  session_expired: 'The provider session expired; the checkpoint is discarded and the next run starts fresh.',
  postcondition_unsatisfiable: 'A phase could not satisfy its post-condition; resuming would fail the same way.',
  superseded: 'A later run replaced it.',
  exhausted: 'Resume attempts are used up.',
};

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

const statusTone = (status: string): StatusTone => STATUS_TONE[status] ?? 'outline';

/** `/p/:projectId/runs` and `/p/:projectId/runs/:runId`: what this project's intelligence tasks did, run by run. */
export function AgentRuns() {
  const { projectId = '', runId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('all');
  const runs = useRuns(projectId, status === 'all' ? null : status);
  const base = `/p/${encodeURIComponent(projectId)}/runs`;

  return (
    <PageContainer>
      <PageHeader title="Agent runs" subtitle="What this project's intelligence tasks did, run by run." />
      <MemoryTaskAction key={projectId} projectId={projectId} />
      <div className="mb-4">
        <SubtabPill tabs={STATUS_TABS} activeTab={status} onTabChange={setStatus} />
      </div>
      <PageLoading isLoading={runs.isPending} error={runs.error}>
        <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
          <MasterDetailSplit
            hasSelection={runId !== undefined}
            onCloseMobileDetail={() => navigate(base)}
            masterAriaLabel="Runs"
            detailAriaLabel="Run"
            master={
              runs.rows.length === 0 ? (
                <p className="p-4 font-sans text-sm text-on-surface-variant">
                  {status === 'all' ? 'No runs yet. Runs appear here when this project\'s intelligence tasks execute.' : `No ${status} runs.`}
                </p>
              ) : (
                <div role="table" aria-label="Runs">
                  {runs.rows.map((run) => (
                    <RunRow key={run.id} run={run} active={run.id === runId} onOpen={() => navigate(`${base}/${encodeURIComponent(run.id)}`)} />
                  ))}
                  {runs.hasMore && (
                    <div className="p-3">
                      <button type="button" className={button} onClick={runs.more}>Load more</button>
                    </div>
                  )}
                </div>
              )
            }
            detail={runId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a run to see what it did.</p> : <RunDetail projectId={projectId} runId={runId} />}
          />
        </div>
      </PageLoading>
    </PageContainer>
  );
}

function MemoryTaskAction({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<string>(MEMORY_TASKS[0].id);
  const task = MEMORY_TASKS.find((entry) => entry.id === selected) ?? MEMORY_TASKS[0];
  const dispatch = useDispatchMemoryTask(projectId);
  const answer = dispatch.data;
  return (
    <Panel className="mb-5"><form aria-label="Run a memory task" onSubmit={(event) => {
      event.preventDefault();
      if (!dispatch.isPending) dispatch.mutate(task.id);
    }}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="font-sans text-sm text-on-surface" htmlFor="memory-task">Memory task</label>
        <select id="memory-task" value={task.id} disabled={dispatch.isPending} onChange={(event) => { setSelected(event.target.value); dispatch.reset(); }} className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface">
          {MEMORY_TASKS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <button type="submit" className={button} disabled={dispatch.isPending}>{dispatch.isPending ? 'Requesting…' : 'Run task'}</button>
      </div>
      <p className="mt-2 font-sans text-xs text-on-surface-variant">{task.description} An attached worker runs the task under the server's limits.</p>
      {dispatch.error && <p role="alert" className="mt-2 font-sans text-sm text-tertiary">{taskRefusalText(dispatch.error)}</p>}
      {answer && <p role="status" className="mt-2 font-sans text-sm text-on-surface">
        {'outcome' in answer ? 'The source material is unchanged. No run was created.' : <>
          {answer.queued ? 'Task queued for a worker. ' : 'Task started. '}
          <Link className="underline" to={`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(answer.runId)}`}>View run</Link>
        </>}
      </p>}
    </form></Panel>
  );
}

function RunRow({ run, active, onOpen }: { run: RunListRow; active: boolean; onOpen: () => void }) {
  const deploy = deployWords(run);
  return (
    <Row isActive={active} onClick={onOpen} accent={run.failed ? 'terra' : 'sage'}>
      <div className="flex items-center gap-2 font-sans text-sm">
        <StatusDot tone={statusTone(run.status)} pulse={run.status === 'running'} />
        <span className="min-w-0 flex-1 truncate text-on-surface">{run.task ?? run.id}</span>
        <span className="font-mono text-[11px] text-on-surface-variant">{run.status}</span>
      </div>
      {deploy !== null && <div className="mt-1 truncate font-sans text-[11px] text-tertiary">{deploy}</div>}
      {run.status === 'queued' ? (
        <div className="mt-1 flex gap-3 font-mono text-[11px] text-on-surface-variant">
          <span>{formatRelative(run.queuedAt)}</span>
          <span>{queuedWords(run)}</span>
        </div>
      ) : (
        <div className="mt-1 flex gap-3 font-mono text-[11px] text-on-surface-variant">
          <span>{formatRelative(run.startedAt ?? run.completedAt)}</span>
          <span>{formatDuration(run.startedAt, run.completedAt)}</span>
          <span>{formatTokens(run.tokensUsed)} tok</span>
          <span>{formatCost(run.costUsd, run.costSource)}</span>
        </div>
      )}
    </Row>
  );
}

function RunDetail({ projectId, runId }: { projectId: string; runId: string }) {
  const detail = useRun(projectId, runId);
  const agents = useAgents();
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
  return (
    <PageLoading isLoading={detail.isPending} error={detail.error}>
      {detail.data && <RunBody run={detail.data.run} phases={detail.data.phases} reports={detail.data.reports} toolCalls={detail.data.toolCalls} agentName={agents.data?.agents.find((a) => a.id === detail.data.run.agentId)?.name ?? null} />}
    </PageLoading>
  );
}

function RunBody({ run, phases, reports, toolCalls, agentName }: { run: RunDetailRow; phases: PhaseRow[] | null; reports: ReportRow[]; toolCalls: RunToolCallRow[]; agentName: string | null }) {
  const failed = run.status === 'failed' || run.error !== null;
  const deploy = deployWords(run);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Run · {run.task ?? 'task'}</div>
        <h2 className="font-serif text-xl text-on-surface">{run.task ?? run.id}</h2>
        <div className="font-mono text-[11px] text-on-surface-variant">{run.id}</div>
        {deploy !== null && <div className="mt-1 font-sans text-xs text-tertiary">{deploy}</div>}
      </div>

      {failed && (
        <Panel tone="terra" eyebrow="Failure record" title={run.status === 'failed' ? 'This run failed' : 'This run recorded an error'} data-testid="failure-record">
          {run.error !== null ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-on-surface">{run.error}</pre>
          ) : (
            <p className="font-sans text-sm text-on-surface-variant">No error text was recorded.</p>
          )}
          {run.resumeStatus !== null && (
            <p className="mt-2 font-sans text-xs text-on-surface-variant">
              {RESUME_TEXT[run.resumeStatus] ?? run.resumeStatus}
              {run.resumeAttempts > 0 ? ` Resumed ${run.resumeAttempts} ${run.resumeAttempts === 1 ? 'time' : 'times'}.` : ''}
            </p>
          )}
        </Panel>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Status" value={run.status} tone={run.status === 'failed' ? 'terra' : run.status === 'completed' ? 'sage' : 'ochre'} />
        <MetricCard label="Started" value={formatRelative(run.startedAt ?? run.completedAt)} sub={formatDateTime(run.startedAt ?? run.completedAt)} />
        <MetricCard label="Duration" value={formatDuration(run.startedAt, run.completedAt)} />
        <MetricCard label="Tokens" value={formatTokens(run.tokensUsed)} sub={formatCost(run.costUsd, run.costSource)} tone="ochre" />
      </div>

      <Panel title="Facts">
        <dl className="grid gap-x-6 gap-y-1 font-sans text-sm sm:grid-cols-2">
          <Fact label="Agent" value={agentName ?? run.agentId} />
          <Fact label="Model" value={run.provider === null && run.model === null ? null : `${run.provider ?? ''}${run.provider && run.model ? ' · ' : ''}${run.model ?? ''}`} />
          <Fact label="Credential" value={run.dispatchedBy} />
          <Fact label="Reasoning" value={run.reasoningLevel} />
          <Fact label="Dry run" value={run.dryRun ? 'yes' : 'no'} />
          <Fact label="Resumable" value={run.resumable ? 'yes' : 'no'} />
          <Fact label="Estimated cost" value={run.estimatedCostUsd === null ? null : formatCost(run.estimatedCostUsd, 'estimated')} />
          <Fact label="Actual cost" value={run.actualCostUsd === null ? null : formatCost(run.actualCostUsd, 'actual')} />
        </dl>
      </Panel>

      <Panel title="Phases" padded={phases !== null && phases.length > 0 ? false : true}>
        {phases === null ? (
          <p className="font-sans text-sm text-on-surface-variant">The run's phase record could not be read.</p>
        ) : phases.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant">No phases recorded.</p>
        ) : (
          <ul className="divide-y divide-outline-variant/10" aria-label="Phases">
            {phases.map((phase) => (
              <li key={phase.name} className="px-5 py-2 font-sans text-sm">
                <div className="flex items-center gap-2">
                  <StatusDot tone={phase.status === 'failed' ? 'terracotta' : phase.status === 'completed' ? 'sage' : phase.status === 'running' ? 'ochre' : 'outline'} />
                  <span className="text-on-surface">{phase.name}</span>
                  <span className="font-mono text-[11px] text-on-surface-variant">{phase.status}</span>
                  <span className="ml-auto font-mono text-[11px] text-on-surface-variant">
                    {phase.turnsUsed !== null ? `${phase.turnsUsed}${phase.allowedMaxTurns !== null ? `/${phase.allowedMaxTurns}` : ''} turns · ` : ''}
                    {formatTokens(phase.tokensUsed)} tok · {formatCost(phase.costUsd, phase.costSource)}
                  </span>
                </div>
                {(phase.capHit || phase.semanticCheckBlocked || phase.postConditionFailed) && (
                  <div className="mt-1 flex gap-2 font-mono text-[10px] uppercase text-tertiary">
                    {phase.capHit && <span>turn cap hit</span>}
                    {phase.semanticCheckBlocked && <span>check blocked</span>}
                    {phase.postConditionFailed && <span>post-condition failed</span>}
                  </div>
                )}
                {phase.summary !== null && <p className="mt-1 text-xs text-on-surface-variant">{phase.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Calls back to this Deployment" padded={toolCalls.length === 0}>
        {toolCalls.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant" data-testid="no-tool-calls">
            This run never reached this Deployment — no tool call and no run route. Nothing it was asked to do landed here.
          </p>
        ) : (
          <ul className="divide-y divide-outline-variant/10" aria-label="Calls back to this Deployment">
            {toolCalls.map((call, i) => (
              <li key={`${call.recordedAt}-${i}`} className="flex items-center gap-2 px-5 py-2 font-sans text-sm">
                <StatusDot tone="sage" />
                <span className="font-mono text-[11px] text-on-surface">{call.tool}</span>
                {call.op !== null && <span className="font-mono text-[11px] text-on-surface-variant">{call.op}</span>}
                <span className="ml-auto font-mono text-[11px] text-on-surface-variant">{formatRelative(call.recordedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Reports">
        {reports.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant">No reports.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Reports">
            {reports.map((report) => (
              <li key={report.id} className="font-sans text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-on-surface-variant">{report.action}</span>
                  <span className="text-on-surface">{report.summary}</span>
                  <span className="ml-auto text-xs text-on-surface-variant">{formatRelative(report.createdAt)}</span>
                </div>
                {report.details !== null && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-on-surface-variant">Details</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-on-surface-variant">{report.details}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 border-b border-outline-variant/10 py-1">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className="truncate text-on-surface">{value ?? '—'}</dd>
    </div>
  );
}
