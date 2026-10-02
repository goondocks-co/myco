/**
 * What a run did, as one account built from three records: the calls Myco answered (its own record), the steps the
 * run's worker saw the agent's tools take (metadata only, each target in its shaped form), and the account the agent
 * filed with its report. Every list row, the files it read, the summary line, the evidence coverage and every check
 * of the agent's account against what was seen is built here, from the records alone: no harness is named, and a step
 * reads by its kind.
 *
 * A Myco call the worker also saw is one row. Calls and steps carry no shared id, so a step of kind `myco` is paired
 * with the call of the same tool and operation in the same order, inside the attempt whose claim the call followed.
 *
 * Checks are deterministic. Both sides of a comparison pass through the same shaping (`commandShape`), and where a
 * shaped form holds `…`, a word not kept, a comparison it cannot settle reads "can't compare" rather than a flag.
 */
import { commandShape, pathShape } from '@goondocks/myco-shared/command-shape';
import type { StepKind } from '@goondocks/myco-shared/worker-steps';
import { callWords } from './call-words';
import { count, listed } from '../today/words';
import { times } from './words';
import type { RunAttempt, RunAudit, RunCall, RunStep } from './wire';

/** The mark a shaped form carries where it kept no word. */
export const ELIDED = '…';

export type RowState = 'ok' | 'failed' | 'refused' | 'unfinished' | 'unknown';

/** One thing a run did, from Myco's record, the worker's, or both. */
export interface ActivityRow {
  key: string;
  /** When it started: the worker's time for a step, Myco's for a call only Myco recorded. */
  at: number;
  /** What it did, in reader words. */
  lead: string;
  /** The shaped target it aimed at, shown as written; null where it names none. */
  target: string | null;
  state: RowState;
  /** Why it failed, where a record says. */
  reason: string | null;
  /** A failed row a later row of the same action and target succeeded at. */
  retried: boolean;
  durationMs: number | null;
  call: RunCall | null;
  step: RunStep | null;
}

/** Leads for a step by its kind: with a target, and without one. */
const STEP_LEADS: Readonly<Record<Exclude<StepKind, 'myco'>, readonly [string, string]>> = {
  read: ['Read', 'Read a file'],
  search: ['Searched', 'Searched the files'],
  edit: ['Edited', 'Edited a file'],
  command: ['Ran', 'Ran a command'],
  fetch: ['Looked up', 'Looked something up online'],
  tool: ['Used a tool', 'Used a tool'],
};

/** The Myco tool a step names: its tool's last segment where that is a `myco_…` name, as Myco records the call. */
export function mycoToolOf(stepTool: string): string {
  const tail = stepTool.split(/__|[./:]/).at(-1) ?? stepTool;
  return /^myco_[a-z_]+$/.test(tail) ? tail : stepTool;
}

/** A target worth showing: one that keeps at least one word. */
const shown = (target: string | null): string | null => (target === null || target.replaceAll(ELIDED, '').trim() === '' ? null : target);

function stepLead(step: RunStep): { lead: string; target: string | null } {
  if (step.kind === 'myco') return { lead: callWords(mycoToolOf(step.tool), step.target), target: null };
  const target = step.kind === 'tool' ? null : shown(step.target);
  const [withTarget, without] = STEP_LEADS[step.kind];
  return target === null ? { lead: without, target: null } : { lead: withTarget, target };
}

const STEP_STATE: Readonly<Record<RunStep['outcome'], RowState>> = { ok: 'ok', error: 'failed', refused: 'refused', unfinished: 'unfinished' };

function stepReason(step: RunStep): string | null {
  if (step.outcome === 'refused') return 'The agent wasn’t allowed to use this tool.';
  if (step.outcome === 'error' && step.exitCode !== null) return `It exited with code ${step.exitCode}.`;
  if (step.outcome === 'unfinished') return 'It hadn’t finished when the run ended.';
  return null;
}

function callState(call: RunCall): RowState {
  return call.status === 'success' ? 'ok' : call.status === 'failed' ? 'failed' : 'unknown';
}

