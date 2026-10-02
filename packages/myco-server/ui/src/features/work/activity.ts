/**
 * What a run did, as one account built from three records: the calls Myco answered (its own record), the steps the
 * run's worker saw the agent's tools take (metadata only, each target in its shaped form), and the account the agent
 * filed with its report. Every list row, the files it read, the summary line, the evidence coverage and every check
 * of the agent's account against what was seen is built here, from the records alone: no harness is named, a step
 * reads by its kind, and what a harness's own tools did reads from its manifest's words (`STEP_WORDS`).
 *
 * A Myco call the worker also saw is one row. Calls and steps carry no shared id, so a step of kind `myco` is paired
 * with a call of the same tool and operation, inside the attempt whose claim the call followed, by the nearest
 * recorded time: a step with no call, or a call with no step, leaves the others paired as they were.
 *
 * Checks are deterministic. Both sides of a comparison pass through the same shaping (`commandShape`), and where a
 * shaped form holds `…`, words not kept, a comparison it cannot settle reads "can't compare" rather than a flag; only
 * what is provably different is flagged.
 */
import { commandShape, pathShape } from '@goondocks/myco-shared/command-shape';
import { STEP_WORDS } from '@goondocks/myco-shared/runner-step-words.generated';
import type { StepKind } from '@goondocks/myco-shared/worker-steps';
import { callWords } from './call-words';
import { count, listed } from '../today/words';
import { times } from './words';
import type { RunAttempt, RunAudit, RunCall, RunStep } from './wire';

/** The mark a shaped form carries where it kept no word. */
export const ELIDED = '…';

/** How far apart, on the two clocks, a step and a Myco call may be recorded and still be read as the same call. */
export const PAIR_SLACK_MS = 30_000;

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
  /** A failed step a later step of the same kind and the same shaped target succeeded at. */
  retried: boolean;
  /** A failed call to Myco a later call to the same operation succeeded at; what each carried is not recorded. */
  laterSuccess: boolean;
  durationMs: number | null;
  call: RunCall | null;
  step: RunStep | null;
}

/** Leads for a step by its kind: with a target, and without one. */
const STEP_LEADS: Readonly<Record<Exclude<StepKind, 'myco' | 'tool'>, readonly [string, string]>> = {
  read: ['Read', 'Read a file'],
  search: ['Searched', 'Searched the files'],
  edit: ['Edited', 'Edited a file'],
  command: ['Ran', 'Ran a command'],
  fetch: ['Looked up', 'Looked something up online'],
};

/** The names a step falls back to where its harness names a call nothing narrower. */
const UNNAMED_TOOLS: ReadonlySet<string> = new Set(['tool', 'call', 'other']);

/** The Myco tool a step names: its tool's last segment where that is a `myco_…` name, as Myco records the call. */
export function mycoToolOf(stepTool: string): string {
  const tail = stepTool.split(/__|[./:]/).at(-1) ?? stepTool;
  return /^myco_[a-z_]+$/.test(tail) ? tail : stepTool;
}

/** A tool's name in plain words: `ToolSearch` reads "tool search", `web_fetch` reads "web fetch". */
function plainName(tool: string): string {
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:/]+/g, ' ').trim().toLowerCase();
}

/** A target worth showing: one that keeps at least one word. */
const shown = (target: string | null): string | null => (target === null || target.replaceAll(ELIDED, '').trim() === '' ? null : target);

