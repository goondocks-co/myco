import { CopyButton, Disclosure, ErrorState, FactRow, FactsPanel, ItemLink, LoadingState, SlideOver, TypeChip } from '../../design';
import { useStarterNames } from './names';
import { useRunDetail } from '../../hooks/use-work';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CODE_MAP_SUFFIX, projectPath } from '../../routes/nav';
import { agentName, count, failureNextStep, sporeLine, sporeTypeWord } from '../today/words';
import type { RunDetailAnswer } from './wire';
import { InkLink, OnwardLink, PartLabel } from './OutcomeCard';
import {
  atWords, failureWords, runErrorWords, deployWords, dollars, kindOf, queuedWords, ranOn, runNoun, skipWords, startedByWords, tokenWords,
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
      {detail.data !== undefined ? <RunBody answer={detail.data} projectId={projectId} now={now} />
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
  const { run, read, produced, reports } = answer;
  const kind = kindOf(run.task);
  const name = useStarterNames();
  const failed = run.status === 'failed';
  const finished = run.status === 'completed' || failed;
  const at = run.completedAt ?? run.startedAt ?? run.queuedAt;
  const took = run.startedAt !== null && run.completedAt !== null ? tookWords(run.completedAt - run.startedAt) : null;
  const startedBy = startedByWords(run.startedBy, name);
  const spores = produced.spores;
  const cause = failed ? causeOf(answer) : null;
  const deploy = deployWords(run);
  const sporesFrom = (sessionId: string) => spores.items.filter((spore) => spore.sessionId === sessionId).length;
  // What the run said it did, in its own words, leads the panel; a failed run's report is its cause instead.
  const report = failed ? null : latestReport(reports);
  return (
    <article className="flex flex-col gap-s6" data-run-panel={run.status}>
      <header className="flex flex-col gap-s2">
        <h2 className={cn('t-h2', failed && spores.total === 0 ? 'text-bad' : 'text-ink')} data-run-headline="">{headlineOf(answer)}</h2>
        <p className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
          {at !== null && <span>{capitalize(atWords(at, now))}</span>}
          {took !== null && <><span aria-hidden>·</span><span>took {took}</span></>}
          {startedBy !== null && <><span aria-hidden>·</span><span data-started-by="">{startedKicker(startedBy)}</span></>}
          {deploy !== null && <><span aria-hidden>·</span><span>{deploy}</span></>}
        </p>
        {run.status === 'queued' && <p className="t-small text-ink-2" data-queued="">{capitalize(queuedWords(run))}.</p>}
        {run.status === 'skipped' && <p className="t-small text-ink-2">Myco held off: {skipWords(run.skipReasonCode ?? run.skipReason)}. Nothing ran, and nothing was spent.</p>}
        {report !== null && <p className="max-w-measure t-body text-ink-2" data-run-report="">{report}</p>}
      </header>

      {cause !== null && (
        <div className="flex flex-col gap-s1 rounded-control border border-line bg-bad-bg px-s3 py-s2 t-small text-ink-2" data-run-failure="">
          <p><span className="font-medium text-bad">Why: </span>{cause}</p>
          <p>{kind === null ? (spores.total > 0 ? 'What it saved is kept, so there’s nothing to do.' : 'Open the technical details below to see where it stopped.') : failureNextStep(kind, spores.total > 0)}</p>
        </div>
      )}

      {(finished || read.total > 0) && (
        <section aria-label="What it read" className="flex flex-col gap-s3" data-run-read="">
          <PartLabel end={read.total > 0 ? count(read.total, 'session') : undefined}>What it read</PartLabel>
          {read.recorded && read.total === 0 && <p className="t-small text-muted" data-read-none="">It didn’t need any sessions.</p>}
          {!read.recorded && (
            <p className="t-small text-muted" data-no-record="">
              {read.total === 0
                ? 'No record of what it read. Myco didn’t record the sessions this run read, which doesn’t mean it read none.'
                : 'No record of what it read; these are the sessions it worked from.'}
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
              {read.total > read.sessions.length && <li className="t-small text-muted">and {(read.total - read.sessions.length).toLocaleString()} more</li>}
            </ul>
          )}
        </section>
      )}

      {finished && (
        <section aria-label="What it produced" className="flex flex-col gap-s3" data-run-produced="">
          <PartLabel end={spores.total > 0 ? count(spores.total, 'spore') : undefined}>What it produced</PartLabel>
          <Produced answer={answer} projectId={projectId} />
        </section>
      )}

      <TechnicalDetails answer={answer} startedBy={startedBy} took={took} now={now} reports={reports} />
    </article>
  );
}

/** The run's headline: what came of it, or where it stands while it has not finished. */
function headlineOf({ run, read, produced }: RunDetailAnswer): string {
  const kind = kindOf(run.task);
  if (run.status === 'skipped') return 'Held off';
  if (run.status === 'queued') return 'Waiting to start';
  if (run.status === 'running' || run.status === 'claimed') return 'Running now';
  const failed = run.status === 'failed';
  const spores = produced.spores.total;
  switch (kind) {
    case 'learn':
    case 'seed':
      if (spores > 0) return `Learned ${count(spores, 'spore')}${read.total > 0 && kind === 'learn' ? ` from ${count(read.total, 'session')}` : ''}`;
      return failed ? (kind === 'learn' ? 'Couldn’t learn from recent sessions' : 'Couldn’t learn from the project’s code') : 'Found nothing new to keep';
    case 'title':
      return failed ? 'Couldn’t title a session' : run.targetSessionId === null ? 'Titled a session' : 'Titled and summarized a session';
    case 'map':
      return failed ? 'Couldn’t update the code map' : 'Updated the code map';
    default:
      return failed ? 'This run failed' : 'This run finished';
  }
}

/** Why a failed run failed: its last report, which names the cause the stored error hides, else the error. */
function causeOf({ run, reports }: RunDetailAnswer): string {
  const report = latestReport(reports);
  return failureWords(report === null ? { source: 'error', code: run.errorCode } : { source: 'report', cause: report });
}

/** The run's latest report in its own words, or null when it filed none. */
function latestReport(reports: RunDetailAnswer['reports']): string | null {
  const report = [...reports].sort((a, b) => b.createdAt - a.createdAt).find((r) => r.summary.trim() !== '');
  return report === undefined ? null : report.summary.trim();
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
          {spores.total > spores.items.length && <li className="t-small text-muted">and {(spores.total - spores.items.length).toLocaleString()} more</li>}
        </ul>
      </>
    );
  }
  if (kind === 'title' && run.status === 'completed' && run.targetSessionId !== null) {
    const titled = read.sessions.find((session) => session.sessionId === run.targetSessionId);
    return (
      <p className="t-small text-ink-2">
        A title and summary for{' '}
        <InkLink to={projectPath(projectId, `/sessions/${encodeURIComponent(run.targetSessionId)}`)}>{titled?.title?.trim() || 'its session'}</InkLink>.
      </p>
    );
  }
  if (kind === 'map' && run.status === 'completed') {
    return (
      <div className="flex flex-col gap-s1 t-small text-ink-2">
        <p>The code map, brought up to the repository’s latest commit.</p>
        <OnwardLink to={projectPath(projectId, CODE_MAP_SUFFIX)}>Open the code map</OnwardLink>
      </div>
    );
  }
  return <p className="t-small text-muted">Nothing{run.status === 'failed' ? '; it stopped before writing anything' : ''}.</p>;
}

function tookWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Machine, agent, model, times, tokens and cost, folded away under one line that already says the most of it. */
function TechnicalDetails({ answer, startedBy, took, now, reports }: {
  answer: RunDetailAnswer;
  startedBy: string | null;
  took: string | null;
  now: number;
  reports: RunDetailAnswer['reports'];
}) {
  const { run, toolCalls } = answer;
  const name = useStarterNames();
  // A machine by its name only when the server names it to this viewer, else as its member's; never by its id.
  const machine = ranOn(run.worker, name)?.machine ?? null;
  const agent = run.harness === null ? null : agentName(run.harness);
  const cost = run.costUsd ?? run.estimatedCostUsd ?? run.actualCostUsd;
  const tokens = run.tokensUsed === null ? null : `${tokenWords(run.tokensUsed)} tokens`;
  const failedCalls = toolCalls.filter((call) => call.failure !== undefined).length;
  const summary = [machine, agent, tokens, cost === null ? null : dollars(cost)].filter((part): part is string => part !== null).join(' · ');
  return (
    <section aria-label="Technical details" className="border-t border-line pt-s4" data-run-technical="">
      <Disclosure summary={<span className="flex flex-wrap items-baseline gap-x-s3">Technical details{summary !== '' && <span className="t-meta font-normal text-muted">{summary}</span>}</span>}>
        <div className="flex flex-col gap-s4 pt-s2">
          <FactsPanel actions={<CopyButton value={run.id} label="Copy run id" variant="secondary" />}>
            {machine !== null && <FactRow term="Ran on">{machine}</FactRow>}
            <FactRow term="Agent">{agent ?? 'Not recorded'}</FactRow>
            <FactRow term="Model">{run.model ?? 'Not recorded for this run'}</FactRow>
            <FactRow term="Started by">{startedBy === null ? 'Not recorded' : startedBy === 'On its schedule' ? 'Myco’s schedule' : capitalize(startedBy.replace(/^By /, ''))}</FactRow>
            {run.startedAt !== null && <FactRow term="Started">{new Date(run.startedAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</FactRow>}
            {took !== null && <FactRow term="Took">{took}</FactRow>}
            <FactRow term="Tokens">{run.tokensUsed === null ? 'None reported' : run.tokensUsed.toLocaleString()}</FactRow>
            <FactRow term="Cost">{cost === null ? 'None reported' : <>{dollars(cost)}<span className="block t-meta text-muted">The agent’s estimate, not a bill</span></>}</FactRow>
            <FactRow term="Steps">{toolCalls.length === 0 ? 'No calls to Myco' : `${count(toolCalls.length, 'call')} to Myco${failedCalls > 0 ? `, ${failedCalls} refused` : ''}`}</FactRow>
          </FactsPanel>
          {reports.length > 1 && (
            <div className="flex flex-col gap-s2">
              <PartLabel>Everything it reported</PartLabel>
              <ul className="flex flex-col gap-s2">
                {reports.map((report, i) => (
                  <li key={`${report.createdAt}-${i}`} className="flex flex-col t-small text-ink-2">
                    <span>{report.summary}</span>
                    <span className="t-meta text-muted">{atWords(report.createdAt, now)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.status === 'failed' && run.error !== null && (
            <div className="flex flex-col gap-s1">
              <PartLabel>What the run recorded</PartLabel>
              <p className="whitespace-pre-wrap break-words t-mono text-ink-2">{runErrorWords(run.errorCode)}</p>
            </div>
          )}
        </div>
      </Disclosure>
    </section>
  );
}
