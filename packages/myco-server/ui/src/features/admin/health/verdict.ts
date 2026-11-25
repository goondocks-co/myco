/**
 * "Is the server well?": five lines, each read from the fact that answers it, and one verdict that follows from them.
 *
 * The verdict is No when any line is No; Needs attention when no line is No and any line needs attention, is unknown
 * or could not be read; Yes only when every line is Yes. A line the server could not answer is never taken for Yes.
 */
import { budgetCountWords } from '../settings/MycosWork';
import type { StatusResponse } from '../../../lib/api';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { MYCO_MEMBER_ID } from '../../today/words';
import { backlogWords, capabilityWords, lastLearningWords } from './words';

/** How one line stands: Yes, a problem that needs a look, one that stops the server's work, or not known. */
export type LineState = 'yes' | 'attention' | 'no' | 'unknown' | 'failed';

export type LineKey = 'sessions' | 'learning' | 'runners' | 'budget' | 'database';

export interface WellLine {
  key: LineKey;
  label: string;
  state: LineState;
  /** The line's answer in a word or two: Yes, or what is wrong. */
  answer: string;
  /** What the answer rests on, in one or two sentences. */
  detail: string;
  /** Rows shown beneath the line: what this server runs itself, only while one of them is not set up. */
  rows?: ReadonlyArray<{ label: string; ready: boolean }>;
  /** For Somewhere to run: how many runners are online, of how many. */
  runners?: { online: number; total: number };
}

export type Verdict = 'Yes' | 'Needs attention' | 'No';

const LABELS: Readonly<Record<LineKey, string>> = {
  sessions: 'Sessions arriving',
  learning: 'Learning from them',
  runners: 'Somewhere to run',
  budget: 'Within budget',
  database: 'Database and storage',
};

/** Learning is behind when sessions have waited for it this long since it last completed. */
export const LEARNING_BEHIND_MS = 24 * 3_600_000;

const ONLINE: ReadonlySet<string> = new Set(['Online', 'Busy']);

const line = (key: LineKey, state: LineState, answer: string, detail: string, rows?: WellLine['rows']): WellLine =>
  ({ key, label: LABELS[key], state, answer, detail, ...(rows === undefined ? {} : { rows }) });

/** A line whose read failed: it says so, naming what could not be read. */
const failed = (key: LineKey, what: string): WellLine => line(key, 'failed', 'Couldn’t read', `Couldn’t read ${what} just now.`);

/** The facts the lines read, beside the reader's clock and how projects are named. */
export interface WellFacts {
  status: StatusResponse;
  now: number;
  projectName: (projectId: string) => string | null;
}

const missing = (status: StatusResponse, ...reads: string[]): boolean => reads.some((read) => status.unavailable?.includes(read) === true);

/** The newest session a person's agent sent, from which machine and for which project. Myco's own runs are not sessions arriving. */
export function sessionsLine({ status, now, projectName }: WellFacts): WellLine {
  if (missing(status, 'capture', 'machines')) return failed('sessions', 'which sessions arrived');
  const newest = (status.capture ?? []).filter((row) => row.member?.id !== MYCO_MEMBER_ID)
    .reduce<NonNullable<StatusResponse['capture']>[number] | null>((best, row) => (best === null || row.lastEventAt > best.lastEventAt ? row : best), null);
  if (newest === null) return line('sessions', 'attention', 'None lately', 'No session has arrived lately. Sessions arrive once someone works with a coding agent on a connected machine.');
  const machine = newest.machineName ?? (newest.member?.label == null ? 'a machine' : `${newest.member.label}’s machine`);
  return line('sessions', 'yes', 'Yes', `Last one ${agoWords(newest.lastEventAt, now)}, from ${machine} for ${projectName(newest.projectId) ?? 'a project'}.`);
}

/** When learning last completed and what waits for it, in the server's own words for what waits and why. */
export function learningLine({ status, now }: WellFacts): WellLine {
  if (missing(status, 'learning') || status.learning == null) return failed('learning', 'how learning stands');
  if (missing(status, 'transcriptBacklog')) return failed('learning', 'the transcripts waiting to be read');
  const learning = status.learning;
  const detail = [lastLearningWords(learning.lastCompleted, now), learning.line, backlogWords(status.transcriptBacklog)].filter((part) => part !== null).join(' ');
  if (learning.lastCompleted === undefined || learning.dueSessions === undefined) return line('learning', 'unknown', 'Unknown', detail);
  const lastAt = learning.lastCompleted?.at ?? null;
  const behind = learning.dueSessions > 0 && (lastAt === null || now - lastAt > LEARNING_BEHIND_MS);
  return behind ? line('learning', 'attention', 'Behind', detail) : line('learning', 'yes', 'Yes', detail);
}

