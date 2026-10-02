import { useMemo, useState } from 'react';
import { Disclosure, ErrorState, FactRow, FactsPanel, LoadingState, ShowMore } from '../../design';
import { useAllRunCalls, useAttemptSteps, type Loaded } from '../../hooks/use-work';
import { cn } from '../../lib/cn';
import { count } from '../today/words';
import {
  attemptActivity, attemptAt, auditChecks, callsByAttempt, coverageOf, coverageWords, ELIDED, filesRead, mycoUnnamed, stepsKnown, summaryWords,
  type ActivityRow, type Coverage, type FilesRead, type RowState,
} from './activity';
import { PartLabel } from './OutcomeCard';
import type { RunAttempt, RunAudit, RunCall, RunDetailAnswer, RunReport, RunStep } from './wire';

/** How many rows a list shows at first, and how many more each "Show more" adds. */
export const ROWS_PER_PAGE = 200;
/** How many files "Files it read" shows at first, and how many more each "Show more" adds. */
const FILES_PER_PAGE = 50;

const NO_STEPS: readonly RunStep[] = [];
const NO_CALLS: readonly RunCall[] = [];

/** One attempt's evidence: its steps, its calls, the list built from both, and how much of it is known. */
export interface AttemptEvidence {
  attempt: RunAttempt | null;
  steps: Loaded<RunStep> & { refetch: () => void };
  calls: readonly RunCall[];
  rows: ActivityRow[];
  coverage: Coverage;
  files: FilesRead;
  /** Whether the worker kept steps and Myco recorded calls, but no step names a call to Myco. */
  unnamedMyco: boolean;
  /** Whether a page of its evidence is still being read. */
  loading: boolean;
}

/** Every call the run made back to Myco, with the page its detail carried as the first. */
export function useRunCallsOf(projectId: string, answer: RunDetailAnswer): Loaded<RunCall> {
  const first = useMemo(() => ({ ...answer.toolCallCoverage, rows: answer.toolCalls }), [answer.toolCallCoverage, answer.toolCalls]);
  return useAllRunCalls(projectId, answer.run.id, first);
}

/**
 * The evidence of the run's attempt at `index`, read only while `enabled`. A run that lists no attempt has one list,
 * of Myco's calls alone.
 */
export function useAttemptEvidence(projectId: string, answer: RunDetailAnswer, calls: Loaded<RunCall>, index: number, enabled = true): AttemptEvidence {
  const attempts = answer.attempts;
  const attempt = attempts[index] ?? null;
  const steps = useAttemptSteps(projectId, answer.run.id, attempt, answer.steps, enabled);
  const failed = steps.error != null;
  const coverage = useMemo(() => coverageOf(attempt, steps.rows.length, steps.complete, failed), [attempt, steps.rows.length, steps.complete, failed]);
  const known = stepsKnown(coverage);
  const lists = useMemo(() => callsByAttempt(calls.rows, attempts).lists, [calls.rows, attempts]);
  const mine = (attempts.length === 0 ? lists[0] : lists[index]) ?? NO_CALLS;
  const knownSteps = known ? steps.rows : NO_STEPS;
  const rows = useMemo(() => attemptActivity(mine, knownSteps, answer.run.harness), [mine, knownSteps, answer.run.harness]);
  const files = useMemo(() => filesRead(knownSteps), [knownSteps]);
  return {
    attempt, steps, calls: mine, rows, coverage, files, unnamedMyco: mycoUnnamed(coverage, knownSteps, mine),
    loading: steps.pending || calls.pending,
  };
}

