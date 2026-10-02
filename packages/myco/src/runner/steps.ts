/**
 * A run's step log, built from the run's events and its harness's step rules.
 *
 * One implementation for every harness: a driver turns its harness's stream into `tool_call` and `unrecognized`
 * events, and the harness's manifest says how a call reads as a step (`runner.worker.steps`). Nothing here names a
 * harness. A step keeps the call's kind, tool name, one target read from a field the rule names, its outcome, exit
 * status, times and call id; the call's input is read for the target and dropped, and nothing a call returned is
 * read at all.
 *
 * A call's events are joined by its call id. A harness that reports a call without an id has each start opened as a
 * step of its own and each ending close the oldest open step of the same tool. A call that ends without a start is a
 * step that started when it ended, and one still open when the run ends is `unfinished`. Past `MAX_RUN_STEPS`, steps
 * are counted as overflow rather than kept, and a stream record the driver could not read is counted by its shape, unless
 * the harness's manifest names that shape as one that never carries a call (`notSteps`).
 */
import { getAtPath } from '@goondocks/myco-shared/dot-path';
import {
  MAX_RUN_STEPS, MAX_SHAPE_CHARS, MAX_STEP_CALL_ID_CHARS, MAX_UNRECOGNIZED_SHAPES, stepName, stepTarget,
  type StepKind, type StepOutcome, type UnrecognizedCount, type WorkerStep,
} from '@goondocks/myco-shared/worker-steps';
import type { RunEvent } from './events.js';
import type { Harness } from './harnesses.js';

type CallEvent = Extract<RunEvent, { kind: 'tool_call' }>;

/** A regular expression matching `text` as written. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A raw target with every path inside one of `roots` written relative to it: `<root>/packages/a.ts` reads
 * `packages/a.ts`, and `<root>` alone reads `.`, so `git -C <root> ls-tree` reads `git -C . ls-tree`. A run's checkout
 * sits in a directory with a random name, which the shaping rule would keep only as `…`; a path outside every root is
 * left as it is. Roots are tried longest first.
 */
export function relativeToRoots(raw: string, roots: readonly string[]): string {
  let out = raw;
  for (const root of roots) {
    if (root === '' || root === '/') continue;
    out = out.replace(new RegExp(`${literal(root)}(?:/+|(?=$|[\\s'"\`;|&)<>]))`, 'g'), (match) => (match.length > root.length ? '' : '.'));
  }
  return out;
}

/** The step a call's rule makes of it: its kind, and its target read from the first named field that holds text, written relative to `roots`. */
export function stepOf(rules: Harness['steps'], call: Pick<CallEvent, 'name' | 'category' | 'input'>, roots: readonly string[] = []): { kind: StepKind; target: string | null; byName: boolean } {
  const rule = rules.find((r) => (r.tool !== undefined && r.tool === call.name)
    || (r.toolPrefix !== undefined && call.name.startsWith(r.toolPrefix))
    || (r.category !== undefined && r.category === call.category));
  if (rule === undefined) return { kind: 'tool', target: null, byName: false };
  const byName = rule.category === undefined;
  for (const field of rule.target) {
    const value = call.input === undefined ? undefined : getAtPath(call.input, field);
    if (typeof value === 'string' && value.trim() !== '') return { kind: rule.kind, target: stepTarget(relativeToRoots(value, roots), rule.kind), byName };
  }
  return { kind: rule.kind, target: null, byName };
}