/** The registered runners online of all of them, each named with how it stands, and runs that wait for a reason a person can change. */
export function runnersLine({ status, now }: WellFacts): WellLine {
  if (missing(status, 'workers') || status.workers?.available !== true || status.workers.fleet == null) return failed('runners', 'the runners');
  const runners = status.workers.fleet.flatMap((row) => (row.runnerDetails === undefined || row.runnerDetails.state === 'removed' ? [] : [row.runnerDetails]));
  if (runners.length === 0) return line('runners', 'no', 'No runner', 'No machine runs Myco’s work yet, so nothing can learn from sessions. Add a runner under Settings › Myco’s work.');
  const online = runners.filter((runner) => ONLINE.has(runner.display));
  const each = runners.map((runner) => (ONLINE.has(runner.display) ? `${runner.name} is ${runner.display === 'Busy' ? 'working' : 'online'}`
    : `${runner.name} is ${runner.display.toLowerCase()}${runner.lastSeenAt === null ? '' : `, last seen ${agoWords(runner.lastSeenAt, now)}`}`)).join('. ');
  const answer = `${online.length} of ${runners.length} online`;
  const counts = { runners: { online: online.length, total: runners.length } };
  if (online.length === 0) return { ...line('runners', 'no', answer, `${each}. Nothing can run Myco’s work until one is back.`), ...counts };
  const blocked = (status.workers.queue?.reasons ?? []).filter(({ reason, count }) => reason !== 'ready' && reason !== 'capacity' && (count ?? 1) > 0);
  if (blocked.length > 0) return { ...line('runners', 'attention', answer, `${each}. Some runs wait for a reason a person can change: see Needs you, or Myco’s work › Runners.`), ...counts };
  return { ...line('runners', 'yes', answer, `${each}.`), ...counts };
}

/** What counts against the daily budget now, in the words Myco's work uses; reached means Myco waits for room. */
export function budgetLine({ status }: WellFacts): WellLine {
  if (missing(status, 'budget')) return failed('budget', 'what counts against the budget');
  const budget = status.budget;
  const words = `${budgetCountWords({ isPending: false, isError: false }, budget)}.`;
  if (budget === undefined) return line('budget', 'unknown', 'Unknown', words);
  if (!budget.active) return line('budget', 'yes', 'Yes', words);
  if (budget.state === 'building' || budget.automaticUsd === null) return line('budget', 'unknown', 'Measuring', words);
  const spent = budget.automaticUsd + (budget.manualUsd ?? 0);
  const of = ` The daily budget is $${budget.dailyUsd.toFixed(2)}.`;
  return spent >= budget.dailyUsd
    ? line('budget', 'attention', 'Reached', `${words}${of} Myco waits until it has room again.`)
    : line('budget', 'yes', 'Yes', `${words}${of}`);
}

/** Whether the database answers and holds the version this server expects, and whether everything this server runs itself is set up. */
export function databaseLine({ status }: WellFacts): WellLine {
  const schema = status.schema;
  if (status.database?.readable === false) return line('database', 'no', 'Not answering', 'The database did not answer the read check.');
  if (missing(status, 'schema')) return failed('database', 'the database version');
  if (!schema.matches) {
    return line('database', 'no', 'Wrong version', schema.found === null ? 'The database version could not be read.'
      : `The database holds version ${schema.found}; this server expects ${schema.expected}. Some pages may fail until they match.`);
  }
  const answering = `${status.database === undefined ? 'At' : 'Answering, at'} the version this server expects (${schema.expected}).`;
  const notSetUp = status.capabilities.filter((capability) => !capability.present);
  if (notSetUp.length > 0) {
    return line('database', 'attention', 'Not all set up', `${answering} Not everything this server runs itself is set up:`,
      status.capabilities.map((capability) => ({ label: capabilityWords(capability), ready: capability.present })));
  }
  return status.database === undefined ? line('database', 'unknown', 'Unknown', `${answering} Whether it answers reads is unknown.`) : line('database', 'yes', 'Yes', answering);
}

/** The five lines, in the order the page says them. */
export function wellLines(facts: WellFacts): WellLine[] {
  return [sessionsLine(facts), learningLine(facts), runnersLine(facts), budgetLine(facts), databaseLine(facts)];
}

/** Every line, when the status read itself failed: each says it could not be read. */
export function unreadLines(): WellLine[] {
  return (Object.keys(LABELS) as LineKey[]).map((key) => failed(key, 'this server’s status'));
}

/** The verdict the lines give, by the rule this module states, with one sentence saying why. */
export function verdictOf(lines: readonly WellLine[]): { verdict: Verdict; sentence: string } {
  const no = lines.filter((entry) => entry.state === 'no');
  const unsure = lines.filter((entry) => entry.state !== 'yes' && entry.state !== 'no');
  if (no.length === 0 && unsure.length === 0) {
    const runners = lines.find((entry) => entry.key === 'runners')?.runners;
    const online = runners === undefined ? 'its runners are online' : `${runners.online} of ${runners.total} ${runners.total === 1 ? 'runner' : 'runners'} ${runners.online === 1 ? 'is' : 'are'} online`;
    return { verdict: 'Yes', sentence: `Sessions are arriving, Myco is learning from them, and ${online}.` };
  }
  const named = (entries: readonly WellLine[]) => entries.map((entry) => `${entry.label.toLowerCase()} (${entry.answer.toLowerCase()})`).join(', ');
  const sentence = [no.length > 0 ? `Not working: ${named(no)}.` : null, unsure.length > 0 ? `Needs a look: ${named(unsure)}.` : null].filter(Boolean).join(' ');
  return { verdict: no.length > 0 ? 'No' : 'Needs attention', sentence };
}