function callReason(call: RunCall): string | null {
  if (call.failure !== undefined && call.failure.message.trim() !== '') return call.failure.message;
  return call.status === 'failed' ? 'Myco didn’t record why.' : null;
}

const callKey = (tool: string, op: string | null): string => `${tool}/${op ?? ''}`;

const stepDuration = (step: RunStep): number | null => (step.endedAt === null ? null : Math.max(0, step.endedAt - step.startedAt));

function fromStep(step: RunStep, call: RunCall | null): ActivityRow {
  if (call !== null) {
    const known = callState(call);
    return {
      key: `step-${step.seq}`, at: step.startedAt, lead: callWords(call.tool, call.op), target: null,
      state: known === 'unknown' ? STEP_STATE[step.outcome] : known, reason: callReason(call) ?? stepReason(step), retried: false,
      durationMs: call.durationMs ?? stepDuration(step), call, step,
    };
  }
  return {
    key: `step-${step.seq}`, at: step.startedAt, ...stepLead(step), state: STEP_STATE[step.outcome], reason: stepReason(step), retried: false,
    durationMs: stepDuration(step), call: null, step,
  };
}

function fromCall(call: RunCall): ActivityRow {
  return {
    key: `call-${call.id}`, at: call.recordedAt, lead: callWords(call.tool, call.op), target: null, state: callState(call),
    reason: callReason(call), retried: false, durationMs: call.durationMs, call, step: null,
  };
}

/** What makes two rows the same action on the same target, for telling a failure that was retried; null for none. */
function retryKey(row: ActivityRow): string | null {
  if (row.call !== null) return `call:${callKey(row.call.tool, row.call.op)}`;
  if (row.step === null || row.target === null) return null;
  return `${row.step.kind}:${row.step.kind === 'myco' ? mycoToolOf(row.step.tool) : row.step.tool}:${row.target}`;
}

const failedState = (state: RowState): boolean => state === 'failed' || state === 'refused';

/**
 * One attempt's activity in order: the worker's steps in step order, each Myco call the worker also saw folded into
 * its step, and every call the worker did not see placed by when Myco recorded it.
 */
export function attemptActivity(calls: readonly RunCall[], steps: readonly RunStep[]): ActivityRow[] {
  const waiting = new Map<string, RunCall[]>();
  for (const call of calls) {
    const key = callKey(call.tool, call.op);
    waiting.set(key, [...(waiting.get(key) ?? []), call]);
  }
  const paired = new Set<number>();
  const stepRows = steps.map((step) => {
    if (step.kind !== 'myco') return fromStep(step, null);
    const call = waiting.get(callKey(mycoToolOf(step.tool), step.target))?.shift() ?? null;
    if (call !== null) paired.add(call.id);
    return fromStep(step, call);
  });
  const callRows = calls.filter((call) => !paired.has(call.id)).map(fromCall);
  const rows: ActivityRow[] = [];
  let c = 0;
  for (const row of stepRows) {
    while (c < callRows.length && callRows[c]!.at < row.at) rows.push(callRows[c++]!);
    rows.push(row);
  }
  rows.push(...callRows.slice(c));
  const succeeded = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = retryKey(row);
    if (key !== null && row.state === 'ok') succeeded.set(key, index);
  });
  return rows.map((row, index) => {
    const key = retryKey(row);
    return failedState(row.state) && key !== null && (succeeded.get(key) ?? -1) > index ? { ...row, retried: true } : row;
  });
}

/** The index of the attempt a moment on Myco's clock falls in: the latest attempt claimed at or before it, else the first. */
export function attemptAt(attempts: readonly Pick<RunAttempt, 'claimedAt'>[], at: number): number {
  let found = 0;
  attempts.forEach((attempt, index) => { if (attempt.claimedAt <= at) found = index; });
  return found;
}