/** A harness call id as a log keeps it: a bounded run of id characters, or none. */
const CALL_ID = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_STEP_CALL_ID_CHARS}}$`);

const outcomeOf = (event: CallEvent): StepOutcome => (event.refused === true ? 'refused' : event.status === 'ok' ? 'ok' : 'error');

export class StepLog {
  private readonly steps: WorkerStep[] = [];
  private readonly open = new Map<string, WorkerStep>();
  private readonly openUnnamed: WorkerStep[] = [];
  private overflow = 0;
  /** The ids of calls counted as overflow, so their later events are not counted again. */
  private readonly overflowed = new Set<string>();
  private readonly shapes = new Map<string, number>();
  private unrecognizedTotal = 0;
  /** The directories a step's path is written relative to: the run's checkout, as given and as the filesystem resolves it. */
  private roots: string[] = [];

  constructor(private readonly harness: Pick<Harness, 'steps' | 'stepTool' | 'notSteps'>, private readonly clock: () => number = Date.now) {}

  /** Write every path inside `root` relative to it from here on: a run's checkout, once it is prepared. */
  within(root: string, resolved: string = root): void {
    this.roots = [...new Set([...this.roots, root, resolved])].sort((a, b) => b.length - a.length);
  }

  observe(event: RunEvent): void {
    if (event.kind === 'unrecognized') { this.unrecognized(event.shape); return; }
    if (event.kind !== 'tool_call') return;
    const callId = event.callId !== undefined && CALL_ID.test(event.callId) ? event.callId : null;
    const at = this.clock();
    const known = callId === null ? undefined : this.open.get(callId);
    if (callId !== null && this.overflowed.has(callId)) return;
    if (event.status === 'started') {
      if (known !== undefined) { this.refine(known, event); return; }
      const step = this.add(event, callId, at, null, 'unfinished');
      if (step === null) return;
      if (callId === null) this.openUnnamed.push(step); else this.open.set(callId, step);
      return;
    }
    const opened = known ?? (callId === null ? this.takeUnnamed(event) : undefined);
    if (opened !== undefined) {
      this.refine(opened, event);
      opened.outcome = outcomeOf(event);
      opened.endedAt = at;
      if (event.exitCode !== undefined) opened.exitCode = event.exitCode;
      if (callId !== null) this.open.delete(callId);
      return;
    }
    if (callId !== null && this.steps.some((step) => step.callId === callId)) return;
    this.add(event, callId, at, at, outcomeOf(event));
  }

  /** The log as it stands: its steps in the order they started, those past the bound, and what could not be read. */
  result(): { steps: WorkerStep[]; overflow: number; unrecognized: UnrecognizedCount } {
    return {
      steps: this.steps.map((step) => ({ ...step })),
      overflow: this.overflow,
      unrecognized: { total: this.unrecognizedTotal, shapes: Object.fromEntries(this.shapes) },
    };
  }

  private add(event: CallEvent, callId: string | null, startedAt: number, endedAt: number | null, outcome: StepOutcome): WorkerStep | null {
    if (this.steps.length >= MAX_RUN_STEPS) {
      this.overflow += 1;
      if (callId !== null) this.overflowed.add(callId);
      return null;
    }
    const { kind, target, byName } = stepOf(this.harness.steps, event, this.roots);
    const step: WorkerStep = {
      seq: this.steps.length, callId, kind, tool: this.toolOf(event, byName), target, outcome,
      exitCode: event.exitCode ?? null, startedAt, endedAt,
    };
    this.steps.push(step);
    return step;
  }

  /** A later event of a call may carry what its start did not: its input, and so its kind and target. */
  private refine(step: WorkerStep, event: CallEvent): void {
    if (step.target !== null || (event.input === undefined && event.category === undefined)) return;
    const { kind, target, byName } = stepOf(this.harness.steps, event, this.roots);
    step.kind = kind;
    step.tool = this.toolOf(event, byName);
    step.target = target;
  }

  /**
   * What a step names its call by, as its harness declares: the tool's name or the call's category, never free text. A
   * call a rule matched by name is named by that name whatever the harness declares: the name is one the rule spelled,
   * as a driver names a call to one of Myco's tools.
   */
  private toolOf(event: CallEvent, byName = false): string {
    return this.harness.stepTool === 'category' && !byName ? stepName(event.category ?? '', undefined, 'call') : stepName(event.name);
  }

  private takeUnnamed(event: CallEvent): WorkerStep | undefined {
    const tool = this.toolOf(event, stepOf(this.harness.steps, event).byName);
    const index = this.openUnnamed.findIndex((step) => step.tool === tool);
    return index < 0 ? undefined : this.openUnnamed.splice(index, 1)[0];
  }

  private unrecognized(shape: string): void {
    if (this.harness.notSteps.includes(shape)) return;
    this.unrecognizedTotal += 1;
    const named = stepName(shape, MAX_SHAPE_CHARS, 'unnamed');
    if (this.shapes.has(named) || this.shapes.size < MAX_UNRECOGNIZED_SHAPES) this.shapes.set(named, (this.shapes.get(named) ?? 0) + 1);
  }
}