function stepLead(step: RunStep, harness: string | null): { lead: string; target: string | null } {
  if (step.kind === 'myco') return { lead: callWords(mycoToolOf(step.tool), step.target), target: null };
  if (step.kind === 'tool') {
    const words = harness === null ? undefined : STEP_WORDS[harness]?.[step.tool];
    return { lead: words ?? (UNNAMED_TOOLS.has(step.tool) ? 'Used a tool' : `Used ${plainName(step.tool)}`), target: null };
  }
  const target = shown(step.target);
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

function fromStep(step: RunStep, call: RunCall | null, harness: string | null): ActivityRow {
  if (call !== null) {
    const known = callState(call);
    return {
      key: `step-${step.seq}`, at: step.startedAt, lead: callWords(call.tool, call.op), target: null,
      state: known === 'unknown' ? STEP_STATE[step.outcome] : known, reason: callReason(call) ?? stepReason(step),
      retried: false, laterSuccess: false, durationMs: call.durationMs ?? stepDuration(step), call, step,
    };
  }
  return {
    key: `step-${step.seq}`, at: step.startedAt, ...stepLead(step, harness), state: STEP_STATE[step.outcome], reason: stepReason(step),
    retried: false, laterSuccess: false, durationMs: stepDuration(step), call: null, step,
  };
}

function fromCall(call: RunCall): ActivityRow {
  return {
    key: `call-${call.id}`, at: call.recordedAt, lead: callWords(call.tool, call.op), target: null, state: callState(call),
    reason: callReason(call), retried: false, laterSuccess: false, durationMs: call.durationMs, call, step: null,
  };
}

/** How far a call recorded at `at` is from a step's span, on the two clocks. */
function distance(step: RunStep, at: number): number {
  const end = step.endedAt ?? step.startedAt;
  return at < step.startedAt ? step.startedAt - at : at > end ? at - end : 0;
}

/** How far a call recorded at `at` is from when the step ended: Myco records a call as it answers it. */
const fromEnd = (step: RunStep, at: number): number => Math.abs((step.endedAt ?? step.startedAt) - at);

/**
 * Each Myco step paired with the call it was, by its step number: a step and a call of the same tool and operation,
 * nearest first (inside the step's span, then nearest its end, since Myco records a call as it answers it), within
 * `PAIR_SLACK_MS` of the step's span, each used once. Order never decides it, so a step whose call
 * Myco did not record, or a call no step names, leaves every other pair as it is.
 */
function pairCalls(calls: readonly RunCall[], steps: readonly RunStep[]): Map<number, RunCall> {
  const byKey = new Map<string, { calls: RunCall[]; steps: RunStep[] }>();
  const group = (key: string) => {
    let entry = byKey.get(key);
    if (entry === undefined) { entry = { calls: [], steps: [] }; byKey.set(key, entry); }
    return entry;
  };
  for (const call of calls) group(callKey(call.tool, call.op)).calls.push(call);
  for (const step of steps) if (step.kind === 'myco') group(callKey(mycoToolOf(step.tool), step.target)).steps.push(step);
  const pairs = new Map<number, RunCall>();
  for (const entry of byKey.values()) {
    if (entry.calls.length === 0 || entry.steps.length === 0) continue;
    const candidates: { step: RunStep; call: RunCall; gap: number; end: number }[] = [];
    for (const step of entry.steps) for (const call of entry.calls) {
      const gap = distance(step, call.recordedAt);
      if (gap <= PAIR_SLACK_MS) candidates.push({ step, call, gap, end: fromEnd(step, call.recordedAt) });
    }
    candidates.sort((a, b) => a.gap - b.gap || a.end - b.end || a.step.seq - b.step.seq || a.call.id - b.call.id);
    const used = new Set<number>();
    for (const { step, call } of candidates) {
      if (pairs.has(step.seq) || used.has(call.id)) continue;
      pairs.set(step.seq, call);
      used.add(call.id);
    }
  }
  return pairs;
}

/** What makes a later step the same step tried again: its kind and its shaped target, where that keeps every word. */
function retryKey(row: ActivityRow): string | null {
  if (row.call !== null || row.step === null || row.step.kind === 'myco' || row.step.kind === 'tool') return null;
  const target = row.step.target;
  return target === null || target.includes(ELIDED) ? null : `${row.step.kind}:${target}`;
}

const failedState = (state: RowState): boolean => state === 'failed' || state === 'refused';

/**
 * One attempt's activity in order: the worker's steps in step order, each Myco call the worker also saw folded into
 * its step, and every call the worker did not see placed by when Myco recorded it. `harness` names whose step words
 * describe its own tools.
 */
export function attemptActivity(calls: readonly RunCall[], steps: readonly RunStep[], harness: string | null = null): ActivityRow[] {
  const pairs = pairCalls(calls, steps);
  const paired = new Set<number>();
  for (const call of pairs.values()) paired.add(call.id);
  const stepRows = steps.map((step) => fromStep(step, pairs.get(step.seq) ?? null, harness));
  const callRows = calls.filter((call) => !paired.has(call.id)).map(fromCall);
  const rows: ActivityRow[] = [];
  let c = 0;
  for (const row of stepRows) {
    while (c < callRows.length && callRows[c]!.at < row.at) rows.push(callRows[c++]!);
    rows.push(row);
  }
  while (c < callRows.length) rows.push(callRows[c++]!);
  const lastSuccess = new Map<string, number>();
  const lastCallSuccess = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.state !== 'ok') return;
    const key = retryKey(row);
    if (key !== null) lastSuccess.set(key, index);
    if (row.call !== null) lastCallSuccess.set(callKey(row.call.tool, row.call.op), index);
  });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!failedState(row.state)) continue;
    const key = retryKey(row);
    if (key !== null && (lastSuccess.get(key) ?? -1) > index) row.retried = true;
    if (row.call !== null && (lastCallSuccess.get(callKey(row.call.tool, row.call.op)) ?? -1) > index) row.laterSuccess = true;
  }
  return rows;
}

