/**
 * Myco's work in words: every sentence the page and the run panel show, built
 * from the numbers the server answers. A run reads as what it came to, a
 * machine by its name, a member by theirs, and Myco's own schedule as "its
 * schedule". Nothing here names a mechanism or shows an id.
 */
import { heldByWords } from '@goondocks/myco-shared/run-holds';
import type { OutcomeKind, Range, WorkRun } from '../today/wire';
import { causeSentence, clockTime, count, when } from '../today/words';
import { memberLabel } from '../../lib/member-name';
import type { CapabilityOffRefusal, DailyLimitRefusal, FreshNeedsAdminRefusal, RunFields, RunOutcomeCounts, RunWorker } from './wire';

/** The tasks whose outcomes the page groups by, and the kind of work each is. */
export const TASK_KINDS: Readonly<Record<string, OutcomeKind>> = {
  'extract-curate': 'learn',
  'title-summary': 'title',
  'canopy-map': 'map',
  'vault-seed': 'seed',
};

/** The task behind each kind of work. */
export const KIND_TASKS: Readonly<Record<OutcomeKind, string>> = {
  learn: 'extract-curate',
  title: 'title-summary',
  map: 'canopy-map',
  seed: 'vault-seed',
};

/** The kinds in the order the page lays them out. */
export const KIND_ORDER: readonly OutcomeKind[] = ['learn', 'title', 'map', 'seed'];

/** The kind a task is, or null for a task the page does not group. */
export function kindOf(task: string | null): OutcomeKind | null {
  return task === null ? null : TASK_KINDS[task] ?? null;
}

/** A kind as the outcome filter names it. */
export const KIND_WORDS: Readonly<Record<OutcomeKind, string>> = {
  learn: 'Learning',
  title: 'Titles',
  map: 'Code map',
  seed: 'Learning from the code',
};

/** What one run of a kind is called, and more than one: "learning run", "learning runs". */
const RUN_NOUN: Readonly<Record<OutcomeKind, readonly [string, string]>> = {
  learn: ['learning run', 'learning runs'],
  title: ['titling run', 'titling runs'],
  map: ['code map update', 'code map updates'],
  seed: ['run over the code', 'runs over the code'],
};

export function runNoun(kind: OutcomeKind | null, n = 1): string {
  const [one, many] = kind === null ? ['run', 'runs'] : RUN_NOUN[kind];
  return n === 1 ? one : many;
}

