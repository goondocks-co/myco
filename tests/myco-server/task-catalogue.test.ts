/**
 * The task catalogue: every retained task names a gate, the set matches the
 * ledger's KEEP list rather than drifting from it, and the three run outcomes
 * are held to a close rule and an input builder each — no outcome without a
 * rule, no rule without an outcome.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admissionForTask, EXTRACTION_TASK, MANUAL_ONLY_TASKS, OUTCOME_TASKS, RETAINED_TASKS, SEEDING_TASK, TASK_ADMISSION, TITLING_TASK, UNLANDED_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { scheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { RUNTIME_SERVED_TASKS } from '@myco-server-worker/core/harness.js';
import { PROJECT_CAPABILITIES } from '@myco-server-worker/core/settings.js';
import { EXTRACTION_REPORT_ACTION, RUN_CLOSE_RULES, RUN_SKIP_ACTION, SEEDING_REPORT_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { INPUT_BUILDERS } from '@myco-server-worker/core/task-inputs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

/** Canopy's two tasks belong to the map task's own issue and are gated there. */
const OWNED_ELSEWHERE = new Set(['canopy-describe', 'harness-health']);

describe('the task catalogue', () => {
  it('names a gate for every task the ledger keeps, and none it does not', () => {
    const section = fs.readFileSync(LEDGER, 'utf8');
    const body = section.slice(section.indexOf('### 7.4'), section.indexOf('### 7.5'));
    const kept = body.split('\n')
      .filter((l) => l.startsWith('| `') && ['KEEP', 'REPLACE'].includes(l.split('|')[2]?.trim()))
      .map((l) => l.split('`')[1])
      .filter((t) => !OWNED_ELSEWHERE.has(t));
    expect([...kept].sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('gates every capability task on one the Deployment actually admits', () => {
    const unknown = Object.entries(TASK_ADMISSION)
      .filter(([, gate]) => gate.kind === 'capability')
      .filter(([, gate]) => !(PROJECT_CAPABILITIES as readonly string[]).includes((gate as { capability: string }).capability))
      .map(([task]) => task);
    expect(unknown).toEqual([]);
  });

  it('gates exactly the capture-driven tasks on a provider rather than a capability', () => {
    const providerGated = Object.entries(TASK_ADMISSION).filter(([, g]) => g.kind === 'provider').map(([t]) => t);
    expect(providerGated).toEqual([TITLING_TASK]);
  });

  it('answers null for a task this Deployment does not serve, rather than a default gate', () => {
    expect(admissionForTask('canopy-map')).toEqual({ kind: 'capability', capability: 'canopy' });
    expect(admissionForTask('invented-task')).toBeNull();
    expect(admissionForTask('digest-only')).toBeNull();
    expect(admissionForTask(EXTRACTION_TASK)).toEqual({ kind: 'capability', capability: 'vault_evolution' });
  });

  it('leaves every manual-only task without a schedule, so none of them reaches the clock', () => {
    const scheduled = MANUAL_ONLY_TASKS.filter((task) => TASK_SCHEDULE[task] !== null);
    expect(scheduled).toEqual([]);
    for (const task of MANUAL_ONLY_TASKS) expect({ task, retained: RETAINED_TASKS.includes(task) }).toEqual({ task, retained: true });
  });
});

describe('what the clock runs', () => {
  it('schedules extraction with its unread-prompt guard and keeps seeding and titling off the clock', () => {
    expect(scheduledTasks().map((t) => t.task)).toEqual(['container-smoke', EXTRACTION_TASK]);
    expect(TASK_SCHEDULE[EXTRACTION_TASK]).toEqual({ intervalSeconds: 3600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 12, reservedRunsPerDay: { count: 3, preCondition: 'has-recent-live-prompts' }, preCondition: 'has-unprocessed-prompts' });
    for (const task of [SEEDING_TASK, TITLING_TASK]) expect({ task, schedule: TASK_SCHEDULE[task] }).toEqual({ task, schedule: null });
  });

  it('makes a declared, switched-off schedule live when an owner switches it on', () => {
    const live = scheduledTasks({ 'canopy-map': { schedule: { enabled: true } } });
    expect(live.map((t) => t.task).sort()).toEqual(['canopy-map', 'container-smoke', EXTRACTION_TASK]);
    expect(live.find((t) => t.task === 'canopy-map')!.schedule).toMatchObject({ enabled: true, intervalSeconds: 21_600, maxRunsPerDay: 4, overlap: 'skip' });
  });

  it('takes a switched-off override away from a task the Deployment otherwise runs', () => {
    expect(scheduledTasks({ 'container-smoke': { schedule: { enabled: false } } }).map((t) => t.task)).toEqual([EXTRACTION_TASK]);
  });
});

/**
 * Gate: a task closes on evidence the Deployment can see.
 *
 * A task with no entry closes on its runtime's word while reading, from the
 * catalogue, as governed like every other. That is the shape of the defect this
 * table answers: a titling run whose harness never called back lands `completed`
 * wherever nothing here names what it owed.
 */
describe('what each task owes before it closes', () => {
  it('declares a close rule for every retained task, and for nothing else', () => {
    expect(Object.keys(RUN_CLOSE_RULES).sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('holds a titling run to the row it was dispatched to write, not to its report alone', () => {
    const rule = RUN_CLOSE_RULES[TITLING_TASK]!;
    // The skip is the pass whose write a standing title refused: nothing owed, nothing to hold it to.
    expect(rule.reports).toEqual([TITLING_REPORT_ACTION, RUN_SKIP_ACTION]);
    expect(typeof rule.artifact).toBe('function');
  });

  it('holds an extraction pass to the prompt it marked read, and a seeding run to a spore it authored', () => {
    expect(RUN_CLOSE_RULES[EXTRACTION_TASK]!.reports).toEqual([EXTRACTION_REPORT_ACTION, RUN_SKIP_ACTION]);
    expect(typeof RUN_CLOSE_RULES[EXTRACTION_TASK]!.artifact).toBe('function');
    expect(RUN_CLOSE_RULES[SEEDING_TASK]!.reports).toEqual([SEEDING_REPORT_ACTION, RUN_SKIP_ACTION]);
    expect(typeof RUN_CLOSE_RULES[SEEDING_TASK]!.artifact).toBe('function');
  });
});

/**
 * Gate: the three run outcomes, and only the three, are the tasks a worker
 * serves under a prompt the Deployment builds, and each one's run is held to
 * the row it owed.
 *
 * A worker-served task with no builder would queue rows no claim could hand
 * out; a builder for a task with no artifact check would close on a report
 * alone; a rule for a task no builder instructs would govern runs that never
 * start. The three lists are held to one another here, by name.
 */
describe('the three run outcomes', () => {
  it('name which of them a worker cannot drive yet, and only among themselves', () => {
    for (const task of UNLANDED_TASKS) expect({ task, outcome: OUTCOME_TASKS.includes(task) }).toEqual({ task, outcome: true });
    expect(UNLANDED_TASKS).not.toContain(SEEDING_TASK);
  });

  it('are exactly the worker-served tasks, each with a prompt the Deployment builds', () => {
    const workerServed = RETAINED_TASKS.filter((task) => !RUNTIME_SERVED_TASKS.includes(task)).sort();
    expect(workerServed).toEqual([...OUTCOME_TASKS].sort());
    expect(Object.keys(INPUT_BUILDERS).sort()).toEqual([...OUTCOME_TASKS].sort());
    expect([...OUTCOME_TASKS].sort()).toEqual([EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK].sort());
  });

  it('each close on a rule that names an artifact the server can see, and accept a skip only where the server reads to agree with it', () => {
    for (const task of OUTCOME_TASKS) {
      const rule = RUN_CLOSE_RULES[task];
      expect({ task, artifact: typeof rule?.artifact, skip: rule?.reports.includes(RUN_SKIP_ACTION), skipHolds: typeof rule?.skipHolds })
        .toEqual({ task, artifact: 'function', skip: true, skipHolds: 'function' });
    }
    // A rule that accepts the skip reads the server's own answer for it; no rule reads one for a skip it does not accept.
    for (const [task, rule] of Object.entries(RUN_CLOSE_RULES)) {
      expect({ task, paired: rule.reports.includes(RUN_SKIP_ACTION) === (rule.skipHolds !== undefined) }).toEqual({ task, paired: true });
    }
    // A rule with an artifact check belongs to an outcome or to the map, which is the seam's own code task.
    const artifactRules = Object.entries(RUN_CLOSE_RULES).filter(([, rule]) => rule.artifact !== undefined).map(([task]) => task).sort();
    expect(artifactRules).toEqual([...OUTCOME_TASKS, 'canopy-map'].sort());
  });
});