/**
 * The index of the attempt a moment on Myco's clock falls in: the latest attempt claimed at or before it; -1 where it
 * falls before every attempt listed, or the run lists none, so it cannot be placed.
 */
export function attemptAt(attempts: readonly Pick<RunAttempt, 'claimedAt'>[], at: number): number {
  let found = -1;
  attempts.forEach((attempt, index) => { if (attempt.claimedAt <= at) found = index; });
  return found;
}

/**
 * Each attempt's calls, by the attempt whose claim each call followed, and the calls no listed attempt holds. A run
 * that lists no attempt keeps every call in its one list.
 */
export function callsByAttempt(calls: readonly RunCall[], attempts: readonly Pick<RunAttempt, 'claimedAt'>[]): { lists: RunCall[][]; unplaced: RunCall[] } {
  if (attempts.length === 0) return { lists: [[...calls]], unplaced: [] };
  const lists: RunCall[][] = attempts.map(() => []);
  const unplaced: RunCall[] = [];
  for (const call of calls) {
    const at = attemptAt(attempts, call.recordedAt);
    if (at < 0) unplaced.push(call); else lists[at]!.push(call);
  }
  return { lists, unplaced };
}

/** How much of what the worker saw an attempt's list holds. */
export type CoverageState = 'complete' | 'partial' | 'pending' | 'unavailable';

export interface Coverage {
  state: CoverageState;
  /** Why it is unavailable: no attempt was recorded, or its step log could not be loaded. */
  reason: 'none' | 'unloaded' | null;
  /** Steps the worker saw and kept. */
  total: number;
  /** Of them, those Myco holds. */
  received: number;
  /** Of them, those this page has loaded. */
  loaded: number;
  /** Steps past the log's bound, seen but not kept. */
  overflow: number;
  /** Records of the agent's output that might have held a step and that the worker could not read. */
  unrecognized: number;
}

const EMPTY = { total: 0, received: 0, loaded: 0, overflow: 0, unrecognized: 0 };

/**
 * The coverage of one attempt's list: unavailable where no claim recorded an attempt (a run from before step logs, or
 * one no worker ran) or its log could not be loaded, pending where the attempt's log has not arrived, partial where
 * steps are seen but not listed or records that might hold one could not be read, and complete otherwise.
 */
export function coverageOf(attempt: RunAttempt | null, loaded: number, loadComplete: boolean, loadFailed = false): Coverage {
  if (attempt === null) return { state: 'unavailable', reason: 'none', ...EMPTY };
  if (loadFailed) return { state: 'unavailable', reason: 'unloaded', ...EMPTY };
  const steps = attempt.steps;
  if (steps === null) return { state: 'pending', reason: null, ...EMPTY };
  const unrecognized = steps.unrecognized?.total ?? 0;
  const whole = steps.received >= steps.total && steps.overflow === 0 && unrecognized === 0 && loadComplete && loaded >= steps.received;
  return { state: whole ? 'complete' : 'partial', reason: null, total: steps.total, received: steps.received, loaded, overflow: steps.overflow, unrecognized };
}

/** Whether a list's steps cover all the worker saw, so a claim with no step can be flagged. */
const stepsWhole = (coverage: Coverage): boolean => coverage.state === 'complete';
/** Whether a list holds the worker's steps at all. */
export const stepsKnown = (coverage: Coverage): boolean => coverage.state === 'complete' || coverage.state === 'partial';

/** Whether a list holds the worker's steps and Myco's calls but no step the worker could name as a call to Myco. */
export function mycoUnnamed(coverage: Coverage, steps: readonly RunStep[], calls: readonly RunCall[]): boolean {
  return stepsKnown(coverage) && calls.length > 0 && !steps.some((step) => step.kind === 'myco');
}

