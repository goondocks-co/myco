/**
 * "Is the server well?": five lines, and one verdict that follows from them. Each line weighs every fact that bears on
 * it, from the status read, from what needs you (including failures Myco keeps retrying) and from what Myco is doing
 * now, and takes the worst of them, so a line's answer, its words and the verdict always agree.
 *
 * A fact is one of: Yes; a known impairment (needs attention); a known outage (No); or not known (unread, still
 * counting, or nothing recent to go on). The verdict is No when any line is No; Needs attention when no line is No and
 * any line needs attention or is not known; Yes only when every line is Yes. Optional adoption, an access key nearing
 * expiry, a member's name that failed to save and one offline runner while another can work stay in "What needs you".
 */
import { QUEUE_REASON_WORDS } from '@goondocks/myco-shared/runner-fleet';
import { isStoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { budgetCountWords } from '../settings/MycosWork';
import type { StatusResponse } from '../../../lib/api';
import type { AgentPayersAnswer } from '../../../hooks/use-fleet';
import type { WorkNowAnswer } from '../../now/wire';
import type { AttentionAnswer, AttentionItem, AttentionKind } from '../../today/wire';
import { attentionWords, MYCO_MEMBER_ID } from '../../today/words';
import { SERVER_READS, serverItemWords, type ServerItem, type ServerReadName } from '../../today/server-items';
import { kindOf } from '../../work/words';
import { taskWords } from '../workers';
import { backlogWords, capabilityWords, lastLearningWords } from './words';

/** How one line stands: Yes, a known impairment, a known outage, or not known (unread, counting, or no recent evidence). */
export type LineState = 'yes' | 'attention' | 'no' | 'unknown' | 'failed';

export type LineKey = 'sessions' | 'learning' | 'runners' | 'budget' | 'database';

export interface WellLine {
  key: LineKey;
  label: string;
  state: LineState;
  /** The line's answer in a word or two: Yes, or what is wrong. */
  answer: string;
  /** What the answer rests on. */
  detail: string;
  /** Rows shown beneath the line: what this server runs itself, only while one of them is not set up. */
  rows?: ReadonlyArray<{ label: string; ready: boolean }>;
  /** For Somewhere to run: how many runners can do Myco's work now, of how many. */
  runners?: { working: number; total: number };
}

export type Verdict = 'Yes' | 'Needs attention' | 'No';

const LABELS: Readonly<Record<LineKey, string>> = {
  sessions: 'Sessions arriving',
  learning: 'Learning from them',
  runners: 'Somewhere to run',
  budget: 'Within budget',
  database: 'Database and storage',
};

/** Capture is recent while its newest receipt is this young; older, the line says it has been quiet. */
export const CAPTURE_RECENT_MS = 24 * 3_600_000;

/** The answer a line gives for an item that needs you; the verdict's sentence names the line alone for it. */
const NEEDS_A_LOOK = 'Needs a look';

/** One fact on a line: how it stands, its short answer, and its words. */
interface Fact { state: LineState; answer: string; words: string }

const RANK: Readonly<Record<LineState, number>> = { yes: 0, unknown: 1, failed: 1, attention: 2, no: 3 };
const fact = (state: LineState, answer: string, words: string): Fact => ({ state, answer, words });

/** A line from its facts: the worst of them gives its state and answer, and every fact's words are said. */
function lineOf(key: LineKey, facts: readonly Fact[], extra: Partial<WellLine> = {}): WellLine {
  const worst = facts.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
  return { key, label: LABELS[key], state: worst.state, answer: worst.answer, detail: facts.map((f) => f.words).filter(Boolean).join(' '), ...extra };
}

/** A read as the lines weigh it: its answer, or undefined while it has none, and whether its last read failed. */
export interface Read<T> { data: T | undefined; failed: boolean }

/** The facts the lines read. */
export interface HealthFacts {
  now: number;
  projectName: (projectId: string) => string | null;
  status: Read<StatusResponse>;
  attention: Read<AttentionAnswer>;
  /** Store checks, stored keys and automatic backups, an overdue backup already merged into a failed one. */
  server: readonly ServerItem[];
  /** The reads of those items that failed; an item read before them stays in `server`. */
  unchecked: readonly ServerReadName[];
  work: Read<WorkNowAnswer>;
  payers: Read<AgentPayersAnswer>;
}

/** The line each attention kind lowers; a kind not named here stays in "What needs you" alone. */
const KIND_LINE: Readonly<Partial<Record<AttentionKind, LineKey>>> = {
  transcripts_stopped: 'sessions', harness_capture_silent: 'sessions', harness_needs_repair: 'sessions',
  outcome_failed: 'learning', runs_without_audit: 'learning', repository_preparation_failed: 'learning',
  no_worker: 'runners', runs_held_for_capability: 'runners',
  run_body_stuck: 'database', search_index_behind: 'database', backup_overdue: 'database',
};

/** What the attention read says about one line: each item on it, retrying or not, and its checks that could not be read. */
function attentionFacts(key: LineKey, { attention, server, now, projectName }: HealthFacts): Fact[] {
  if (attention.data === undefined) return attention.failed ? [fact('unknown', 'Couldn’t check', 'Couldn’t check what needs you just now.')] : [];
  const backupFailed = server.some((item) => item.kind === 'backup_failed');
  const items = attention.data.items.filter((item) => KIND_LINE[item.kind] === key && !(backupFailed && item.kind === 'backup_overdue'));
  const unread = attention.data.unavailable.filter((kind) => KIND_LINE[kind] === key);
  return [
    ...items.map((item: AttentionItem) => {
      const words = attentionWords(item, now, projectName);
      return item.kind === 'no_worker' ? fact('no', 'Nothing running work', `${words.title}.`) : fact('attention', NEEDS_A_LOOK, `${words.title}.`);
    }),
    ...(unread.length === 0 ? [] : [fact('unknown', 'Couldn’t check', 'Not every check on it could be read.')]),
  ];
}

/** The reads of store checks and automatic backups bear on the database line; stored keys come with the status read. */
const UNCHECKED_ON_DATABASE: readonly ServerReadName[] = [SERVER_READS.storeChecks, SERVER_READS.backups];

/**
 * What the store checks, stored keys and automatic backups say about one line, and which of their reads failed. A key
 * runners work around stays in What needs you.
 */
function serverFacts(key: LineKey, { server, unchecked }: HealthFacts): Fact[] {
  const found = server.flatMap((item) => {
    const on: LineKey | null = item.kind === 'stored_key' ? (item.waits ? 'runners' : null) : 'database';
    if (on !== key) return [];
    return [fact('attention', NEEDS_A_LOOK, `${serverItemWords(item).title}.`)];
  });
  const unread = key === 'database' ? unchecked.filter((name) => UNCHECKED_ON_DATABASE.includes(name)) : [];
  return unread.length === 0 ? found : [...found, fact('unknown', 'Couldn’t check', `Couldn’t check ${unread.join(' or ')} just now.`)];
}

/** A failed refresh keeps what was read, and says so. */
const staleFacts = ({ status }: HealthFacts): Fact[] => (status.failed && status.data !== undefined
  ? [fact('unknown', 'Couldn’t refresh', 'Couldn’t refresh this just now; it shows what was read before.')] : []);

const missing = (status: StatusResponse, ...reads: string[]): boolean => reads.some((read) => status.unavailable?.includes(read) === true);

/** The newest capture a person's agent sent, said as a receipt: when, from whom and for which project. Myco's own runs are not counted. */
function sessionsFact(status: StatusResponse, { now, projectName }: HealthFacts): Fact {
  if (missing(status, 'capture', 'machines')) return fact('failed', 'Couldn’t read', 'Couldn’t read what was last received just now.');
  const newest = (status.capture ?? []).filter((row) => row.member?.id !== MYCO_MEMBER_ID)
    .reduce<NonNullable<StatusResponse['capture']>[number] | null>((best, row) => (best === null || row.lastEventAt > best.lastEventAt ? row : best), null);
  if (newest === null) return fact('unknown', 'Nothing lately', 'Nothing has been received from anyone’s agents lately.');
  const from = newest.machineName ?? newest.member?.label ?? 'a machine whose owner isn’t known';
  const project = projectName(newest.projectId) ?? 'a project you can’t see';
  const receipt = `Last capture received ${agoWords(newest.lastEventAt, now)}, from ${from} for ${project}.`;
  return now - newest.lastEventAt <= CAPTURE_RECENT_MS ? fact('yes', 'Yes', receipt) : fact('unknown', 'Quiet', `Quiet since then. ${receipt}`);
}

/** Whether a run now is processing sessions: learning, turn summaries or titles. */
const processesSessions = (task: string): boolean => {
  const kind = kindOf(task);
  return kind === 'learn' || kind === 'title' || task === CARD_TASK;
};

/**
 * When learning last completed and what waits for it, in the server's words, and whether a backlog is moving: work
 * running now, or held for a reason Myco names. Nothing waiting is Yes; counts still being built are not known.
 */
function learningFact(status: StatusResponse, { now, work }: HealthFacts): Fact {
  const learning = status.learning;
  if (missing(status, 'learning') || learning == null) return fact('failed', 'Couldn’t read', 'Couldn’t read how learning stands just now.');
  if (missing(status, 'transcriptBacklog')) return fact('failed', 'Couldn’t read', 'Couldn’t read the transcripts waiting to be read just now.');
  const said = [lastLearningWords(learning.lastCompleted, now), learning.line, backlogWords(status.transcriptBacklog)].filter((part) => part !== null).join(' ');
  if (learning.state !== 'ready' || learning.dueSessions === undefined) return fact('unknown', 'Still counting', said);
  const backlog = learning.dueSessions > 0 || (learning.turnsAwaitingCards ?? 0) > 0;
  if (!backlog) return fact('yes', 'Yes', said);
  if (work.data === undefined) return fact('unknown', 'Unknown', `${said} Whether learning is moving ${work.failed ? 'couldn’t be read' : 'is still being read'}.`);
  const running = work.data.running.filter((run) => processesSessions(run.task));
  if (running.length > 0) return fact('yes', 'Catching up', `${said} Running now: ${[...new Set(running.map((run) => taskWords(run.task)))].join(', ')}.`);
  if (work.data.waiting.length > 0) return fact('attention', 'Waiting', `${said} ${work.data.waiting.map((wait) => `${wait.what}: ${wait.why}`).join(' ')}`);
  return fact('yes', 'Catching up', `${said} Nothing holds it; it runs on its schedule.`);
}

const ONLINE: ReadonlySet<string> = new Set(['Online', 'Busy']);

/** The runners that can do Myco's work now (online, with an agent they can use), and runs held for a reason a person can change. */
function runnersFacts(status: StatusResponse, { now, payers }: HealthFacts): { facts: Fact[]; counts?: WellLine['runners'] } {
  if (missing(status, 'workers') || status.workers?.available !== true || status.workers.fleet == null) return { facts: [fact('failed', 'Couldn’t read', 'Couldn’t read the runners just now.')] };
  const runners = status.workers.fleet.flatMap((row) => (row.runnerDetails === undefined || row.runnerDetails.state === 'removed' ? [] : [row.runnerDetails]));
  if (runners.length === 0) return { facts: [fact('no', 'No runner', 'No machine runs Myco’s work yet, so nothing can learn from sessions. Add a runner under Settings › Myco’s work.')] };
  const agentOf = new Map((payers.data?.today ?? []).map((entry) => [entry.id, entry.agent]));
  const canWork = (runner: (typeof runners)[number]) => ONLINE.has(runner.display) && (payers.data === undefined || agentOf.get(runner.id) != null);
  const working = runners.filter(canWork);
  const each = runners.map((runner) => (canWork(runner) ? `${runner.name} can work${runner.display === 'Busy' ? ' and is working' : ''}`
    : ONLINE.has(runner.display) ? `${runner.name} is online but has no agent it can use for this work`
      : `${runner.name} is ${runner.display.toLowerCase()}${runner.lastSeenAt === null ? '' : `, last seen ${agoWords(runner.lastSeenAt, now)}`}`)).join('. ');
  const answer = `${working.length} of ${runners.length} can work`;
  const facts: Fact[] = [working.length === 0 ? fact('no', answer, `${each}. Nothing can run Myco’s work until one can.`) : fact('yes', answer, `${each}.`)];
  if (payers.data === undefined && payers.failed) facts.push(fact('unknown', 'Couldn’t check', 'Which agent each runner can use couldn’t be read.'));
  const queue = status.workers.queue;
  if (queue === undefined || queue.state === 'building' || queue.count === null) facts.push(fact('unknown', 'Unknown', 'Whether runs are waiting couldn’t be read.'));
  else {
    const blocked = queue.reasons.filter(({ reason, count }) => reason !== 'ready' && reason !== 'capacity' && (count ?? 1) > 0);
    if (blocked.length > 0) facts.push(fact('attention', 'Runs held', blocked.map(({ reason }) => (isStoredKeyFailure(reason) ? 'Runs wait on a stored key.' : QUEUE_REASON_WORDS[reason])).join(' ')));
  }
  return { facts, counts: { working: working.length, total: runners.length } };
}

/** What counts against the daily budget now, in the words Myco's work uses; reached or holding a task, Myco waits for room. */
function budgetFacts(status: StatusResponse): Fact[] {
  if (missing(status, 'budget')) return [fact('failed', 'Couldn’t read', 'Couldn’t read what counts against the budget just now.')];
  const budget = status.budget;
  const words = `${budgetCountWords({ isPending: false, isError: false }, budget)}.`;
  if (budget === undefined) return [fact('unknown', 'Unknown', words)];
  if (!budget.active) return [fact('yes', 'Not applied', words)];
  if (budget.state === 'building' || budget.automaticUsd === null) return [fact('unknown', 'Measuring', words)];
  const spent = budget.automaticUsd + (budget.manualUsd ?? 0);
  const limit = `The budget is $${budget.dailyUsd.toFixed(2)} for any 24 hours`;
  const facts = [spent >= budget.dailyUsd ? fact('attention', 'Reached', `${words} ${limit}; Myco waits until it has room again.`) : fact('yes', 'Yes', `${words} ${limit}.`)];
  for (const head of budget.heldHeads ?? []) {
    facts.push(fact('attention', 'Holding work', head.reason === 'budget_too_small'
      ? `Held: ${taskWords(head.task)} needs a budget of at least ${head.requiredUsd === null ? 'more than this' : `$${head.requiredUsd.toFixed(2)}`} to start.`
      : `Held: ${taskWords(head.task)} waits for room in the budget.`));
  }
  return facts;
}

/** Whether the database answers at the expected version, and what storage this server reports set up; stored files are not read back. */
function databaseFacts(status: StatusResponse): { facts: Fact[]; rows?: WellLine['rows'] } {
  if (status.database?.readable === false) return { facts: [fact('no', 'Not answering', 'The database did not answer the read check.')] };
  if (missing(status, 'schema')) return { facts: [fact('failed', 'Couldn’t read', 'Couldn’t read the database version just now.')] };
  const schema = status.schema;
  if (!schema.matches) {
    return { facts: [fact('no', 'Wrong version', schema.found === null ? 'The database version could not be read.'
      : `The database holds version ${schema.found}; this server expects ${schema.expected}. Some pages may fail until they match.`)] };
  }
  const facts = [status.database === undefined
    ? fact('unknown', 'Unknown', `At the version this server expects (${schema.expected}); whether it answers reads is unknown.`)
    : fact('yes', 'Yes', `Answering, at the version this server expects (${schema.expected}).`)];
  const notSetUp = status.capabilities.filter((capability) => !capability.present);
  let rows: WellLine['rows'];
  if (status.capabilities.length === 0) facts.push(fact('unknown', 'Storage unknown', 'This server reports no storage set-up.'));
  else if (notSetUp.length > 0) {
    facts.push(fact('attention', 'Not all set up', 'Not everything this server runs itself is set up:'));
    rows = status.capabilities.map((capability) => ({ label: capabilityWords(capability), ready: capability.present }));
  } else facts.push(fact('yes', 'Yes', 'Its storage is set up; stored files are not read back here.'));
  if (status.target === 'cloudflare') facts.push(fact('yes', 'Yes', 'Cloudflare can put the database back to a recent point; Backups says how.'));
  return { facts, ...(rows === undefined ? {} : { rows }) };
}

/** The five lines, in the order the page says them. */
export function wellLines(facts: HealthFacts): WellLine[] {
  const status = facts.status.data;
  if (status === undefined) return unreadLines();
  const stale = staleFacts(facts);
  const runners = runnersFacts(status, facts);
  const database = databaseFacts(status);
  return [
    lineOf('sessions', [sessionsFact(status, facts), ...attentionFacts('sessions', facts), ...stale]),
    lineOf('learning', [learningFact(status, facts), ...attentionFacts('learning', facts), ...stale]),
    lineOf('runners', [...runners.facts, ...attentionFacts('runners', facts), ...serverFacts('runners', facts), ...stale], runners.counts === undefined ? {} : { runners: runners.counts }),
    lineOf('budget', [...budgetFacts(status), ...stale]),
    lineOf('database', [...database.facts, ...attentionFacts('database', facts), ...serverFacts('database', facts), ...stale], database.rows === undefined ? {} : { rows: database.rows }),
  ];
}

/** Every line, when the status read has no answer: each says it could not be read. */
export function unreadLines(): WellLine[] {
  return (Object.keys(LABELS) as LineKey[]).map((key) => lineOf(key, [fact('failed', 'Couldn’t read', 'Couldn’t read this server’s status just now.')]));
}

/** The verdict the lines give, by the rule this module states, with one sentence saying why. */
export function verdictOf(lines: readonly WellLine[]): { verdict: Verdict; sentence: string } {
  const no = lines.filter((entry) => entry.state === 'no');
  const unsure = lines.filter((entry) => entry.state !== 'yes' && entry.state !== 'no');
  if (no.length === 0 && unsure.length === 0) {
    const runners = lines.find((entry) => entry.key === 'runners')?.runners;
    const working = runners === undefined ? 'its runners can work' : `${runners.working} of ${runners.total} ${runners.total === 1 ? 'runner' : 'runners'} can work`;
    return { verdict: 'Yes', sentence: `Sessions are arriving, Myco is learning from them, and ${working}.` };
  }
  const named = (entries: readonly WellLine[]) => entries.map((entry) => (entry.answer === NEEDS_A_LOOK ? entry.label.toLowerCase() : `${entry.label.toLowerCase()} (${entry.answer.toLowerCase()})`)).join(', ');
  const sentence = [no.length > 0 ? `Not working: ${named(no)}.` : null, unsure.length > 0 ? `Needs a look: ${named(unsure)}.` : null].filter(Boolean).join(' ');
  return { verdict: no.length > 0 ? 'No' : 'Needs attention', sentence };
}