/** Each attempt's calls, by the attempt whose claim each call followed. */
export function callsByAttempt(calls: readonly RunCall[], attempts: readonly Pick<RunAttempt, 'claimedAt'>[]): RunCall[][] {
  const out: RunCall[][] = attempts.length === 0 ? [[]] : attempts.map(() => []);
  for (const call of calls) out[attempts.length === 0 ? 0 : attemptAt(attempts, call.recordedAt)]!.push(call);
  return out;
}

/** How much of what the worker saw an attempt's list holds. */
export type CoverageState = 'complete' | 'partial' | 'pending' | 'unavailable';

export interface Coverage {
  state: CoverageState;
  /** Steps the worker saw and kept. */
  total: number;
  /** Of them, those Myco holds. */
  received: number;
  /** Of them, those this page has loaded. */
  loaded: number;
  /** Steps past the log's bound, seen but not kept. */
  overflow: number;
  /** Records of the agent's output the worker could not read. */
  unrecognized: number;
}

/**
 * The coverage of one attempt's list: unavailable where no claim recorded an attempt (a run from before step logs, or
 * one no worker ran), pending where the attempt's log has not arrived, partial where steps are seen but not listed,
 * and complete where every step the worker kept is listed.
 */
export function coverageOf(attempt: RunAttempt | null, loaded: number, loadComplete: boolean): Coverage {
  if (attempt === null) return { state: 'unavailable', total: 0, received: 0, loaded: 0, overflow: 0, unrecognized: 0 };
  const steps = attempt.steps;
  if (steps === null) return { state: 'pending', total: 0, received: 0, loaded: 0, overflow: 0, unrecognized: 0 };
  const whole = steps.received >= steps.total && steps.overflow === 0 && loadComplete && loaded >= steps.received;
  return { state: whole ? 'complete' : 'partial', total: steps.total, received: steps.received, loaded, overflow: steps.overflow, unrecognized: steps.unrecognized?.total ?? 0 };
}

/** Whether a list's steps cover all the worker saw, so a claim with no step can be flagged. */
const stepsWhole = (coverage: Coverage): boolean => coverage.state === 'complete';
/** Whether a list holds the worker's steps at all. */
export const stepsKnown = (coverage: Coverage): boolean => coverage.state === 'complete' || coverage.state === 'partial';

/** What a list's coverage says, in sentences; `live` while the run is still going. */
export function coverageWords(coverage: Coverage, live: boolean): string[] {
  switch (coverage.state) {
    case 'unavailable':
      return ['Myco kept no step log for this run: it ran before step logs were kept, or where no worker keeps one. This list holds only Myco’s own record of the calls it made.'];
    case 'pending':
      return [live
        ? 'The worker sends its step log when the run ends. Until then, this list holds only Myco’s own record of the calls it made.'
        : 'The worker’s step log hasn’t arrived; it may still be on its way. Until it does, this list holds only Myco’s own record of the calls it made.'];
    case 'partial':
    case 'complete': {
      const words: string[] = [];
      if (coverage.received < coverage.total) words.push(`${coverage.received.toLocaleString()} of the ${count(coverage.total, 'step')} the worker saw have arrived.`);
      if (coverage.loaded < coverage.received) words.push(`${coverage.loaded.toLocaleString()} of the ${count(coverage.received, 'step')} that arrived are loaded.`);
      if (coverage.overflow > 0) words.push(`The worker saw ${count(coverage.overflow, 'more step', 'more steps')} than a step log keeps; ${coverage.overflow === 1 ? 'it isn’t' : 'they aren’t'} listed.`);
      if (coverage.state === 'complete') words.push('Every step the worker kept is listed.');
      if (coverage.unrecognized > 0) words.push(`The worker couldn’t read ${count(coverage.unrecognized, 'other record')} of the agent’s output; any step in ${coverage.unrecognized === 1 ? 'it' : 'them'} isn’t listed.`);
      return words;
    }
  }
}

/** The files a list's read steps name, each once, and how many reads named no file it kept. */
export interface FilesRead {
  paths: string[];
  unnamed: number;
}

