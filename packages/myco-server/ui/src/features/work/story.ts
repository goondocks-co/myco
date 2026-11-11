import { EFFORT_UNAPPLIED, profileModelVerdict } from '@goondocks/myco-shared/execution-profile';
import { holdSentence } from '@goondocks/myco-shared/run-holds';
import { callStepWords, callWords } from './call-words';
import { displayModel } from './ModelSummary';
import { count } from '../today/words';
import type { RunAttempt, RunCall, RunCloseEvidence, RunDetailAnswer, RunPageRow, RunReport, RunStep } from './wire';

/**
 * Whose word a claim on the run panel rests on: the server writing it as it happened, the runner's own record, the
 * agent's account, a rule Myco applied, or nothing recorded at all.
 */
export type Source = 'saw' | 'runner' | 'agent' | 'inferred' | 'none';

export const SOURCE_WORDS: Readonly<Record<Source, string>> = {
  saw: 'Myco saw', runner: 'Runner reports', agent: 'The agent says', inferred: 'Myco inferred', none: 'Not recorded',
};

/** A gap longer than this between two things Myco knows of reads as silence. */
export const SILENCE_MS = 60_000;

export type Tone = 'good' | 'bad' | 'warn' | null;

/** One line of "What happened": when, what, on whose word, and the calls it stands for where it groups several. */
export interface StoryRow {
  key: string;
  at: number | null;
  words: string;
  source: Source;
  tone: Tone;
  note: string | null;
  /** The runner a claim names, linked where the reader may open it. */
  runner: { id: string; name: string } | null;
  /** The calls a grouped row stands for. */
  calls: readonly RunCall[] | null;
}

