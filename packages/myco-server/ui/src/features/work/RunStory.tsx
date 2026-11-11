import { CopyButton, Disclosure, FactRow, FactsPanel, ItemLink } from '../../design';
import { useIsAdmin } from '../../hooks/use-me';
import { useTaskRuns } from '../../hooks/use-work';
import { cn } from '../../lib/cn';
import { runnerPath, runPath } from '../../routes/nav';
import { InkLink, PartLabel } from './OutcomeCard';
import {
  askedRows, callLineWords, clockWords, exactDetails, SOURCE_WORDS, TRY_WINDOW_MS, triesOf, tryResultWords, verdictOf,
  type Source, type StoryRow, type Tone, type Try,
} from './story';
import { atWords } from './words';
import type { RunDetailAnswer, RunPageRow } from './wire';

const SOURCE_ICON: Readonly<Record<Source, string>> = { saw: '●', runner: '◐', agent: '○', inferred: '◇', none: '–' };

/** Whose word a claim rests on, as a small mark beside it. */
export function SourceMark({ source }: { source: Source }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-s1 rounded-control border border-line px-s1 t-meta text-muted" data-source={source}>
      <span aria-hidden>{SOURCE_ICON[source]}</span>{SOURCE_WORDS[source]}
    </span>
  );
}