/** Files read: steps of kind `read` that succeeded, by the path they name. A search or a command is activity, never a read. */
export function filesRead(steps: readonly RunStep[]): FilesRead {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const step of steps) {
    if (step.kind !== 'read' || step.outcome !== 'ok') continue;
    const path = step.target === null ? null : pathShape(step.target);
    if (path === null) unnamed += 1;
    else paths.add(path);
  }
  return { paths: [...paths], unnamed };
}

/** What a successful Myco call kept, in the summary's words, by its tool and operation. */
const KEPT_WORDS: Readonly<Record<string, (n: number) => string>> = {
  'myco_run_map/write': () => 'saved the code map',
  'myco_spores/save': (n) => `saved ${count(n, 'spore')}`,
  'myco_spores/supersede': (n) => `replaced ${count(n, 'spore')}`,
  'myco_spores/consolidate': (n) => `combined spores ${times(n)}`,
  'myco_spores/obsolete': (n) => `retired ${count(n, 'spore')}`,
  'myco_run_sessions/title': (n) => (n === 1 ? 'wrote a session title and summary' : `wrote ${count(n, 'session title')} and summaries`),
};

/**
 * The summary line: what the run did, in reader words, from a list's rows: files read, searches, commands, edits and
 * what its Myco calls kept, then how many steps failed and were retried. Without the worker's steps it counts the
 * calls Myco recorded instead, and says nothing of files. Null where the list holds nothing.
 */