/** What a list's coverage says, in sentences; `live` while the run is still going. */
export function coverageWords(coverage: Coverage, live: boolean, unnamedMyco = false): string[] {
  switch (coverage.state) {
    case 'unavailable':
      return [coverage.reason === 'unloaded'
        ? 'The worker’s step log couldn’t be loaded. This list holds only Myco’s own record of the calls it made.'
        : 'Myco kept no step log for this run: it ran before step logs were kept, or where no worker keeps one. This list holds only Myco’s own record of the calls it made.'];
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
      if (coverage.unrecognized > 0) words.push(`The worker couldn’t read ${count(coverage.unrecognized, 'record')} of the agent’s output that might have held a step; any step in ${coverage.unrecognized === 1 ? 'it' : 'them'} isn’t listed.`);
      if (coverage.state === 'complete') words.push('Every step the worker saw is listed.');
      if (unnamedMyco) words.push('The worker couldn’t tell which of its steps were calls to Myco, so Myco’s own record of those calls is listed apart.');
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
 * what its Myco calls kept, then how many steps failed, how many of those were retried, and how many weren't allowed.
 * A retry is the same step on the same target; a later call to the same Myco operation is not counted as one. Without
 * the worker's steps it counts the calls Myco recorded instead, and says nothing of files. Null where the list holds
 * nothing.
 */
export function summaryWords(rows: readonly ActivityRow[], known: boolean, files: FilesRead): string | null {
  if (rows.length === 0) return null;
  const parts: string[] = [];
  if (known) {
    let searches = 0;
    let commands = 0;
    let fetches = 0;
    const edited = new Set<string>();
    for (const row of rows) {
      const step = row.step;
      if (step === null) continue;
      if (step.kind === 'search') searches += 1;
      else if (step.kind === 'command' && step.outcome !== 'refused') commands += 1;
      else if (step.kind === 'fetch') fetches += 1;
      else if (step.kind === 'edit') edited.add(step.target ?? `#${step.seq}`);
    }
    const read = files.paths.length + files.unnamed;
    if (read > 0) parts.push(`read ${count(read, 'file')}`);
    if (searches > 0) parts.push(`searched ${times(searches)}`);
    if (commands > 0) parts.push(`ran ${count(commands, 'command')}`);
    if (edited.size > 0) parts.push(`edited ${count(edited.size, 'file')}`);
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

/** Whether the claim's words all appear among the seen command's words, in order, each equal. */
function inOrder(claim: readonly string[], seen: readonly string[]): boolean {
  let j = 0;
  for (const word of claim) {
    while (j < seen.length && word !== seen[j]) j += 1;
    if (j === seen.length) return false;
    j += 1;
  }
  return true;
}

/**
 * Whether the claim's words could appear among the seen command's words, in order, once `…` is read as the words it
 * stands for: a claimed word matches a seen word it could be, and a seen `…` takes in any number of claimed words.
 */
function couldBeInOrder(claim: readonly string[], seen: readonly string[]): boolean {
  let j = 0;
  for (const word of claim) {
    while (j < seen.length && seen[j] !== ELIDED && compareWord(word, seen[j]!) === 'different') j += 1;
    if (j === seen.length) return false;
    if (seen[j] !== ELIDED) j += 1;
  }
  return true;
}

/** Whether two shaped word lists could be the same command, a lone `…` on either side standing for any number of words. */
function couldMatch(a: readonly string[], b: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true;
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    if (i < a.length && a[i] === ELIDED) result = go(i + 1, j) || (j < b.length && go(i, j + 1));
    if (!result && j < b.length && b[j] === ELIDED) result = go(i, j + 1) || (i < a.length && go(i + 1, j));
    if (!result && i < a.length && j < b.length && a[i] !== ELIDED && b[j] !== ELIDED) result = compareWord(a[i]!, b[j]!) !== 'different' && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/**
 * A claimed command against one run of a seen command: the same where the claim's words all appear in it in order (a
 * claim may leave out the flags, paths and other commands a command line carried), unsettled where they could appear once a `…` on either
 * side is read as the words it stands for, and different otherwise.
 */
function compareWords(claim: readonly string[], seen: readonly string[]): Compared {
  if (claim.length === 0) return 'unsettled';
  if (inOrder(claim, seen)) return 'same';
  if (couldMatch(claim, seen) || couldBeInOrder(claim, seen)) return 'unsettled';
  return 'different';
}

/** A command a step ran, shaped as a claim is, as its words; null where nothing of it is kept. */
export function seenCommand(target: string): string[] | null {
  const shaped = commandShape(target);
  return shaped === null ? null : wordsOf(shaped);
}

/**
 * A claimed command against the commands the worker saw: the best any of them settles, stopping at the first that
 * matches. A claim's words found in order inside a list or pipeline match it, so "npm test" is found in
 * "cd app && npm test".
 */
export function compareClaimedCommand(claim: string, seen: readonly (readonly string[])[]): Compared {
  const shaped = commandShape(claim);
  if (shaped === null) return 'unsettled';
  const words = wordsOf(shaped);
  let found: Compared = 'different';
  for (const command of seen) {
    const result = compareWords(words, command);
    if (result === 'same') return 'same';
    if (result === 'unsettled') found = 'unsettled';
  }
  return found;
}

/** A claimed command against one the worker saw, both shaped the same way. */
export function compareCommand(claim: string, seen: string): Compared {
  const words = seenCommand(seen);
  return words === null ? 'different' : compareClaimedCommand(claim, [words]);
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

/** A claimed path against the paths the worker saw, stopping at the first that matches. */
function compareClaimedPath(claim: string, seen: readonly string[]): Compared {
  if (claim.includes(ELIDED)) return 'unsettled';
  let found: Compared = 'different';
  for (const path of seen) {
    const result = comparePath(claim, path);
    if (result === 'same') return 'same';
    if (result === 'unsettled') found = 'unsettled';
  }
  return found;
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
 * A claim is flagged only against a complete step log, and only where it is provably different from every step: a
 * command found among a step's words in order matches, and where a shaped form holds `…` that could stand for the step,
 * or the log is incomplete, the check says it can't compare.
 */
export function auditChecks(audit: RunAudit, rows: readonly ActivityRow[], steps: readonly RunStep[], coverage: Coverage): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const known = stepsKnown(coverage);
  if (known) {
    let commands = 0;
    for (const step of steps) if (step.kind === 'command' && step.outcome !== 'refused') commands += 1;
    if (commands > 0 && audit.commands.length === 0) {
      checks.push({ verdict: 'flag', words: `The worker saw ${count(commands, 'command')} run; the agent’s account lists no commands.` });
    }
    const reads = filesRead(steps);
    const read = reads.paths.length + reads.unnamed;
    if (read > 0 && audit.examined.length === 0) {
      checks.push({ verdict: 'flag', words: `The worker saw ${count(read, 'file')} read; the agent’s account lists none as examined.` });
    }
  }
  let failed = 0;
  let refused = 0;
  for (const row of rows) {
    if (row.state === 'failed') failed += 1;
    else if (row.state === 'refused') refused += 1;
  }
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
  if (audit.commands.length > 0) {
    const seen: string[][] = [];
    for (const step of steps) {
      if (step.kind !== 'command' || step.target === null) continue;
      const words = seenCommand(step.target);
      if (words !== null) seen.push(words);
    }
    for (const claim of audit.commands) {
      const result = compareClaimedCommand(claim, seen);
      if (result === 'same') continue;
      if (result === 'unsettled') checks.push({ verdict: 'unsettled', words: `Can’t compare the command ${quoted(claim)} with what the worker saw: part of it isn’t kept.` });
      else if (!whole) checks.push({ verdict: 'unsettled', words: `Can’t compare the command ${quoted(claim)}: the step log is incomplete.` });
      else checks.push({ verdict: 'flag', words: `The agent’s account lists the command ${quoted(claim)}; the worker saw no such command.` });
    }
  }
  if (audit.examined.length > 0) {
    const paths = seenPaths(steps);
    let elided = 0;
    for (const claim of audit.examined) {
      if (claim.replaceAll(ELIDED, '').trim() === '') { elided += 1; continue; }
      const result = compareClaimedPath(claim, paths);
      if (result === 'same') continue;
      if (result === 'unsettled') checks.push({ verdict: 'unsettled', words: `Can’t compare ${claim} with what the worker saw: part of a path isn’t kept.` });
      else if (!whole) checks.push({ verdict: 'unsettled', words: `Can’t compare ${claim}: the step log is incomplete.` });
      else checks.push({ verdict: 'flag', words: `The agent’s account lists ${claim} as examined; the worker saw no step on it.` });
    }
    if (elided > 0) {
      checks.push({ verdict: 'unsettled', words: `Can’t compare ${elided === 1 ? 'one entry' : `${elided.toLocaleString()} entries`} the agent lists as examined: ${elided === 1 ? 'it isn’t a file path' : 'they aren’t file paths'}.` });
    }
  }
  return checks;
}
