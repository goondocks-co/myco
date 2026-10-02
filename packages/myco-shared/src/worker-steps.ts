import { redactSecrets } from './redact-secrets.js';
import { commandShape, identifierShape, pathShape, urlShape } from './command-shape.js';

/**
 * A worker's step log: what a run's harness did, as metadata only.
 *
 * A step names the action (`kind`), the harness's own tool name, the one target the action aims at (a path, a
 * command line, a URL's host or a Myco operation), its outcome and exit status, when it started and ended, and the
 * harness's call id. It never carries file contents, command output or anything a call returned: the worker reads the
 * target from a field its harness's manifest names, `stepTarget` keeps it to the allowed shape for its kind (a command
 * or a file as `commandShape` keeps it: the first line, the program, flag names without their values, paths, URLs as
 * scheme and host, `…` for every other word; a search's path alone, never its pattern or query; a fetch's URL host,
 * never its query) with known access-key shapes masked after, and a tool's name is kept only where it is an
 * identifier. The Deployment applies the same rules again to every page it stores (`parseStepPage`), keeps a Myco
 * call's operation only where it is one of its own tools' operations, and refuses a page whose tool or shape names are
 * not identifiers.
 *
 * The log travels in pages of at most `STEPS_PER_PAGE` steps. Every page repeats the totals, so a Deployment knows
 * from any page it holds how many steps the attempt observed, how many it could not keep (`overflow`, past
 * `MAX_RUN_STEPS`) and how many stream records the worker could not read (`unrecognized`, counted by shape).
 */

/** Advertised by a Deployment that stores a worker's step log; a worker sends one only to a Deployment advertising it. */
export const WORKER_STEPS_FEATURE = 'worker-steps-v1';

