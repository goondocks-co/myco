import { QUEUE_REASON_WORDS } from '@goondocks/myco-shared/runner-fleet';
import { formatRelative } from '../../lib/format';
import { Button, ConfirmDialog, CopyButton, Disclosure, ErrorState, FactRow, FactsPanel, ItemLink, LoadingState, SlideOver, TypeChip } from '../../design';
import { useState } from 'react';
import { useTaskNames } from '../../hooks/use-tasks';
import { useStarterNames } from './names';
import { runIsLive, useCancelRun, useRunDetail } from '../../hooks/use-work';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CODE_MAP_SUFFIX, projectPath, TASKS_SUFFIX } from '../../routes/nav';
import { agentName, count, failureNextStep, sporeLine, sporeTypeWord } from '../today/words';
import type { RunDetailAnswer } from './wire';
import { ModelSummary, costProvenanceWords } from './ModelSummary';
import { ActivitySection, AgentAccount, FilesReadPart, summaryOf, useAttemptEvidence, useRunCallsOf, type AttemptEvidence } from './RunActivity';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import { InkLink, OnwardLink, PartLabel } from './OutcomeCard';
import {
  atWords, runErrorWords, deployWords, fullErrorWords, dollars, kindOf, queuedWords, ranOn, runNoun, skipWords, startedByWords, tokenWords,
} from './words';

export interface RunPanelProps {
  projectId: string;
  runId: string;
  projectName: string;
  now: number;
  onClose: () => void;
}

/**
 * One run in a panel beside Myco's work: what came of it first, then what it
 * read and what it produced, all as links, and the technical details folded
 * away. On a phone the panel is its own screen.
 */