/** The panel's summary line for the run's latest attempt, or null until its evidence is read. */
export function summaryOf(evidence: AttemptEvidence, attemptCount: number): string | null {
  if (evidence.loading) return null;
  const words = summaryWords(evidence.rows, stepsKnown(evidence.coverage), evidence.files);
  if (words === null || attemptCount <= 1) return words;
  return `In its last of ${attemptCount.toLocaleString()} attempts: ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

const STATE_WORDS: Readonly<Record<RowState, string>> = {
  ok: 'Succeeded', failed: 'Failed', refused: 'Not allowed', unfinished: 'Didn’t finish', unknown: 'Status not recorded',
};

const KIND_WORDS: Readonly<Record<RunStep['kind'], string>> = {
  read: 'Read', search: 'Search', edit: 'Edit', command: 'Command', fetch: 'Online lookup', myco: 'Call to Myco', tool: 'Other tool',
};

function timeWords(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function seenBy(row: ActivityRow): string {
  if (row.call !== null && row.step !== null) return 'Myco and the worker';
  return row.call !== null ? 'Myco only' : 'The worker only';
}

function Row({ row }: { row: ActivityRow }) {
  const failed = row.state === 'failed' || row.state === 'refused';
  return (
    <li className="flex min-w-0 flex-col gap-s1 px-s3 py-s2 t-small text-ink-2" data-activity-row={row.state} data-activity-seen={row.call !== null && row.step !== null ? 'both' : row.call !== null ? 'myco' : 'worker'}>
      <span className="min-w-0 break-words">{row.lead}{row.target !== null && <> <code className="t-mono break-all text-ink">{row.target}</code></>}</span>
      <span className="t-meta text-muted">
        <time dateTime={new Date(row.at).toISOString()}>{timeWords(row.at)}</time>
        {' · '}{row.durationMs === null ? 'Duration not recorded' : `${row.durationMs.toLocaleString()} ms`}
        {' · '}<span className={failed ? 'text-bad' : 'text-muted'}>{STATE_WORDS[row.state]}</span>
        {row.retried && ' · tried again, and it worked'}
        {!row.retried && row.laterSuccess && ' · a later call to the same operation succeeded'}
      </span>
      {row.reason !== null && <p className={cn('whitespace-pre-wrap break-words', failed ? 'text-bad' : 'text-muted')}>{row.reason}</p>}
      <Disclosure summary="Technical details">
        <FactsPanel>
          <FactRow term="Seen by">{seenBy(row)}</FactRow>
          {row.step !== null && <FactRow term="Kind">{KIND_WORDS[row.step.kind]}</FactRow>}
          {row.step !== null && <FactRow term="Tool" mono>{row.step.tool}</FactRow>}
          {row.call !== null && <FactRow term="Myco call" mono>{row.call.tool}{row.call.op === null ? '' : ` / ${row.call.op}`}</FactRow>}
          {row.step?.target != null && <FactRow term="Target" mono>{row.step.target}</FactRow>}
          {row.step !== null && <FactRow term="Step">{(row.step.seq + 1).toLocaleString()}</FactRow>}
          {row.step?.callId != null && <FactRow term="Call id" mono>{row.step.callId}</FactRow>}
          {row.step?.exitCode != null && <FactRow term="Exit code">{row.step.exitCode}</FactRow>}
          {row.call?.failure !== undefined && <FactRow term="Failure code" mono>{row.call.failure.code}</FactRow>}
        </FactsPanel>
      </Disclosure>
    </li>
  );
}

/** A list of rows a page at a time; the count and "Show more" appear only while rows remain unshown. */
function Rows({ rows, noun }: { rows: readonly ActivityRow[]; noun: string }) {
  const [shown, setShown] = useState(ROWS_PER_PAGE);
  return (
    <>
      <ol className="flex flex-col divide-y divide-line rounded-control border border-line" aria-label="Steps">
        {rows.slice(0, shown).map((row) => <Row key={row.key} row={row} />)}
      </ol>
      {rows.length > shown && <ShowMore shown={shown} total={rows.length} noun={noun} onMore={() => setShown((n) => n + ROWS_PER_PAGE)} />}
    </>
  );
}

/** One attempt's list: what its coverage is, then its rows a page at a time with the true total. */
function AttemptList({ evidence, live }: { evidence: AttemptEvidence; live: boolean }) {
  const { rows, coverage, steps } = evidence;
  return (
    <div className="flex flex-col gap-s3" data-attempt-list="">
      <div className="flex flex-col gap-s1 t-small text-muted" data-coverage={coverage.state}>
        {coverageWords(coverage, live, evidence.unnamedMyco).map((words) => <p key={words}>{words}</p>)}
      </div>
      {steps.error != null && <ErrorState error={steps.error} onRetry={steps.refetch} />}
      {evidence.loading ? <LoadingState shape="reading" label="Loading what it did" /> : rows.length === 0 ? (
        <p className="t-small text-muted" data-activity-none="">{stepsKnown(coverage) ? 'Neither Myco nor the worker recorded a step.' : 'Myco recorded no calls.'}</p>
      ) : <Rows rows={rows} noun={stepsKnown(coverage) ? 'steps' : 'calls'} />}
    </div>
  );
}

/** An earlier attempt, read once it is opened. */
function EarlierAttempt({ projectId, answer, calls, index, live }: { projectId: string; answer: RunDetailAnswer; calls: Loaded<RunCall>; index: number; live: boolean }) {
  const evidence = useAttemptEvidence(projectId, answer, calls, index);
  return <AttemptList evidence={evidence} live={live} />;
}

/** Why an attempt gave way to the next: a claimed run returns to the queue only when its worker stops checking in. */
function replacedWords(next: RunAttempt): string {
  return `It stopped checking in, so Myco gave the run to a new attempt at ${timeWords(next.claimedAt)}.`;
}

/** The calls Myco recorded before every attempt the run lists, from attempts past the latest it serves. */
function UnplacedCalls({ rows }: { rows: readonly ActivityRow[] }) {
  return (
    <div className="flex flex-col gap-s2" data-attempt="unplaced">
      <p className="t-small text-muted">{count(rows.length, 'call')} Myco recorded before the attempts listed here; which attempt made {rows.length === 1 ? 'it' : 'them'} isn’t listed.</p>
      <Rows rows={rows} noun="calls" />
    </div>
  );
}

/**
 * "What it did": one list per attempt, Myco's calls and the worker's steps merged, the latest attempt open and each
 * earlier one folded until it is opened.
 */
export function ActivitySection({ projectId, answer, calls, latest, live }: { projectId: string; answer: RunDetailAnswer; calls: Loaded<RunCall>; latest: AttemptEvidence; live: boolean }) {
  const attempts = answer.attempts;
  const end = latest.loading ? undefined : count(latest.rows.length, stepsKnown(latest.coverage) ? 'step' : 'call');
  const unplaced = useMemo(() => attemptActivity(callsByAttempt(calls.rows, attempts).unplaced, [], answer.run.harness), [calls.rows, attempts, answer.run.harness]);
  return (
    <section aria-label="What it did" className="flex flex-col gap-s3" data-run-calls="">
      <PartLabel end={attempts.length > 1 ? count(answer.attemptCount, 'attempt') : end}>What it did</PartLabel>
      {!calls.complete && !calls.pending && <p className="t-small text-muted">Only the first {calls.rows.length.toLocaleString()} of the {count(answer.toolCallCoverage.total, 'call')} Myco recorded are loaded.</p>}
      {calls.error != null && <ErrorState error={calls.error} />}
      {unplaced.length > 0 && <UnplacedCalls rows={unplaced} />}
      {attempts.length <= 1 ? <AttemptList evidence={latest} live={live} /> : (
        <ol className="flex flex-col gap-s4" aria-label="Attempts">
          {answer.attemptCount > attempts.length && <li className="t-small text-muted">Showing the latest {attempts.length.toLocaleString()} of {count(answer.attemptCount, 'attempt')}.</li>}
          {attempts.map((attempt, index) => {
            const last = index === attempts.length - 1;
            const heading = `Attempt ${(answer.attemptCount - attempts.length + index + 1).toLocaleString()} of ${answer.attemptCount.toLocaleString()} · started ${timeWords(attempt.claimedAt)}`;
            return (
              <li key={attempt.attemptId} className="flex flex-col gap-s2" data-attempt={last ? 'latest' : 'replaced'}>
                {last ? <>
                  <h4 className="t-small font-medium text-ink">{heading}</h4>
                  <AttemptList evidence={latest} live={live} />
                </> : <>
                  <Disclosure summary={<span>{heading} · replaced</span>}>
                    <EarlierAttempt projectId={projectId} answer={answer} calls={calls} index={index} live={false} />
                  </Disclosure>
                  <p className="t-small text-muted" data-attempt-replaced="">{replacedWords(attempts[index + 1]!)}</p>
                </>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** "Files it read": the files the worker saw read, never a claim of none where its steps are missing or partial. */
export function FilesReadPart({ evidence }: { evidence: AttemptEvidence }) {
  const [shown, setShown] = useState(FILES_PER_PAGE);
  const { files, coverage } = evidence;
  const read = files.paths.length + files.unnamed;
  const known = stepsKnown(coverage);
  return (
    <section aria-label="Files it read" className="flex flex-col gap-s2" data-run-files={coverage.state}>
      <PartLabel end={known && read > 0 ? count(read, 'file') : undefined}>Files it read</PartLabel>
      {evidence.loading ? <p className="t-small text-muted">Loading its steps…</p>
        : coverage.state === 'unavailable' ? <p className="t-small text-muted" data-files-unknown="">
          {coverage.reason === 'unloaded'
            ? 'Which files it read isn’t known: its step log couldn’t be loaded.'
            : 'Which files it read isn’t recorded: Myco kept no step log for this run. This doesn’t mean it read none.'}
        </p>
        : coverage.state === 'pending' ? <p className="t-small text-muted" data-files-unknown="">Which files it read isn’t known yet: the worker’s step log hasn’t arrived.</p>
        : read === 0 ? <p className="t-small text-muted" data-files-none="">{coverage.state === 'complete' ? 'The worker saw no file reads. Searches and commands are listed under what it did.' : 'The worker saw no file reads in the steps it could list, but its step log is incomplete, so it may have read files.'}</p>
        : <>
          <ul className="flex flex-col gap-s1">
            {files.paths.slice(0, shown).map((path) => <li key={path} className="min-w-0 break-all t-mono text-ink-2">{path}</li>)}
          </ul>
          {files.paths.length > shown && <ShowMore shown={shown} total={files.paths.length} noun="files" onMore={() => setShown((n) => n + FILES_PER_PAGE)} />}
          {files.unnamed > 0 && <p className="t-small text-muted">{count(files.unnamed, 'more read')} named a file whose name Myco doesn’t keep.</p>}
          {coverage.state === 'partial' && <p className="t-small text-muted">Its step log is incomplete, so it may have read more.</p>}
        </>}
    </section>
  );
}

/** "1 entry isn't a file path, so it isn't shown." */
function elidedWords(n: number, noun: 'path' | 'command'): string {
  const one = n === 1;
  const what = noun === 'path' ? (one ? 'isn’t a file path' : 'aren’t file paths') : (one ? 'keeps no word of a command' : 'keep no word of a command');
  return `${count(n, 'entry', 'entries')} ${what}, so ${one ? 'it isn’t' : 'they aren’t'} shown.`;
}

/** A list of paths or commands from the agent's account; the entries kept only as `…` are counted in words. */
function ListPart({ label, items, noun }: { label: string; items: readonly string[]; noun: 'path' | 'command' }) {
  const kept = items.filter((item) => item.replaceAll(ELIDED, '').trim() !== '');
  const elided = items.length - kept.length;
  return (
    <div className="flex flex-col gap-s1">
      <PartLabel end={items.length > 0 ? items.length.toLocaleString() : undefined}>{label}</PartLabel>
      {items.length === 0 ? <p className="t-small text-muted">None listed.</p> : <>
        {kept.length > 0 && (
          <ul className="flex flex-col gap-s1">
            {kept.map((item, i) => <li key={i} className="min-w-0 break-all t-mono text-ink-2">{item}</li>)}
          </ul>
        )}
        {elided > 0 && <p className="t-small text-muted" data-account-elided="">{elidedWords(elided, noun)}</p>}
      </>}
    </div>
  );
}

/** The agent's account of a pass, in plain words. */
function Account({ audit }: { audit: RunAudit }) {
  return (
    <div className="flex flex-col gap-s3 rounded-control border border-line p-s3" data-run-account="">
      <div className="flex flex-col gap-s1">
        <PartLabel>What it says it did</PartLabel>
        <ol className="flex list-decimal flex-col gap-s1 pl-s5 t-small text-ink-2">
          {audit.steps.map((step, i) => <li key={i} className="break-words">{step}</li>)}
        </ol>
      </div>
      <ListPart label="Files it says it examined" items={audit.examined} noun="path" />
      <ListPart label="Commands it says it ran" items={audit.commands} noun="command" />
      <div className="flex flex-col gap-s1">
        <PartLabel end={audit.failures.length > 0 ? audit.failures.length.toLocaleString() : undefined}>What it says went wrong</PartLabel>
        {audit.failures.length === 0 ? <p className="t-small text-muted">None listed.</p> : (
          <ul className="flex flex-col gap-s2">
            {audit.failures.map((failure, i) => (
              <li key={i} className="flex flex-col t-small text-ink-2">
                <span className="break-words">{failure.what}</span>
                <span className="break-words text-muted">{failure.recovery === '' ? 'No recovery given.' : `Recovered: ${failure.recovery}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-s1">
        <PartLabel>Why it ended as it did</PartLabel>
        <p className="whitespace-pre-wrap break-words t-small text-ink-2">{audit.reasoning}</p>
      </div>
      {audit.omitted > 0 && <p className="t-small text-muted">{count(audit.omitted, 'more entry', 'more entries')} of its account {audit.omitted === 1 ? 'was' : 'were'} past what Myco keeps.</p>}
    </div>
  );
}