export const STEP_KINDS = ['read', 'search', 'edit', 'command', 'fetch', 'myco', 'tool'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_OUTCOMES = ['ok', 'error', 'refused', 'unfinished'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** The most steps one page carries. */
export const STEPS_PER_PAGE = 100;
/** The most steps one attempt's log keeps; steps past it are counted as `overflow`. */
export const MAX_RUN_STEPS = 2_000;
export const MAX_STEP_PAGES = MAX_RUN_STEPS / STEPS_PER_PAGE;
export const MAX_STEP_TARGET_CHARS = 300;
export const MAX_STEP_TOOL_CHARS = 128;
export const MAX_STEP_CALL_ID_CHARS = 128;
/** The most distinct unrecognized shapes a log names; the rest are counted in `total` alone. */
export const MAX_UNRECOGNIZED_SHAPES = 32;
export const MAX_SHAPE_CHARS = 64;
const MAX_ATTEMPT_ID_CHARS = 128;

export interface WorkerStep {
  seq: number;
  callId: string | null;
  kind: StepKind;
  tool: string;
  target: string | null;
  outcome: StepOutcome;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

export interface UnrecognizedCount {
  total: number;
  shapes: Record<string, number>;
}

export interface StepPage {
  attemptId: string;
  page: number;
  pages: number;
  total: number;
  overflow: number;
  unrecognized: UnrecognizedCount;
  steps: WorkerStep[];
}

export class WorkerStepsError extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** One line of at most `max` characters, control characters folded to spaces. */
function line(value: string, max: number): string {
  const folded = value.replace(CONTROL, ' ').trim();
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

/** A pattern's own characters, which no path a search names carries. */
const PATTERN = /[*?[\]{}]/;

/**
 * A step's raw target in its allowed shape for the step's kind: a command as `commandShape` keeps it, a file read or
 * edited as a command-shaped path, a search only where its target is a path with no pattern character in it, a fetch
 * as its URL's scheme and host, a Myco call as its operation's identifier, and nothing for any other call. Where
 * `mycoOps` is given, a Myco call keeps its operation only where `mycoOps` lists it. A search's pattern or query and a
 * fetch's query are never kept.
 */
function shapeFor(raw: string, kind: StepKind, mycoOps?: ReadonlySet<string>): string | null {
  switch (kind) {
    case 'command': case 'read': case 'edit': return commandShape(raw);
    case 'search': { const path = pathShape(raw); return path === null || PATTERN.test(path) ? null : path; }
    case 'fetch': return urlShape(raw.trim());
    case 'myco': { const op = identifierShape(raw, MAX_SHAPE_CHARS); return op === null || (mycoOps !== undefined && !mycoOps.has(op)) ? null : op; }
    case 'tool': return null;
  }
}

/**
 * A step's target as stored: its allowed shape for the step's kind, access keys masked, at most
 * `MAX_STEP_TARGET_CHARS`; null for none. A Deployment passes its own tools' operations as `mycoOps`.
 */
export function stepTarget(raw: string, kind: StepKind, mycoOps?: ReadonlySet<string>): string | null {
  const shaped = shapeFor(raw, kind, mycoOps);
  if (shaped === null) return null;
  const bounded = line(redactSecrets(shaped), MAX_STEP_TARGET_CHARS);
  return bounded === '' ? null : bounded;
}

/** A tool name or shape as a log names it: an identifier, or the fixed name given where it is not one. */
export const stepName = (raw: string, max = MAX_STEP_TOOL_CHARS, fallback = 'tool'): string => identifierShape(raw, max) ?? fallback;

/** The pages one attempt's log travels in, in order; a log with no steps still travels as one page carrying its totals. */
export function stepPages(attemptId: string, steps: readonly WorkerStep[], overflow: number, unrecognized: UnrecognizedCount): StepPage[] {
  const pages = Math.max(1, Math.ceil(steps.length / STEPS_PER_PAGE));
  return Array.from({ length: pages }, (_, page) => ({
    attemptId, page, pages, total: steps.length, overflow, unrecognized,
    steps: steps.slice(page * STEPS_PER_PAGE, (page + 1) * STEPS_PER_PAGE),
  }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new WorkerStepsError(`${what} names an unknown field: ${extra}`);
}

function boundedText(value: unknown, max: number, what: string, nullable: true): string | null;
function boundedText(value: unknown, max: number, what: string, nullable: false): string;
function boundedText(value: unknown, max: number, what: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new WorkerStepsError(`${what} must be text of 1 to ${max} characters`);
  return value;
}

function parseUnrecognized(value: unknown): UnrecognizedCount {
  if (!isRecord(value)) throw new WorkerStepsError('unrecognized must be an object');
  exactKeys(value, ['total', 'shapes'], 'unrecognized');
  if (!count(value.total, Number.MAX_SAFE_INTEGER)) throw new WorkerStepsError('unrecognized.total must be a count');
  if (!isRecord(value.shapes)) throw new WorkerStepsError('unrecognized.shapes must be an object');
  const entries = Object.entries(value.shapes);
  if (entries.length > MAX_UNRECOGNIZED_SHAPES) throw new WorkerStepsError(`unrecognized names at most ${MAX_UNRECOGNIZED_SHAPES} shapes`);
  const shapes: Record<string, number> = {};
  let named = 0;
  for (const [shape, n] of entries) {
    if (identifierShape(shape, MAX_SHAPE_CHARS) !== shape) throw new WorkerStepsError('an unrecognized shape must be an identifier');
    if (!count(n, Number.MAX_SAFE_INTEGER) || n === 0) throw new WorkerStepsError('an unrecognized shape counts at least one record');
    shapes[shape] = n;
    named += n;
  }
  if (named > value.total) throw new WorkerStepsError('unrecognized.total is less than the shapes it names');
  return { total: value.total, shapes };
}

function callIdOf(callId: string | null, what: string): string | null {
  if (callId !== null && !/^[A-Za-z0-9_.:-]+$/.test(callId)) throw new WorkerStepsError(`${what}.callId must be an id`);
  return callId;
}

function identifierTool(tool: string, what: string): string {
  if (identifierShape(tool, MAX_STEP_TOOL_CHARS) !== tool) throw new WorkerStepsError(`${what}.tool must be an identifier`);
  return tool;
}

function parseStep(value: unknown, index: number, mycoOps: ReadonlySet<string>): WorkerStep {
  const what = `steps[${index}]`;
  if (!isRecord(value)) throw new WorkerStepsError(`${what} must be an object`);
  exactKeys(value, ['seq', 'callId', 'kind', 'tool', 'target', 'outcome', 'exitCode', 'startedAt', 'endedAt'], what);
  if (!count(value.seq, MAX_RUN_STEPS - 1)) throw new WorkerStepsError(`${what}.seq must be below ${MAX_RUN_STEPS}`);
  if (!STEP_KINDS.includes(value.kind as StepKind)) throw new WorkerStepsError(`${what}.kind must be one of ${STEP_KINDS.join(', ')}`);
  if (!STEP_OUTCOMES.includes(value.outcome as StepOutcome)) throw new WorkerStepsError(`${what}.outcome must be one of ${STEP_OUTCOMES.join(', ')}`);
  if (!(value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)))) throw new WorkerStepsError(`${what}.exitCode must be an integer or null`);
  if (!instant(value.startedAt)) throw new WorkerStepsError(`${what}.startedAt must be an instant`);
  if (!(value.endedAt === null || instant(value.endedAt))) throw new WorkerStepsError(`${what}.endedAt must be an instant or null`);
  const target = boundedText(value.target, MAX_STEP_TARGET_CHARS, `${what}.target`, true);
  return {
    seq: value.seq,
    callId: callIdOf(boundedText(value.callId, MAX_STEP_CALL_ID_CHARS, `${what}.callId`, true), what),
    kind: value.kind as StepKind,
    tool: identifierTool(boundedText(value.tool, MAX_STEP_TOOL_CHARS, `${what}.tool`, false), what),
    target: target === null ? null : stepTarget(target, value.kind as StepKind, mycoOps),
    outcome: value.outcome as StepOutcome,
    exitCode: value.exitCode as number | null,
    startedAt: value.startedAt,
    endedAt: value.endedAt as number | null,
  };
}

/**
 * A step page as a Deployment accepts it: every field present and bounded, the page inside its own count, each step's
 * `seq` inside the page it travels on, and every target bounded and masked again. Anything else is refused whole.
 */
export function parseStepPage(value: unknown, mycoOps: ReadonlySet<string>): StepPage {
  if (!isRecord(value)) throw new WorkerStepsError('a step page must be an object');
  const attemptId = boundedText(value.attemptId, MAX_ATTEMPT_ID_CHARS, 'attemptId', false);
  if (!count(value.pages, MAX_STEP_PAGES) || value.pages === 0) throw new WorkerStepsError(`pages must be 1 to ${MAX_STEP_PAGES}`);
  if (!count(value.page, value.pages - 1)) throw new WorkerStepsError('page must be below pages');
  if (!count(value.total, MAX_RUN_STEPS)) throw new WorkerStepsError(`total must be at most ${MAX_RUN_STEPS}`);
  if (!count(value.overflow, Number.MAX_SAFE_INTEGER)) throw new WorkerStepsError('overflow must be a count');
  if (value.pages !== Math.max(1, Math.ceil(value.total / STEPS_PER_PAGE))) throw new WorkerStepsError('pages does not match total');
  if (!Array.isArray(value.steps) || value.steps.length > STEPS_PER_PAGE) throw new WorkerStepsError(`steps must be a list of at most ${STEPS_PER_PAGE}`);
  const first = value.page * STEPS_PER_PAGE;
  const expected = Math.min(STEPS_PER_PAGE, value.total - first);
  if (value.steps.length !== Math.max(0, expected)) throw new WorkerStepsError('steps does not hold this page of the total');
  const steps = value.steps.map((step, index) => parseStep(step, index, mycoOps));
  if (steps.some((step, i) => step.seq !== first + i)) throw new WorkerStepsError('each step must carry its own sequence number on its page');
  return { attemptId, page: value.page, pages: value.pages, total: value.total, overflow: value.overflow, unrecognized: parseUnrecognized(value.unrecognized), steps };
}