export function summaryWords(rows: readonly ActivityRow[], known: boolean, files: FilesRead): string | null {
  if (rows.length === 0) return null;
  const parts: string[] = [];
  const steps = rows.flatMap((row) => (row.step === null ? [] : [row.step]));
  const kinds = (kind: StepKind) => steps.filter((step) => step.kind === kind);
  if (known) {
    const read = files.paths.length + files.unnamed;
    if (read > 0) parts.push(`read ${count(read, 'file')}`);
    const searches = kinds('search').length;
    if (searches > 0) parts.push(`searched ${times(searches)}`);
    const commands = kinds('command').filter((step) => step.outcome !== 'refused').length;
    if (commands > 0) parts.push(`ran ${count(commands, 'command')}`);
    const edited = new Set(kinds('edit').map((step) => step.target ?? `#${step.seq}`)).size;
    if (edited > 0) parts.push(`edited ${count(edited, 'file')}`);
    const fetches = kinds('fetch').length;
    if (fetches > 0) parts.push(`looked things up online ${times(fetches)}`);
  } else {
    const calls = rows.filter((row) => row.call !== null).length;
    if (calls > 0) parts.push(`called Myco ${times(calls)}`);
  }
  const kept = new Map<string, number>();
  for (const row of rows) {
    if (row.call === null || row.state !== 'ok') continue;
    const key = callKey(row.call.tool, row.call.op);
    if (KEPT_WORDS[key] !== undefined) kept.set(key, (kept.get(key) ?? 0) + 1);
  }
  for (const [key, n] of kept) parts.push(KEPT_WORDS[key]!(n));
  if (parts.length === 0) parts.push(known ? `took ${count(rows.length, 'step')}` : `made ${count(rows.length, 'call')}`);
  const sentence = listed(parts);
  const noun = known ? 'step' : 'call';
  const failed = rows.filter((row) => row.state === 'failed');
  const refused = rows.filter((row) => row.state === 'refused');
  const failures = [
    ...(failed.length > 0 ? [outcomeClause(failed, noun, 'failed')] : []),
    ...(refused.length > 0 ? [outcomeClause(refused, noun, refused.length === 1 ? 'wasn’t allowed' : 'weren’t allowed')] : []),
  ];
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${failures.map((words) => `; ${words}`).join('')}.`;
}

/** "1 step failed and was retried", "3 steps failed, 1 of them retried". */
function outcomeClause(rows: readonly ActivityRow[], noun: string, verb: string): string {
  const retried = rows.filter((row) => row.retried).length;
  const words = `${count(rows.length, noun)} ${verb}`;
  if (retried === 0) return words;
  if (retried === rows.length) return `${words} and ${rows.length === 1 ? 'was' : 'were'} retried`;
  return `${words}, ${retried.toLocaleString()} of them retried`;
}

type Compared = 'same' | 'unsettled' | 'different';

const wordsOf = (shape: string): string[] => shape.split(/\s+/).filter((word) => word !== '');

/** Two words: equal, possibly equal where either holds `…`, or different. */
function compareWord(a: string, b: string): Compared {
  if (a === b) return 'same';
  const ai = a.indexOf(ELIDED);
  const bi = b.indexOf(ELIDED);
  if (ai < 0 && bi < 0) return 'different';
  const ap = ai < 0 ? a : a.slice(0, ai);
  const bp = bi < 0 ? b : b.slice(0, bi);
  if (ai >= 0 && bi >= 0) return ap.startsWith(bp) || bp.startsWith(ap) ? 'unsettled' : 'different';
  return ai >= 0 ? (b.startsWith(ap) ? 'unsettled' : 'different') : (a.startsWith(bp) ? 'unsettled' : 'different');
}

/** Whether two shaped word lists could be the same command, a lone `…` on either side standing for one or more words. */
function couldMatch(a: readonly string[], b: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true;
    if (i === a.length || j === b.length) return false;
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    if (a[i] === ELIDED) result = go(i + 1, j + 1) || go(i, j + 1);
    if (!result && b[j] === ELIDED) result = go(i + 1, j + 1) || go(i + 1, j);
    if (!result && a[i] !== ELIDED && b[j] !== ELIDED) result = compareWord(a[i]!, b[j]!) !== 'different' && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function compareWords(a: readonly string[], b: readonly string[]): Compared {
  if (a.length === b.length && a.every((word, i) => word === b[i])) return 'same';
  return couldMatch(a, b) ? 'unsettled' : 'different';
}

const best = (results: Iterable<Compared>): Compared => {
  let found: Compared = 'different';
  for (const result of results) {
    if (result === 'same') return 'same';
    if (result === 'unsettled') found = 'unsettled';
  }
  return found;
};

/** Operators that end one command of a list or pipeline. */
const BREAKS: ReadonlySet<string> = new Set(['|', '||', '&&', ';', '&', '|&']);

/** A command's words and every run of whole commands inside it, so "npm test" is found in "cd app && npm test". */
function commandRuns(words: readonly string[]): string[][] {
  const starts = [0];
  const ends: number[] = [];
  words.forEach((word, i) => { if (BREAKS.has(word)) { ends.push(i); starts.push(i + 1); } });
  ends.push(words.length);
  const runs: string[][] = [];
  for (let s = 0; s < starts.length; s += 1) for (let e = s; e < ends.length; e += 1) runs.push(words.slice(starts[s], ends[e]));
  return runs;
}

/** A claimed command against one the worker saw, both shaped the same way. */
export function compareCommand(claim: string, seen: string): Compared {
  const a = commandShape(claim);
  const b = commandShape(seen);
  if (a === null || b === null) return 'different';
  const claimed = wordsOf(a);
  return best(commandRuns(wordsOf(b)).map((run) => compareWords(claimed, run)));
}

const trimPath = (path: string): string => path.replace(/^\.\//, '').replace(/\/+$/, '');

/** A claimed file or area against a path a step named: the same file, one inside the area, or the same file named from another directory. */
export function comparePath(claim: string, seen: string): Compared {
  if (claim.includes(ELIDED) || seen.includes(ELIDED)) return 'unsettled';
  const a = trimPath(claim);
  const b = trimPath(seen);
  if (a === '' || b === '') return 'different';
  if (a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`) || b.startsWith(`${a}/`) || b.includes(`/${a}/`)) return 'same';
  return 'different';
}

/** The paths a list's steps name: each read, search and edit target, and every path a command names. */
function seenPaths(steps: readonly RunStep[]): string[] {
  const paths: string[] = [];
  for (const step of steps) {
    if (step.target === null) continue;
    if (step.kind === 'read' || step.kind === 'search' || step.kind === 'edit') paths.push(step.target);
    if (step.kind === 'command') for (const word of wordsOf(step.target)) if (pathShape(word) !== null) paths.push(word);
  }
  return paths;
}