/** How many times, in words: "once", "twice", "9 times". */
export function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n.toLocaleString()} times`;
}

/** What a kind of work came to over the window, as its card's headline. */
export interface OutcomeCounts {
  spores: number;
  sessions: number;
  maps: number;
  /** Runs that produced something. */
  produced: number;
  /** Runs that failed and kept nothing. */
  failed: number;
  /** Runs that finished, having produced something or not. */
  finished: number;
}

export function outcomeHeadline(kind: OutcomeKind, c: OutcomeCounts): string {
  switch (kind) {
    case 'learn':
      if (c.spores > 0) return `Learned ${count(c.spores, 'spore')}${c.sessions > 0 ? ` from ${count(c.sessions, 'session')}` : ''}`;
      if (c.failed > 0 && c.failed === c.finished) return 'Couldn’t learn from recent sessions';
      return c.finished > 0 ? 'Read new sessions and found nothing new to keep' : 'Learning hasn’t run yet';
    case 'seed':
      if (c.spores > 0) return `Learned ${count(c.spores, 'spore')} from the project’s code`;
      if (c.failed > 0 && c.failed === c.finished) return 'Couldn’t learn from the project’s code';
      return 'Read the project’s code and found nothing new to keep';
    case 'title':
      if (c.sessions > 0) return `Titled and summarized ${count(c.sessions, 'session')}`;
      if (c.failed > 0 && c.failed === c.finished) return 'Couldn’t title sessions';
      return c.finished > 0 ? 'Checked for sessions to title; none needed one' : 'Titling hasn’t run yet';
    case 'map':
      if (c.maps > 0) return `Updated the code map ${times(c.maps)}`;
      if (c.failed > 0 && c.failed === c.finished) return 'Couldn’t update the code map';
      return c.finished > 0 ? 'Checked the code map; nothing to change' : 'The code map hasn’t been updated yet';
  }
}

/** A lede's clause for a kind: "learned 180 spores from 20 sessions", or null when it came to nothing. */
export function ledeClause(kind: OutcomeKind, c: OutcomeCounts): string | null {
  switch (kind) {
    case 'learn': return c.spores > 0 ? `learned ${count(c.spores, 'spore')}${c.sessions > 0 ? ` from ${count(c.sessions, 'session')}` : ''}` : null;
    case 'seed': return c.spores > 0 ? `learned ${count(c.spores, 'spore')} from the project’s code` : null;
    case 'title': return c.sessions > 0 ? `titled ${count(c.sessions, 'session')}` : null;
    case 'map': return c.maps > 0 ? `updated the code map ${times(c.maps)}` : null;
  }
}

/** A window as the page names it. */
export type WorkWindow = 'today' | 'week';

export const WINDOW_WORDS: Readonly<Record<WorkWindow, { lead: string; noun: string }>> = {
  today: { lead: 'Today', noun: 'today' },
  week: { lead: 'This week', noun: 'this week' },
};

/** An instant as the page says it: "today at 09:39", "yesterday at 23:05", "Sunday at 22:07", else "on Sep 24". */
export function atWords(at: number, now: number): string {
  const said = when(at, now);
  if (said.startsWith('at ')) return `today ${said}`;
  if (said.startsWith('yesterday')) return said;
  const days = (startOf(now) - startOf(at)) / 86_400_000;
  if (days < 7) return `${new Date(at).toLocaleDateString(undefined, { weekday: 'long' })} at ${clockTime(at)}`;
  return said;
}

function startOf(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A run's time in a list: "09:39" today, else "Mon 12:53". */
export function shortTime(at: number, now: number): string {
  if (startOf(at) === startOf(now)) return clockTime(at);
  return `${new Date(at).toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(at)}`;
}

/** What one run came to, in a few words, for a line in a list. */
export function runLineWords(kind: OutcomeKind | null, run: Pick<RunFields, 'status' | 'skipReason' | 'skipReasonCode' | 'targetSessionId'> & { result?: RunFields['result'] }, outcome: Pick<RunOutcomeCounts, 'spores' | 'sessions' | 'readsRecorded'> & { maps?: number }): string {
  if (run.status === 'skipped') return `Held off: ${skipWords(run.skipReasonCode ?? run.skipReason)}`;
  if (run.status === 'queued') return 'Waiting to start';
  if (run.status === 'running' || run.status === 'claimed') return 'Running now';
  if (run.result === 'failed_with_output') return 'Failed with output kept';
  if (run.result === 'failed') return 'Failed';
  if (run.result === 'unchanged') return 'Checked and changed nothing';
  const failed = run.status === 'failed';
  switch (kind) {
    case 'learn':
    case 'seed':
      if (outcome.spores > 0) return `${count(outcome.spores, 'spore')}${outcome.sessions > 0 ? ` from ${count(outcome.sessions, 'session')}` : ''}${failed ? ', then stopped' : ''}`;
      return failed ? 'Stopped before saving anything' : 'Nothing new to keep';
    case 'title':
      if (run.result === 'produced') return 'Titled a session';
      if (failed) return 'Couldn’t title a session';
      return outcome.sessions > 0 ? 'Titled a session' : 'Titled nothing';
    case 'map':
      if (run.result === 'produced') return 'Updated the map';
      if (failed) return 'Couldn’t update the map';
      return outcome.maps === 0 ? 'Nothing to change' : 'Updated the map';
    default:
      return failed ? 'Failed' : 'Finished';
  }
}

/** Why a run was held off, as the rest of "Held off: …". */
export function skipWords(reason: string | null): string {
  if (reason === null || reason.trim() === '') return 'Myco didn’t need to run it';
  const known = SKIP_WORDS[reason];
  if (known !== undefined) return known;
  // A reason the page has no words for reads plainly; the server's own sentence is never shown.
  return 'Myco didn’t need to run it';
}

const SKIP_WORDS: Readonly<Record<string, string>> = {
  run_not_needed: 'Myco didn’t need to run it',
  machine_did_not_start: 'no machine started it within a day',
  max_runs_per_day: 'today’s run limit was reached',
  reserved_runs_per_day: 'the rest of today’s runs are kept for when they’re needed',
  input_unchanged: 'nothing new since the last run',
  capability_off: 'it was switched off for this project',
  already_running: 'one was already running',
};

/** Who started a run, as its panel says it; null where the run names no one. `name` turns a member id into a name. */
export function startedByWords(startedBy: string | null, name: (id: string) => string | null): string | null {
  if (startedBy === null) return null;
  if (startedBy === 'clock') return 'On its schedule';
  if (startedBy === 'backfill') return 'To title imported sessions';
  const who = name(startedBy);
  return who === null ? 'By a member' : `By ${who}`;
}

/** The same, as a chip beside a run in a list: "by Ada", or nothing for a run Myco started itself. */
export function startedByChip(startedBy: string | null, name: (id: string) => string | null): string | null {
  if (startedBy === null || startedBy === 'clock' || startedBy === 'backfill') return null;
  const who = name(startedBy);
  return who === null ? 'by a member' : `by ${who}`;
}

/** A capability as the reader knows it. */
export const CAPABILITY_NAMES: Readonly<Record<string, string>> = {
  vault_evolution: 'Learning',
  canopy: 'The code map',
  cortex: 'Context for sessions',
};

/** The capability each task needs switched on. */
export const TASK_CAPABILITY: Readonly<Record<string, string>> = {
  'extract-curate': 'vault_evolution',
  'vault-seed': 'vault_evolution',
  'canopy-map': 'canopy',
};

/** "Learning is switched off for this project." */
export function capabilityOffWords(capability: string): string {
  return `${CAPABILITY_NAMES[capability] ?? 'This task'} is switched off for this project.`;
}

/** What a member reads when their day of a task is spent. */
export function dailyLimitWords(refusal: Pick<DailyLimitRefusal, 'perDay' | 'resetsAt'>, now: number): string {
  if (refusal.resetsAt === null || refusal.perDay <= 0) return 'Only an admin can start this task on this server.';
  return `You’ve started this task ${times(refusal.perDay)} today; you can again ${laterWords(refusal.resetsAt, now)}.`;
}

/** An instant still to come: "at 18:30" today, "tomorrow at 09:12", else "on Oct 2 at 09:12". */
export function laterWords(at: number, now: number): string {
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  if (days <= 0) return `at ${clockTime(at)}`;
  if (days === 1) return `tomorrow at ${clockTime(at)}`;
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${clockTime(at)}`;
}