/** "6 min 46 s", "90 s" → "1 min 30 s", "2 h 5 min". */
export function spanWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function clockWords(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

const row = (over: Partial<StoryRow> & Pick<StoryRow, 'key' | 'words' | 'source'>): StoryRow => ({ at: null, tone: null, note: null, runner: null, calls: null, ...over });

/** One call in reader words: what it was, what its recorded step did where Myco has words for it, and how long it took. */
export function callLineWords(call: RunCall): string {
  const step = call.tool.startsWith('/') ? callStepWords(call.tool, call.op) : null;
  return `${callWords(call.tool, call.op)}${step === null ? '' : `: ${step}`}${call.durationMs === null ? '' : ` · took ${durationWords(call.durationMs)}`}`;
}

/** Whether a call's record kept what it did or how long it took. */
const callRecorded = (call: RunCall): boolean => call.op !== null || call.durationMs !== null || call.result !== undefined;

function durationWords(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** Consecutive calls that read the same and answered the same, oldest first. */
function callGroups(calls: readonly RunCall[]): RunCall[][] {
  const groups: RunCall[][] = [];
  for (const call of [...calls].sort((a, b) => a.recordedAt - b.recordedAt || a.id - b.id)) {
    const last = groups.at(-1)?.[0];
    if (last !== undefined && callWords(last.tool, last.op) === callWords(call.tool, call.op) && last.status === call.status) groups.at(-1)!.push(call);
    else groups.push([call]);
  }
  return groups;
}

/** The calls "What happened" lists as one grouped row; "What it did" leaves them to it. */
export function groupedCallIds(calls: readonly RunCall[]): ReadonlySet<number> {
  return new Set(callGroups(calls).filter((group) => group.length > 1).flat().map((call) => call.id));
}

/** Calls in a row that read the same and answered the same collapse into one row with a count and a time span. */
function groupCalls(calls: readonly RunCall[]): StoryRow[] {
  return callGroups(calls).map((group) => {
    const first = group[0]!;
    const end = group.at(-1)!;
    const lead = callWords(first.tool, first.op);
    const failed = first.status === 'failed';
    const many = group.length > 1;
    const words = `${lead}${many ? ` ${group.length} times, ${clockWords(first.recordedAt)} to ${clockWords(end.recordedAt)}` : ''}${failed ? (many ? '; Myco answered each with a failure' : '; Myco answered with a failure') : ''}`;
    const unnamed = first.tool.startsWith('/') && !group.some(callRecorded);
    const single = !many && first.tool.startsWith('/') && callRecorded(first) ? callLineWords(first) : null;
    return row({
      key: `calls-${first.id}`, at: first.recordedAt, words, source: 'saw', tone: failed ? 'bad' : null, calls: many ? group : null,
      note: unnamed ? `What ${many ? 'each call' : 'the call'} did and how long it took ${many ? 'were' : 'was'} not recorded.` : single !== lead ? single : null,
    });
  });
}

/** What Myco said held a run while it waited in the queue, quoted; null where no hold was recorded. */
function waitedNote(hold: string | null | undefined): string | null {
  const sentence = holdSentence(hold ?? null);
  return sentence === null ? null : `While it waited, Myco said: “${sentence}”`;
}

function claimRows(attempts: readonly RunAttempt[], attemptCount: number | null, memberName: (id: string) => string | null): StoryRow[] {
  const total = attemptCount ?? attempts.length;
  return attempts.flatMap((attempt, index) => {
    const ordinal = total - attempts.length + index + 1;
    const position = total > 1 ? ` (attempt ${ordinal.toLocaleString()} of ${total.toLocaleString()})` : '';
    // The first attempt's wait begins at "Queued"; a later attempt's began when the run went back to the queue.
    const requeued = ordinal > 1 && typeof attempt.waitedSince === 'number'
      ? [row({ key: `requeued-${attempt.attemptId}`, at: attempt.waitedSince, words: 'Back in the queue', source: 'saw', note: waitedNote(attempt.waitedFor) })]
      : [];
    if (attempt.executor.kind === 'runner') {
      const name = attempt.executor.name ?? 'a runner';
      return [...requeued, row({ key: `claim-${attempt.attemptId}`, at: attempt.claimedAt, words: `Claimed by ${name}${position}`, source: 'saw', runner: { id: attempt.executor.runnerId, name } })];
    }
    const member = attempt.executor.memberId === null ? null : memberName(attempt.executor.memberId);
    return [...requeued, row({ key: `claim-${attempt.attemptId}`, at: attempt.claimedAt, words: `Claimed by ${member === null ? 'a member’s machine' : `${member}’s machine`}${position}`, source: 'saw' })];
  });
}

function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '')?.trim() ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function reportRows(reports: readonly RunReport[]): StoryRow[] {
  return reports.map((report, index) => row({ key: `report-${index}`, at: report.createdAt, words: `Reported: ${firstLine(report.summary)}`, source: 'agent' }));
}

export interface StoryInput {
  answer: RunDetailAnswer;
  calls: readonly RunCall[];
  /** The latest attempt's steps, where its step log is known. */
  steps: readonly RunStep[] | null;
  /** Whether every call Myco recorded is loaded; a gap measured against a partial list could be closed by a later page. */
  callsComplete: boolean;
  /** Who started it, as the kicker says it ("on its schedule"), or null. */
  startedBy: string | null;
  /** Why it failed, in reader words. */
  cause: string;
  memberName: (id: string) => string | null;
  now: number;
}

/**
 * Codes Myco applies by rule when a run goes quiet, never from anything the machine said. Where Myco kept the latest
 * renewal of the run's hold, each names how long Myco heard nothing from the run (no call, step, report or renewal)
 * before it ended it; where it did not, renewals it was not keeping may have come, so only the calls are measured.
 */
const INFERRED_END: Readonly<Record<string, (quiet: number | null, renewalKept: boolean) => { words: string; note: string }>> = {
  machine_unresponsive: (quiet, kept) => ({
    words: `${quiet === null ? 'Its time limit passed' : kept ? `Myco heard nothing for ${spanWords(quiet)} and its time limit passed` : `No call for ${spanWords(quiet)}, past its time limit`}, so Myco ended it`,
    note: 'Myco ends any run still open past its time limit. That the limit passed is all Myco knows: whether the machine stopped is not known.',
  }),
  lease_lapsed: (quiet, kept) => ({
    words: `${quiet === null || !kept ? 'Its hold on the run ran out' : `Myco heard nothing for ${spanWords(quiet)} and its hold on the run ran out`}, so Myco ended it`,
    note: 'Myco reads this from the hold running out. Why it ran out is not known.',
  }),
};

/** Whether Myco ended the run by a rule rather than on anything the machine said. */
export function inferredEnd(code: string | null | undefined): boolean {
  return INFERRED_END[code ?? ''] !== undefined;
}

/**
 * "What happened", in order: queued, how long it waited and what held it, claimed, the calls Myco saw grouped, the
 * runner's steps, the agent's reports, the latest renewal of its hold, any silence longer than a minute, then how it
 * ended. Myco keeps only the latest renewal, so no silence is claimed before it: the machine may have renewed then.
 */
export function runStory({ answer, calls, callsComplete, steps, startedBy, cause, memberName, now }: StoryInput): StoryRow[] {
  const { run } = answer;
  const timed: StoryRow[] = [];
  if (run.queuedAt !== null) timed.push(row({ key: 'queued', at: run.queuedAt, words: startedBy === null ? 'Queued' : `Queued, ${startedBy}`, source: 'saw' }));
  const claims = claimRows(answer.attempts, answer.attemptCount, memberName);
  if (claims.length > 0) timed.push(...claims);
  else if (run.startedAt !== null) timed.push(row({ key: 'started', at: run.startedAt, words: 'Started', source: 'saw' }));
  timed.push(...groupCalls(calls));
  const stepEnd = steps === null || steps.length === 0 ? null : Math.max(...steps.map((step) => step.endedAt ?? step.startedAt));
  if (steps !== null && steps.length > 0) {
    timed.push(row({
      key: 'steps', at: steps[0]!.startedAt, words: `${count(steps.length, 'step')} on the machine`, source: 'runner',
      note: 'From the runner’s step log, on the runner’s clock. Each is listed under “What it did”.',
    }));
  }
  timed.push(...reportRows(answer.reports));
  const renewed = run.lastRenewedAt ?? null;
  if (renewed !== null) {
    timed.push(row({ key: 'renewed', at: renewed, words: 'Last renewed its hold on this run', source: 'saw',
      note: 'The machine renews its hold while it works on the run. Myco keeps only the latest renewal.' }));
  }
  timed.sort((a, b) => a.at! - b.at!);

  const story: StoryRow[] = [];
  let heard: number | null = null;
  /** The last thing Myco heard other than a renewal: what "no call to Myco" on a live run is measured from. */
  let called: number | null = null;
  const silence = (until: number, key: string) => {
    if (!callsComplete || heard === null || until - heard <= SILENCE_MS || (renewed !== null && until <= renewed)) return;
    // Without a recorded renewal, a gap in the calls is not known to be silence: the machine may have renewed its hold.
    story.push(renewed === null ? row({
      key, words: `No call, step or report for ${spanWords(until - heard)}`, source: 'saw',
      note: 'Renewals of its hold were not recorded for this run, so whether its machine stayed in touch in this time is not known.',
    }) : row({
      key, words: `Silence for ${spanWords(until - heard)}`, source: 'saw',
      note: 'Myco heard nothing from this run in this time: no call, step, report or renewal of its hold.',
    }));
  };
  const first = answer.attempts.length > 0 && (answer.attemptCount ?? answer.attempts.length) === answer.attempts.length ? answer.attempts[0]! : null;
  for (const entry of timed) {
    const before = story.at(-1)?.key ?? '';
    if ((before === 'queued' || before.startsWith('requeued-')) && heard !== null) {
      // Time in the queue is a wait, never a silence.
      if (entry.at! - heard > SILENCE_MS) story.push(row({ key: before === 'queued' ? 'waited' : `waited-${before}`, words: `Waited ${spanWords(entry.at! - heard)} to be taken`, source: 'saw', note: before === 'queued' ? waitedNote(first?.waitedFor) : null }));
    } else silence(entry.at!, `silence-${entry.key}`);
    story.push(entry);
    const covered = entry.key === 'steps' ? stepEnd! : entry.calls?.at(-1)?.recordedAt ?? entry.at!;
    heard = heard === null ? covered : Math.max(heard, covered);
    if (entry.key !== 'renewed') called = called === null ? covered : Math.max(called, covered);
  }

  const latest = answer.attempts.at(-1);
  const live = run.status === 'running' || run.status === 'claimed';
  const stepLogMissing = latest !== undefined && latest.steps === null;
  if (live) {
    if (callsComplete && called !== null && now - called > SILENCE_MS) story.push(row({ key: 'quiet', words: `No call to Myco for ${spanWords(now - called)} so far`, source: 'saw' }));
    if (stepLogMissing) story.push(row({ key: 'no-steps', words: 'What it is doing on the machine isn’t visible yet', source: 'none', note: 'The runner sends its step log when the attempt ends.' }));
    return story;
  }
  const ended = run.completedAt;
  if (ended === null) return story;
  silence(ended, 'silence-end');
  const inferred = run.status === 'failed' ? INFERRED_END[run.errorCode ?? ''] : undefined;
  if (inferred !== undefined) {
    const said = inferred(heard === null || !callsComplete ? null : ended - heard, renewed !== null);
    story.push(row({ key: 'inferred', at: ended, words: said.words, source: 'inferred', tone: 'bad', note: said.note }));
  }
  story.push(endRow(answer, ended, inferred !== undefined, cause));
  if (stepLogMissing && (run.status === 'completed' || run.status === 'failed')) {
    story.push(row({ key: 'no-steps', words: 'The runner’s step log never arrived', source: 'none', note: 'A runner sends its step log when the attempt ends; none reached Myco for this one.' }));
  }
  return story;
}

function endRow({ run, reports }: RunDetailAnswer, at: number, inferred: boolean, cause: string): StoryRow {
  const noReport = reports.length === 0 ? '. No report filed' : '';
  if (run.errorCode === 'run_cancelled') return row({ key: 'end', at, words: 'Cancelled', source: 'saw', tone: 'bad' });
  if (run.status === 'skipped') return row({ key: 'end', at, words: 'Held off: nothing ran', source: 'saw' });
  if (run.status === 'failed') {
    const kept = run.result === 'failed_with_output' ? '. What it wrote is kept' : '';
    return row({ key: 'end', at, words: inferred ? `Ended as failed${noReport}${kept}` : `Failed: ${cause.replace(/\.$/, '')}${kept}`, source: 'saw', tone: 'bad' });
  }
  if (run.result === 'unchanged') return row({ key: 'end', at, words: 'Completed, and changed nothing', source: 'inferred', tone: 'good' });
  return row({ key: 'end', at, words: 'Completed', source: 'saw', tone: 'good' });
}

/** The exact ids and codes behind the story, each copyable; only what the run recorded. */
export function exactDetails({ run, attempts }: RunDetailAnswer): Array<[string, string]> {
  const latest = attempts.at(-1);
  const runner = latest?.executor.kind === 'runner' ? latest.executor.runnerId : run.worker?.runner?.id ?? null;
  const facts: Array<[string, string | null]> = [
    ['Run id', run.id],
    ['Attempt id', latest?.attemptId ?? null],
    ['Runner id', runner],
    ['Error code', run.errorCode ?? null],
    ['Task id', run.task],
    ['Queued', run.queuedAt === null ? null : new Date(run.queuedAt).toISOString()],
    ['Claimed', latest === undefined ? null : new Date(latest.claimedAt).toISOString()],
    ['Finished', run.completedAt === null ? null : new Date(run.completedAt).toISOString()],
  ];
  return facts.filter((fact): fact is [string, string] => fact[1] !== null);
}

/** The search index update, card write or spore changes a run without a listed artifact recorded; null where the detail carries none of them. */
export function recordedOutputWords({ run, reports }: RunDetailAnswer): string | null {
  const said = (action: string) => reports.filter((report) => report.action === action).at(-1)?.summary.split('\n')[0]?.trim() ?? null;
  if (run.task === 'embedding-reconcile') {
    const summary = said('embedding');
    return summary === null ? 'An update to the search index.' : `An update to the search index. Its report: ${summary}`;
  }
  if (run.task === 'turn-cards') return 'Turn cards for its session’s turns.';
  if (run.task === 'curate-spores') {
    const lines = reports.filter((report) => report.action === 'curated').at(-1)?.summary.split('\n') ?? [];
    const tally = lines.length > 1 ? lines.at(-1)!.trim() : null;
    return tally === null ? 'Changes to related spores: retired, replaced or merged.' : `Changes to related spores: ${tally}.`;
  }
  return null;
}

/** One line of "Did it do what we asked?": what was asked beside what the evidence says, and on whose word. */
export interface AskedRow {
  key: string;
  label: string;
  asked: string;
  evidence: string;
  source: Source;
  tone: Tone;
}

const DID_NOT_DO_THE_WORK = new Set(['agent_tools_unused', 'report_without_audit']);

function shortOfRule(evidence: RunCloseEvidence | null): boolean {
  return evidence !== null && (!evidence.hasReport || evidence.artifactPresent === false || evidence.skipSupported === false || evidence.hasAudit === false);
}

/** The run's answer to "did it do what we asked?", in one line, and on whose word. */
export function verdictOf({ run, outcomeEvidence }: RunDetailAnswer): { words: string; source: Source; tone: Tone } {
  if (run.status === 'queued' || run.status === 'running' || run.status === 'claimed') return { words: 'Not known until it ends', source: 'none', tone: null };
  if (run.status === 'skipped') return { words: 'Nothing ran, so nothing was asked of it', source: 'saw', tone: null };
  if (run.errorCode === 'run_cancelled') return { words: 'Cancelled before it finished', source: 'saw', tone: 'bad' };
  if (run.status === 'completed') {
    if (outcomeEvidence?.skipSupported === true) return { words: 'Changed nothing, and Myco agrees', source: 'inferred', tone: 'good' };
    if (outcomeEvidence?.artifactPresent === true) {
      return run.result === 'produced'
        ? { words: 'Did the work, and its output is there', source: 'inferred', tone: 'good' }
        : { words: 'Changed nothing; the output Myco checks for is there', source: 'inferred', tone: 'good' };
    }
    return run.result === 'produced'
      ? { words: 'Did the work', source: 'inferred', tone: 'good' }
      : { words: 'Changed nothing', source: 'inferred', tone: null };
  }
  if (DID_NOT_DO_THE_WORK.has(run.errorCode ?? '') || (run.errorCode === 'run_failed' && shortOfRule(outcomeEvidence))) {
    return { words: 'Ran and did not do the work', source: 'inferred', tone: 'bad' };
  }
  if (run.result === 'failed_with_output') return { words: 'Stopped part way; what it wrote is kept', source: 'inferred', tone: 'bad' };
  return { words: 'Stopped before it finished the work', source: 'inferred', tone: 'bad' };
}

function owedWords(evidence: RunCloseEvidence): string {
  const account = evidence.hasAudit === null ? '' : ' with its account of the steps';
  const output = evidence.artifactPresent !== null || evidence.skipSupported !== null ? ', and its output or Myco’s agreement that there was none' : '';
  return `A report${account}${output}`;
}

function evidenceWords(evidence: RunCloseEvidence): { evidence: string; tone: Tone } {
  if (!evidence.hasReport) return { evidence: 'No report', tone: 'bad' };
  if (evidence.skipSupported === false) return { evidence: 'Said there was nothing to do; Myco disagrees', tone: 'bad' };
  if (evidence.artifactPresent === false) return { evidence: 'Reported, but its output isn’t there', tone: 'bad' };
  if (evidence.hasAudit === false) return { evidence: 'Reported without its account of the steps', tone: 'bad' };
  if (evidence.skipSupported === true) return { evidence: 'Changed nothing, and Myco agrees', tone: 'good' };
  if (evidence.artifactPresent === true) return { evidence: 'Report and output both there', tone: 'good' };
  return { evidence: 'Report filed', tone: 'good' };
}

/** Asked versus evidence: model, effort, material and the evidence the task owes. */
export function askedRows({ run, read, outcomeEvidence }: RunDetailAnswer): AskedRow[] {
  const rows: AskedRow[] = [];
  const live = run.status === 'queued' || run.status === 'running' || run.status === 'claimed';
  const identity = run.identity;
  const known = identity.status === 'reported' || identity.status === 'launched';
  const requested = run.requested;
  if (requested !== null || run.harness !== null || known) {
    const models = known ? [...new Set(identity.models.map((model) => model.model))] : [];
    const verdict = known && requested !== null && run.harness !== null ? profileModelVerdict(run.harness, requested, identity.primary) : 'match';
    rows.push({
      key: 'model', label: 'Model', asked: requested === null ? 'Not recorded' : displayModel(requested.model),
      evidence: !known ? (live ? 'Reported when it ends' : 'Not recorded') : verdict === 'mismatch' ? `${models.join(', ')}: a different model than asked` : verdict === 'unconfirmed' ? `${models.join(', ')}: the provider chooses which model this name runs` : models.join(', '),
      source: known ? 'runner' : 'none', tone: verdict === 'mismatch' ? 'warn' : null,
    });
    const unapplied = known && identity.warnings?.includes(EFFORT_UNAPPLIED) === true;
    rows.push({
      key: 'effort', label: 'Effort', asked: requested?.effort ?? 'Not set',
      evidence: unapplied ? 'Not applied: the agent offered no effort setting' : 'The effort it ran at isn’t recorded',
      source: unapplied ? 'runner' : 'none', tone: unapplied ? 'warn' : null,
    });
  }
  if (run.targetSessionId !== null || read.total > 0 || read.recorded) {
    rows.push({
      key: 'material', label: 'Material', asked: run.targetSessionId !== null ? 'One session named' : 'Sessions Myco serves it',
      evidence: read.recorded ? `${count(read.total, 'session')} served by Myco` : 'Which sessions it read isn’t recorded',
      source: read.recorded ? 'saw' : 'none', tone: run.targetSessionId !== null && read.recorded && read.total === 0 ? 'bad' : null,
    });
  }
  if (outcomeEvidence !== null) {
    const said = live ? { evidence: 'Not due until it ends', tone: null } : evidenceWords(outcomeEvidence);
    rows.push({ key: 'owed', label: 'Evidence owed', asked: owedWords(outcomeEvidence), evidence: said.evidence, source: live ? 'none' : 'saw', tone: said.tone });
  }
  return rows;
}

/** A run of the same task beside this one, as "Tries" lists it. */
export interface Try { id: string; completedAt: number | null; status: string; result: RunPageRow['result']; runner: string | null; current: boolean }

const DAY_MS = 86_400_000;
/** How far either side of a run the list of its tries looks. */
export const TRY_WINDOW_MS = DAY_MS;

/**
 * One piece of work across its tries: the failed runs right before this one (`before`, newest first), this run, and,
 * when it failed, the runs right after it (`after`, oldest first) up to the first that did not fail. Both lists start
 * next to this run, so a bounded page never skips a try between them.
 */
export function triesOf(current: Try, before: readonly Try[], after: readonly Try[] | null): Try[] {
  const earlier: Try[] = [];
  for (const run of before) {
    if (run.id === current.id) continue;
    if (run.status !== 'failed') break;
    earlier.unshift(run);
  }
  const later: Try[] = [];
  if (current.status === 'failed' && after !== null) {
    for (const run of after) {
      if (run.id === current.id) continue;
      later.push(run);
      if (run.status !== 'failed') break;
    }
  }
  return [...earlier, current, ...later];
}

export function tryResultWords(run: Pick<Try, 'status' | 'result'>): string {
  if (run.status === 'failed') return 'failed';
  if (run.status === 'completed') return run.result === 'unchanged' ? 'changed nothing' : 'worked';
  return run.status === 'skipped' ? 'held off' : 'still going';
}