/** One check of the agent's account against what was seen: a flag, or a comparison the records can't settle. */
export interface AuditCheck {
  verdict: 'flag' | 'unsettled';
  words: string;
}

const quoted = (text: string): string => `“${text}”`;

/**
 * The agent's account checked against what was seen in the attempt it closed, by fixed rules:
 * - a kind of step the worker saw that the account leaves out: commands run with none listed, files read with none
 *   listed as examined, and failures (steps or Myco calls) with none listed;
 * - a claim with no step: a command or a file the account lists that no step the worker saw names.
 *
 * A claim is compared only against a complete step log; where the log is incomplete, or a shaped form holds `…` that
 * could stand for the step, the check says it can't compare.
 */
export function auditChecks(audit: RunAudit, rows: readonly ActivityRow[], steps: readonly RunStep[], coverage: Coverage): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const known = stepsKnown(coverage);
  if (known) {
    const commands = steps.filter((step) => step.kind === 'command' && step.outcome !== 'refused').length;
    if (commands > 0 && audit.commands.length === 0) {
      checks.push({ verdict: 'flag', words: `The worker saw ${count(commands, 'command')} run; the agent’s account lists no commands.` });
    }
    const reads = filesRead(steps);
    const read = reads.paths.length + reads.unnamed;
    if (read > 0 && audit.examined.length === 0) {
      checks.push({ verdict: 'flag', words: `The worker saw ${count(read, 'file')} read; the agent’s account lists none as examined.` });
    }
  }
  const failed = rows.filter((row) => row.state === 'failed').length;
  const refused = rows.filter((row) => row.state === 'refused').length;
  if (failed + refused > 0 && audit.failures.length === 0) {
    const noun = known ? 'step' : 'call';
    const what = refused === 0 ? `${count(failed, noun)} failed`
      : failed === 0 ? `${count(refused, noun)} ${refused === 1 ? 'wasn’t' : 'weren’t'} allowed`
      : `${count(failed + refused, noun)} failed or weren’t allowed`;
    checks.push({ verdict: 'flag', words: `${what}; the agent’s account lists no failures.` });
  }
  if (!known) {
    if (audit.commands.length + audit.examined.length > 0) {
      checks.push({ verdict: 'unsettled', words: 'Can’t compare the commands and files the agent lists with its steps: Myco holds no step log for this attempt.' });
    }
    return checks;
  }
  const whole = stepsWhole(coverage);
  const commandTargets = steps.flatMap((step) => (step.kind === 'command' && step.target !== null ? [step.target] : []));
  for (const claim of audit.commands) {
    const result = best(commandTargets.map((seen) => compareCommand(claim, seen)));
    if (result === 'same') continue;
    if (result === 'unsettled') checks.push({ verdict: 'unsettled', words: `Can’t compare the command ${quoted(claim)} with what the worker saw: part of it isn’t kept.` });
    else if (!whole) checks.push({ verdict: 'unsettled', words: `Can’t compare the command ${quoted(claim)}: the step log is incomplete.` });
    else checks.push({ verdict: 'flag', words: `The agent’s account lists the command ${quoted(claim)}; the worker saw no such command.` });
  }
  const paths = seenPaths(steps);
  for (const claim of audit.examined) {
    const result = claim.includes(ELIDED) ? 'unsettled' : best(paths.map((seen) => comparePath(claim, seen)));
    if (result === 'same') continue;
    if (result === 'unsettled') checks.push({ verdict: 'unsettled', words: claim.includes(ELIDED) ? 'Can’t compare one entry the agent lists as examined: it isn’t a path Myco keeps.' : `Can’t compare ${claim} with what the worker saw: part of a path it saw isn’t kept.` });
    else if (!whole) checks.push({ verdict: 'unsettled', words: `Can’t compare ${claim}: the step log is incomplete.` });
    else checks.push({ verdict: 'flag', words: `The agent’s account lists ${claim} as examined; the worker saw no step on it.` });
  }
  return checks;
}