/** Whether a refusal body is a 409 `capability_off`. */
export function isCapabilityOff(body: unknown): body is CapabilityOffRefusal {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'capability_off' && typeof (body as { capability?: unknown }).capability === 'string';
}

/** Whether a refusal body is a 403 `fresh_needs_admin`. */
export function isFreshNeedsAdmin(body: unknown): body is FreshNeedsAdminRefusal {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'fresh_needs_admin';
}

/** Whether a refusal body is a 429 `daily_limit`. */
export function isDailyLimit(body: unknown): body is DailyLimitRefusal {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'daily_limit' && typeof (body as { perDay?: unknown }).perDay === 'number';
}

/** A number of tokens as a person says it: "617K", "2 million", "36.4 million". */
export function tokenWords(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toLocaleString()} million`;
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString()}K`;
  return n.toLocaleString();
}

/** A cost in dollars: "$44.54", "under $0.01". */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/** A least-to-greatest range in words, as "4 to 10 minutes"; one value when the two meet. */
function rangeWords(range: Range, say: (n: number) => string): string | null {
  if (range === null) return null;
  const [low, high] = range;
  return say(low) === say(high) ? say(low) : `${say(low)} to ${say(high)}`;
}

/** How long a run took, as "4 to 10 minutes", "about a minute". */
function tookWords(range: Range): string | null {
  if (range === null) return null;
  const [low, high] = range.map((ms) => Math.max(1, Math.round(ms / 60_000)));
  if (low === high) return low === 1 ? 'about a minute' : `about ${low} minutes`;
  return `${low} to ${high} minutes`;
}

/**
 * What one completed run of a task spent over the window, as the confirmation
 * states it, and how long those runs took; each null when no completed run reported it.
 * `lead` names the window ("This week"), `noun` the runs ("updates").
 */