const CHECKS_LABEL = 'Its account against what was seen';

/** The account checked against the attempt it closed; one Myco can't place against an attempt is not checked. */
function Checks({ projectId, answer, calls, report, audit }: { projectId: string; answer: RunDetailAnswer; calls: Loaded<RunCall>; report: RunReport; audit: RunAudit }) {
  const index = answer.attempts.length === 0 ? 0 : attemptAt(answer.attempts, report.createdAt);
  if (index < 0) {
    return (
      <section aria-label={CHECKS_LABEL} className="flex flex-col gap-s2" data-audit-checks="unplaced">
        <PartLabel>{CHECKS_LABEL}</PartLabel>
        <p className="t-small text-muted" data-audit-check="unsettled">Can’t compare: Myco can’t tell which attempt this account closed.</p>
      </section>
    );
  }
  return <PlacedChecks projectId={projectId} answer={answer} calls={calls} index={index} audit={audit} />;
}

function PlacedChecks({ projectId, answer, calls, index, audit }: { projectId: string; answer: RunDetailAnswer; calls: Loaded<RunCall>; index: number; audit: RunAudit }) {
  const evidence = useAttemptEvidence(projectId, answer, calls, index);
  const { loading, rows, coverage } = evidence;
  const steps = evidence.steps.rows;
  const checks = useMemo(() => (loading ? [] : auditChecks(audit, rows, steps, coverage)), [loading, audit, rows, steps, coverage]);
  const flags = checks.filter((check) => check.verdict === 'flag').length;
  return (
    <section aria-label={CHECKS_LABEL} className="flex flex-col gap-s2" data-audit-checks={loading ? 'loading' : flags > 0 ? 'flagged' : 'clear'}>
      <PartLabel end={flags > 0 ? count(flags, 'mismatch', 'mismatches') : undefined}>{CHECKS_LABEL}</PartLabel>
      {loading ? <p className="t-small text-muted">Checking…</p> : checks.length === 0 ? (
        <p className="t-small text-muted">Nothing in its account disagrees with what Myco and the worker saw.</p>
      ) : (
        <ul className="flex flex-col gap-s1">
          {checks.map((check) => (
            <li key={check.words} className={cn('break-words t-small', check.verdict === 'flag' ? 'text-bad' : 'text-muted')} data-audit-check={check.verdict}>{check.words}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The agent's reports, each with its account and that account's checks; a report that owed an account and carries none says so. */
export function AgentAccount({ projectId, answer, calls, failed }: { projectId: string; answer: RunDetailAnswer; calls: Loaded<RunCall>; failed: boolean }) {
  const { reports } = answer;
  if (reports.length === 0) return null;
  const owed = answer.attemptCount > 0;
  return (
    <section aria-label="The agent’s report" className="flex flex-col gap-s3">
      <PartLabel>The agent’s report</PartLabel>
      {reports.map((report, index) => (
        <div key={index} className="flex flex-col gap-s2 t-small text-ink-2">
          {failed && <span className="font-medium">The agent said:</span>}
          <p data-run-report="">{report.summary}</p>
          <time className="t-meta text-muted" dateTime={new Date(report.createdAt).toISOString()}>{timeWords(report.createdAt)}</time>
          {report.audit !== null ? <>
            <Account audit={report.audit} />
            <Checks projectId={projectId} answer={answer} calls={calls} report={report} audit={report.audit} />
          </> : owed && <p className="text-muted" data-account-missing="">This report carries no account of how it did the task.</p>}
          {report.details !== null && <Disclosure summary="Report details"><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words t-mono">{report.details}</pre></Disclosure>}
        </div>
      ))}
    </section>
  );
}