const toneClass = (tone: Tone): string => (tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-ok' : 'text-ink-2');

function StoryLine({ entry }: { entry: StoryRow }) {
  const admin = useIsAdmin();
  const silent = entry.at === null;
  const words = entry.runner !== null && admin
    ? <>{entry.words.slice(0, entry.words.indexOf(entry.runner.name))}<InkLink to={runnerPath(entry.runner.id)}>{entry.runner.name}</InkLink>{entry.words.slice(entry.words.indexOf(entry.runner.name) + entry.runner.name.length)}</>
    : entry.words;
  return (
    <li className={cn('flex gap-s3 py-s2', silent && 'border-l-2 border-dashed border-line pl-s2')} data-story-row={entry.key} data-story-tone={entry.tone ?? undefined}>
      <span className="shrink-0 t-meta tabular-nums text-muted">{entry.at === null ? <span aria-hidden className="invisible">00:00:00</span> : <time dateTime={new Date(entry.at).toISOString()}>{clockWords(entry.at)}</time>}</span>
      <div className="flex min-w-0 flex-col gap-s1">
        <div className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1">
          <span className={cn('min-w-0 break-words t-small', silent ? 'text-muted' : toneClass(entry.tone))}>{words}</span>
          <SourceMark source={entry.source} />
        </div>
        {entry.note !== null && <p className="t-meta text-muted">{entry.note}</p>}
        {entry.calls !== null && (
          <Disclosure summary={`Show the ${entry.calls.length.toLocaleString()} calls`}>
            <div className="flex flex-col gap-s2 pt-s1">
              <ul className="flex flex-col gap-s1 t-small text-muted">
                {entry.calls.map((call) => <li key={call.id}><span className="tabular-nums">{clockWords(call.recordedAt)}</span> {callLineWords(call)}</li>)}
              </ul>
              <FactsPanel>
                <FactRow term="Myco call" mono>{entry.calls[0]!.tool}{entry.calls[0]!.op === null || entry.calls[0]!.tool.startsWith('/') ? '' : ` / ${entry.calls[0]!.op}`}</FactRow>
              </FactsPanel>
            </div>
          </Disclosure>
        )}
      </div>
    </li>
  );
}

/** "What happened": the run as a story, each line marked with whose word it rests on, then the exact ids and codes. */
export function WhatHappened({ answer, story }: { answer: RunDetailAnswer; story: readonly StoryRow[] }) {
  const exact = exactDetails(answer);
  return (
    <section aria-label="What happened" className="flex flex-col gap-s3" data-run-story="">
      <PartLabel>What happened</PartLabel>
      <ol className="flex flex-col">{story.map((entry) => <StoryLine key={entry.key} entry={entry} />)}</ol>
      <Disclosure summary="Exact ids and codes">
        <div className="pt-s2" data-run-exact="">
          <FactsPanel>
            {exact.map(([term, value]) => (
              <FactRow key={term} term={term}>
                <span className="inline-flex min-w-0 items-center gap-s2"><code className="min-w-0 break-all t-mono">{value}</code><CopyButton value={value} label={`Copy ${term.toLowerCase()}`} compact /></span>
              </FactRow>
            ))}
          </FactsPanel>
        </div>
      </Disclosure>
    </section>
  );
}

/** "Did it do what we asked?": the verdict on its evidence, then what was asked beside what the evidence says. */
export function AskedVersusDid({ answer }: { answer: RunDetailAnswer }) {
  const verdict = verdictOf(answer);
  const rows = askedRows(answer);
  return (
    <section aria-label="Did it do what we asked?" className="flex flex-col gap-s3" data-run-asked="">
      <PartLabel>Did it do what we asked?</PartLabel>
      <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1" data-run-verdict="">
        <span className={cn('t-body font-medium', toneClass(verdict.tone))}>{verdict.words}</span>
        <SourceMark source={verdict.source} />
      </p>
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-line" aria-label="Asked and what the evidence says">
          {rows.map((entry) => (
            <li key={entry.key} data-asked={entry.key} className="flex flex-col gap-s1 py-s2 t-small">
              <span className="font-medium text-ink">{entry.label}</span>
              <span className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1"><span className="break-words text-ink-2"><span className="text-muted">Asked: </span>{entry.asked}</span>{entry.askedSource !== undefined && <SourceMark source={entry.askedSource} />}</span>
              <span className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1"><span className={cn('break-words', toneClass(entry.tone))}><span className="text-muted">Evidence: </span>{entry.evidence}</span><SourceMark source={entry.source} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const asTry = (row: RunPageRow): Try => ({
  id: row.id, completedAt: row.completedAt, status: row.status, result: row.result, runner: runnerOf(row), current: false,
});
const runnerOf = (row: Pick<RunPageRow, 'worker'>): string | null => row.worker?.runner?.name ?? row.worker?.machineName ?? null;

/**
 * "Tries": the runs of the same task and subject right before and after this one, read from the task's run list, when
 * they make one piece of work: failures leading up to it, and after a failure, the nearest later runs up to the first
 * that did not fail.
 */
export function Tries({ answer, projectId, now }: { answer: RunDetailAnswer; projectId: string; now: number }) {
  const { run } = answer;
  const at = run.completedAt;
  const finished = (run.status === 'completed' || run.status === 'failed') && run.task !== null && at !== null;
  const subject = run.subject ?? null;
  const before = useTaskRuns(projectId, run.task ?? '', false, finished, { since: (at ?? 0) - TRY_WINDOW_MS, until: at ?? 0, subject });
  const after = useTaskRuns(projectId, run.task ?? '', false, finished && run.status === 'failed', { since: (at ?? 0) + 1, until: (at ?? 0) + TRY_WINDOW_MS, oldestFirst: true, subject });
  if (!finished || before.data === undefined) return null;
  const current: Try = { id: run.id, completedAt: at, status: run.status, result: run.result, runner: runnerOf(run), current: true };
  const tries = triesOf(current, before.data.rows.map(asTry), after.data === undefined ? null : after.data.rows.map(asTry));
  if (tries.length < 2) return null;
  return (
    <section aria-label="Tries" className="flex flex-col gap-s2" data-run-tries="">
      <PartLabel end={<SourceMark source="inferred" />}>One piece of work, {tries.length.toLocaleString()} tries</PartLabel>
      <ol className="flex flex-col gap-s1">
        {tries.map((entry, index) => {
          const words = `Try ${index + 1}: ${entry.completedAt === null ? 'not finished' : atWords(entry.completedAt, now)} · ${tryResultWords(entry)}${entry.runner === null ? '' : ` · on ${entry.runner}`}`;
          return (
            <li key={entry.id} className="t-small" data-try={entry.current ? 'current' : entry.status}>
              {entry.current ? <span className="text-ink">{words} (this one)</span> : <ItemLink to={runPath(projectId, entry.id)}>{words}</ItemLink>}
            </li>
          );
        })}
      </ol>
      <p className="t-meta text-muted">Linked by project, task and what it worked on: a run of the same work right before or after this one reads as another try.</p>
    </section>
  );
}