export function RunPanel({ projectId, runId, projectName, now, onClose }: RunPanelProps) {
  const detail = useRunDetail(projectId, runId);
  const kind = kindOf(detail.data?.run.task ?? null);
  const title = `${kind === null ? 'Run' : capitalize(runNoun(kind))} · ${projectName}`;
  return (
    <SlideOver open onOpenChange={(open) => { if (!open) onClose(); }} title={title} data-testid="run-panel">
      {detail.data !== undefined ? <RunBody key={`${projectId}/${runId}`} answer={detail.data} projectId={projectId} now={now} />
        : detail.isPending ? <LoadingState shape="reading" label="Loading the run" />
        : detail.error instanceof ApiError && detail.error.status === 404
          ? <p role="status" className="t-body text-muted">This run isn’t in {projectName}. It may have been cleared out with older runs.</p>
          : <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
    </SlideOver>
  );
}

/** Who started a run, as the kicker says it: "on its schedule", "started by Ada". */
function startedKicker(words: string): string {
  if (words === 'On its schedule') return 'on its schedule';
  return words.startsWith('By ') ? `started by ${words.slice(3)}` : `started ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function RunBody({ answer, projectId, now }: { answer: RunDetailAnswer; projectId: string; now: number }) {
  const { run, read, produced } = answer;
  const cancel = useCancelRun(projectId, run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const canCancel = run.canCancel === true;
  const kind = kindOf(run.task);
  const name = useStarterNames();
  const failed = run.status === 'failed';
  const finished = run.status === 'completed' || failed;
  const live = runIsLive(run.status);
  const at = run.completedAt ?? run.startedAt ?? run.queuedAt;
  const took = run.startedAt !== null && run.completedAt !== null ? tookWords(run.completedAt - run.startedAt) : null;
  const startedBy = startedByWords(run.startedBy, name);
  const spores = produced.spores;
  const cause = failed ? causeOf(answer) : null;
  const fullError = failed ? fullErrorWords(run.errorCode, ranOn(run.worker, name)?.machine ?? null) : null;
  const deploy = deployWords(run);
  const kept = run.result === 'failed_with_output';
  const calls = useRunCallsOf(projectId, answer);
  const latest = useAttemptEvidence(projectId, answer, calls, answer.attempts.length - 1);
  const summary = summaryOf(latest, answer.attemptCount);
  const ran = finished || live;
  return (
    <article className="flex flex-col gap-s6" data-run-panel={run.status}>
      <header className="flex flex-col gap-s2">
        <h2 className={cn('t-h2', failed && !kept ? 'text-bad' : 'text-ink')} data-run-headline="">{headlineOf(answer)}</h2>
        <p className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
          {at !== null && <span>{capitalize(atWords(at, now))}</span>}
          {took !== null && <><span aria-hidden>·</span><span>took {took}</span></>}
          {startedBy !== null && <><span aria-hidden>·</span><span data-started-by="">{startedKicker(startedBy)}</span></>}
          {deploy !== null && <><span aria-hidden>·</span><span>{deploy}</span></>}
        </p>
        {ran && summary !== null && <p className="t-body text-ink-2" data-run-summary="">{summary}</p>}
        {run.task !== null && <TaskName projectId={projectId} task={run.task} />}
        <ModelSummary run={run} />
        {run.status === 'queued' && <p className="t-small text-ink-2" data-queued="">{(run.fleetWait === undefined ? capitalize(queuedWords(run)) : QUEUE_REASON_WORDS[run.fleetWait.reason]).replace(/\.$/, '')}. Waiting since {run.queuedAt === null ? 'an unavailable time' : formatRelative(run.queuedAt)}.</p>}
        {run.status === 'skipped' && <p className="t-small text-ink-2">Myco held off: {skipWords(run.skipReasonCode ?? run.skipReason)}. Nothing ran, and nothing was spent.</p>}
        {live && (canCancel
          ? <Button size="sm" onClick={() => { setCancelError(null); setConfirmCancel(true); }}>Cancel run</Button>
          : <p className="t-small text-muted">{run.cancelReason ?? 'Run cancellation permission is unavailable. Refresh this run.'}</p>)}
        {cancelError !== null && <p role="alert" className="t-small text-bad">{cancelError}</p>}
      </header>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="The run stops. What it already saved stays."
        confirmLabel="Cancel run"
        confirmDisabled={!canCancel}
        pending={cancel.isPending}
        error={cancel.error instanceof ApiError ? cancel.error.status === 404 ? 'This run has already ended, or you no longer have permission to cancel it.' : 'The server refused to cancel this run.' : cancel.error ? 'Could not reach the server.' : null}
        onConfirm={() => { if (!canCancel) return; cancel.mutate(undefined, { onSuccess: () => setConfirmCancel(false), onError: (error) => {
          if (error instanceof ApiError && error.status === 404) setCancelError('This run has already ended, or you no longer have permission to cancel it.');
        } }); }}
      />

      {cause !== null && (
        <div className="flex flex-col gap-s1 rounded-control border border-line bg-bad-bg px-s3 py-s2 t-small text-ink-2" data-run-failure="">
          <p><span className="font-medium text-bad">Run failure: </span>{cause}</p>
          {fullError !== null && <p className="break-words" data-run-full-error="">{fullError}</p>}
          <p>{kept ? 'What it saved is kept.' : kind === null ? 'Open the technical details below to see where it stopped.' : failureNextStep(kind, false)}</p>
        </div>
      )}

      {(finished || read.total > 0) && <WhatItRead answer={answer} projectId={projectId} now={now} latest={latest} />}

      {finished && (
        <section aria-label="What it produced" className="flex flex-col gap-s3" data-run-produced="">
          <PartLabel end={spores.total > 0 ? count(spores.total, 'spore') : undefined}>What it produced</PartLabel>
          <Produced answer={answer} projectId={projectId} />
        </section>
      )}

      {(ran || calls.rows.length > 0) && <ActivitySection projectId={projectId} answer={answer} calls={calls} latest={latest} live={live} />}
      <AgentAccount projectId={projectId} answer={answer} calls={calls} failed={failed} />
      <Instruction answer={answer} />
      <TechnicalDetails answer={answer} startedBy={startedBy} took={took} />
    </article>
  );
}

/**
 * "What it read": the sessions Myco served it, from Myco's own record, and the files the worker saw it read. A
 * repository task names the source it worked from; neither part ever reads as "read nothing" where its record is
 * missing.
 */
function WhatItRead({ answer, projectId, now, latest }: { answer: RunDetailAnswer; projectId: string; now: number; latest: AttemptEvidence }) {
  const { read, produced } = answer;
  const kind = kindOf(answer.run.task);
  const repositoryTask = kind === 'map' || kind === 'seed';
  const sporesFrom = (sessionId: string) => produced.spores.items.filter((spore) => spore.sessionId === sessionId).length;
  const sessions = !repositoryTask || read.total > 0;
  const files = repositoryTask || latest.files.paths.length + latest.files.unnamed > 0;
  return (
    <section aria-label="What it read" className="flex flex-col gap-s4" data-run-read="">
      <PartLabel>What it read</PartLabel>
      {sessions && (
        <section aria-label="Sessions it read" className="flex flex-col gap-s2" data-run-sessions="">
          <PartLabel end={read.total > 0 ? count(read.total, 'session') : undefined}>Sessions it read</PartLabel>
          {read.recorded && <p className="t-small text-muted">Recorded session reads may be incomplete. Sessions beyond Myco’s recording limit are not listed.</p>}
          {read.recorded && read.total === 0 && <p className="t-small text-muted" data-read-none="">It didn’t need any sessions.</p>}
          {!read.recorded && (
            <p className="t-small text-muted" data-no-record="">
              {read.total === 0
                ? 'No session reads were recorded. This does not mean it read no sessions.'
                : 'No session reads were recorded; these are the sessions it worked from.'}
            </p>
          )}
          {read.sessions.length > 0 && (
            <ul className="flex flex-col gap-s2">
              {read.sessions.map((session) => {
                const from = sporesFrom(session.sessionId);
                return (
                  <li key={session.sessionId} className="flex flex-col t-small">
                    <ItemLink to={projectPath(projectId, `/sessions/${encodeURIComponent(session.sessionId)}`)} className="text-ink-2">{session.title?.trim() || 'Untitled session'}</ItemLink>
                    <span className="t-meta text-muted">
                      {from > 0 ? `${count(from, 'spore')} came from it` : session.readAt === null ? 'Worked from it' : `Read ${atWords(session.readAt, now)}`}
                    </span>
                  </li>
                );
              })}
              {read.total > read.sessions.length && <li className="t-small text-muted">Showing {read.sessions.length} of {read.total.toLocaleString()} sessions; this list covers only those shown</li>}
            </ul>
          )}
        </section>
      )}
      {files && <FilesReadPart evidence={latest} />}
      {repositoryTask && (
        <p className="t-small text-muted" data-run-source="">
          {answer.source === null ? "The source it read wasn't recorded." : `It worked from ${answer.source.branch} @ ${answer.source.commit.slice(0, 7)}.`}
        </p>
      )}
    </section>
  );
}

/** The run's headline: what came of it, or where it stands while it has not finished. */
function headlineOf({ run, read, produced }: RunDetailAnswer): string {
  if (run.errorCode === 'run_cancelled') return 'Cancelled';
  if (run.status === 'skipped') return 'Held off';
  if (run.status === 'queued') return 'Waiting to start';
  if (run.status === 'running' || run.status === 'claimed') return 'Running now';
  if (run.result === 'failed_with_output') return 'Failed with output kept';
  if (run.result === 'failed') return 'This run failed';
  if (run.result === 'unchanged') return 'Checked and changed nothing';
  const kind = kindOf(run.task);
  if ((kind === 'learn' || kind === 'seed') && produced.spores.total > 0) return `Learned ${count(produced.spores.total, 'spore')}${read.total > 0 && kind === 'learn' ? ` from ${count(read.total, 'session')}` : ''}`;
  if (kind === 'title') return 'Titled and summarized a session';
  if (kind === 'map') return 'Updated the code map';
  return 'Wrote output';
}

function causeOf({ run }: RunDetailAnswer): string {
  return runErrorWords(run.errorCode, run.errorReason ?? null);
}

function Produced({ answer, projectId }: { answer: RunDetailAnswer; projectId: string }) {
  const { run, produced, read } = answer;
  const kind = kindOf(run.task);
  const spores = produced.spores;
  if (spores.total > 0) {
    return (
      <>
        <ul className="flex flex-col gap-s2" aria-label="Spores it wrote">
          {spores.items.map((spore) => (
            <li key={spore.id} className="flex min-w-0 items-baseline gap-s3 t-small text-ink-2">
              <TypeChip className="shrink-0">{sporeTypeWord(spore.observationType)}</TypeChip>
              <ItemLink to={projectPath(projectId, `/spores/${encodeURIComponent(spore.id)}`)}>{sporeLine({ agentLine: spore.agentLine, content: '' }) || `A ${sporeTypeWord(spore.observationType).toLowerCase()}`}</ItemLink>
            </li>
          ))}
          {spores.total > spores.items.length && <li className="t-small text-muted">Showing {spores.items.length} of {spores.total.toLocaleString()} spores; this list covers only those shown</li>}
        </ul>
      </>
    );
  }
  if (kind === 'title' && (run.result === 'produced' || run.result === 'failed_with_output') && run.targetSessionId !== null) {
    const titled = read.sessions.find((session) => session.sessionId === run.targetSessionId);
    return (
      <p className="t-small text-ink-2">
        A title and summary for{' '}
        <InkLink to={projectPath(projectId, `/sessions/${encodeURIComponent(run.targetSessionId)}`)}>{titled?.title?.trim() || 'its session'}</InkLink>.
      </p>
    );
  }
  if (kind === 'map' && (run.result === 'produced' || run.result === 'failed_with_output')) {
    return (
      <div className="flex flex-col gap-s1 t-small text-ink-2">
        <p>{answer.source === null ? 'A code map.' : 'A code map from the pinned source.'}</p>
        {answer.map?.replaced && <p className="text-muted">A newer map has replaced this run’s map.</p>}
        <OnwardLink to={projectPath(projectId, CODE_MAP_SUFFIX)}>Open the current code map</OnwardLink>
      </div>
    );
  }
  return <p className="t-small text-muted">{run.result === 'unchanged' ? 'Checked and changed nothing.' : 'Nothing'}{run.status === 'failed' ? '; it stopped before writing anything' : ''}.</p>;
}

function tookWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Machine, agent, model, times, tokens and cost, folded away under one line that already says the most of it. */
function TechnicalDetails({ answer, startedBy, took }: {
  answer: RunDetailAnswer;
  startedBy: string | null;
  took: string | null;
}) {
  const { run } = answer;
  const name = useStarterNames();
  // A machine by its name only when the server names it to this viewer, else as its member's; never by its id.
  const machine = ranOn(run.worker, name)?.machine ?? null;
  const agent = run.harness === null ? null : agentName(run.harness);
  const cost = run.costUsd ?? run.estimatedCostUsd ?? run.actualCostUsd;
  const tokens = run.tokensUsed === null ? null : `${tokenWords(run.tokensUsed)} tokens`;

  const summary = [machine, agent, tokens, cost === null ? null : dollars(cost)].filter((part): part is string => part !== null).join(' · ');
  return (
    <section aria-label="Technical details" className="border-t border-line pt-s4" data-run-technical="">
      <Disclosure summary={<span className="flex flex-wrap items-baseline gap-x-s3">Technical details{summary !== '' && <span className="t-meta font-normal text-muted">{summary}</span>}</span>}>
        <div className="flex flex-col gap-s4 pt-s2">
          <FactsPanel actions={<CopyButton value={run.id} label="Copy run id" variant="secondary" />}>
            {machine !== null && <FactRow term="Ran on">{machine}</FactRow>}
            <FactRow term="Agent">{agent ?? 'Not recorded'}</FactRow>
            <FactRow term="Model"><ModelSummary run={run} variant="details" /></FactRow>
            <FactRow term="Started by">{startedBy === null ? 'Not recorded' : startedBy === 'On its schedule' ? 'Myco’s schedule' : capitalize(startedBy.replace(/^By /, ''))}</FactRow>
            {run.queuedAt !== null && <FactRow term="Queued">{dateWords(run.queuedAt)}</FactRow>}
            {run.queuedAt !== null && run.startedAt !== null && <FactRow term="Queue wait">{tookWords(run.startedAt - run.queuedAt)}</FactRow>}
            {run.completedAt !== null && <FactRow term="Finished">{dateWords(run.completedAt)}</FactRow>}
            {run.startedAt !== null && <FactRow term="Started">{new Date(run.startedAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</FactRow>}
            {took !== null && <FactRow term="Execution">{took}</FactRow>}
            <FactRow term="Tokens">{run.tokensUsed === null ? 'None reported' : run.tokensUsed.toLocaleString()}</FactRow>
            <FactRow term="Cost">{cost === null ? 'Unknown' : <>{dollars(cost)}<span className="block t-meta text-muted">{costProvenanceWords(run.costProvenance)}</span></>}</FactRow>
          </FactsPanel>
          {answer.source !== null ? <p className="break-words t-small text-ink-2">Pinned source: {answer.source.branch} @ {answer.source.commit}</p> : (kindOf(run.task) === 'map' || kindOf(run.task) === 'seed') && <p className="t-small text-muted">Source commit was not recorded for this run.</p>}
          {run.status === 'failed' && run.error !== null && (
            <div className="flex flex-col gap-s1">
              <PartLabel>What the run recorded</PartLabel>
              <p className="whitespace-pre-wrap break-words t-mono text-ink-2">{runErrorWords(run.errorCode, run.errorReason ?? null)}</p>
              <p className="whitespace-pre-wrap break-words t-mono text-ink-2">{run.error}</p>
            </div>
          )}
        </div>
      </Disclosure>
    </section>
  );
}

function dateWords(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function Instruction({ answer }: { answer: RunDetailAnswer }) {
  const prompt = answer.run.instruction === null ? null : redactSecrets(answer.run.instruction);
  const rules = answer.run.instructions === null ? null : redactSecrets(answer.run.instructions);
  const redacted = prompt?.includes('[REDACTED]') || rules?.includes('[REDACTED]');
  return (
    <section aria-label="Instruction at launch">
      <Disclosure summary="Instruction at launch">
        <div className="flex flex-col gap-s3 pt-s2">
          <PartLabel>Prompt</PartLabel>
          {redacted && <p className="t-small text-muted">Access keys and passwords are hidden.</p>}
          {prompt === null ? <p className="t-small text-muted">The prompt was not recorded for this run.</p> : <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words t-mono text-ink-2">{prompt}</pre>}
          <PartLabel>Standing rules</PartLabel>
          {rules === null ? <p className="t-small text-muted">Standing rules were not recorded for this run.</p> : <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words t-mono text-ink-2">{rules}</pre>}
        </div>
      </Disclosure>
    </section>
  );
}

function TaskName({ projectId, task }: { projectId: string; task: string }) {
  const descriptions = useTaskNames(projectId);
  const description = descriptions.data?.tasks.find((entry) => entry.task === task);
  return <div className="flex flex-col gap-s2" data-run-task="">
    <OnwardLink to={`${projectPath(projectId, TASKS_SUFFIX)}#${encodeURIComponent(task)}`}>{description?.name ?? 'About this task'}</OnwardLink>
    {descriptions.isError && <ErrorState error={descriptions.error} onRetry={() => void descriptions.refetch()} />}
  </div>;
}