export function spendWords(spend: { tokens: Range; costUsd: Range; durationMs: Range } | undefined, noun: string, lead: string): { spend: string | null; took: string | null } {
  if (spend === undefined) return { spend: null, took: null };
  const tokens = rangeWords(spend.tokens, tokenWords);
  const cost = rangeWords(spend.costUsd, dollars);
  const parts = [tokens === null ? null : `used ${tokens} tokens`, cost === null ? null : `about ${cost} by the agent’s estimate`].filter((p): p is string => p !== null);
  const took = tookWords(spend.durationMs);
  return {
    spend: parts.length === 0 ? null : `${lead}’s ${noun} each ${parts.join(', ')}.`,
    took: took === null ? null : `Recent ones took ${took}.`,
  };
}

/** A queued run's line: its place in the queue and what holds it. */
export function queuedWords(run: { position: number | null; heldBy: string | null }): string {
  const ahead = run.position ?? 0;
  const turn = ahead === 0 ? 'next in line' : `${ahead} ahead of it`;
  const holder = run.heldBy === null ? 'a limit' : (heldByWords(run.heldBy) ?? run.heldBy);
  return `waiting — ${turn} · held by ${holder}`;
}

/** What a deploy did to a run, in the reader's words: nothing for an ordinary run. */
export function deployWords(run: { replaced: boolean; replaces: string | null }): string | null {
  if (run.replaced) return 'Replaced during a deploy';
  if (run.replaces !== null) return 'Started again after a deploy';
  return null;
}

/**
 * Where a run ran, as the page may say it: the machine's name when the server
 * names it to this viewer, else whose machine it was. Never the machine's id,
 * and nothing at all when neither is known. `name` turns a member id into a
 * name ("you" for the viewer), or null.
 */
export interface RanOn {
  /** A line in a list: "on Ada's studio Mac", "on your machine", "from Lin". */
  list: string;
  /** The panel's fact and a failure note: "Ada's studio Mac", "Lin's machine", "Your machine". */
  machine: string;
}

export function ranOn(worker: RunWorker | null, name: (id: string) => string | null): RanOn | null {
  if (worker === null) return null;
  const named = worker.machineName?.trim() ?? '';
  if (named !== '') return { list: `on ${named}`, machine: named };
  const member = worker.member ?? null;
  if (member === null) return null;
  const who = name(member.id) ?? memberLabel(member);
  if (who === null) return null;
  // The viewer's own machine reads as theirs whether or not it has a name; only another member's reads "from" them.
  if (who === 'you') return { list: 'on your machine', machine: 'Your machine' };
  return { list: `from ${who}`, machine: `${who}’s machine` };
}

/**
 * The dashboard's sentence for a stored run failure, including unknown and older codes. A run whose agent could not
 * use the chosen model says why where the worker that ran it gave a reason (`reason`); the run's own record of the
 * failure is left to its technical details.
 */
export function runErrorWords(code: string | null | undefined, reason: string | null = null): string {
  const words: Readonly<Record<string, string>> = {
    machine_did_not_start: 'No machine started the task within a day.',
    machine_unresponsive: 'The machine running it stopped responding.',
    task_start_failed: 'The machine could not start the task.',
    model_not_applied: 'The agent couldn’t use the chosen model.',
    report_without_audit: 'The agent didn’t account for the steps it took, so its work couldn’t be checked.',
    run_failed: 'The task stopped before it could finish.',
  };
  if (code === 'model_not_applied' && reason !== null) return `The agent couldn’t use the chosen model: ${reason}.`;
  return words[code ?? ''] ?? words.run_failed!;
}

/** A coded failure uses the dashboard's sentence; an uncoded report retains its own words. */
export function failureWords(failure: WorkRun['failure'] | undefined): string {
  return failure?.source === 'report' && failure.code == null ? causeSentence(failure.cause ?? '') : runErrorWords(failure?.code, failure?.reason ?? null);
}

/** Machine-reported reasons are available inside the failure's details disclosure. */
export function failureDetail(failure: WorkRun['failure'] | undefined): string | null {
  if (failure == null || (failure.source === 'report' && failure.code == null)) return null;
  return [failure.error, failure.cause].filter((text): text is string => typeof text === 'string' && text.trim() !== '').join('\n') || null;
}
