/**
 * Gate: one scheduler, and it is the wake tick.
 *
 * Two halves, both read from the source rather than asserted in prose:
 *
 *   REGISTRY — every scheduled Deployment task is declared in `core/jobs.ts`.
 *   The tick's own jobs and the tasks the clock dispatches are two tables in
 *   one file, and the clock can dispatch nothing the file does not declare.
 *
 *   NO SECOND SCHEDULER — a timer, an alarm, or a cron handler appears only in
 *   the wake path, and the tick is the only caller of the clock. A module that
 *   armed its own timer would be a second scheduler nobody reads the registry
 *   for, and the failure would be silent: work would simply happen twice, or at
 *   a cadence no ledger row names.
 *
 * Static source scan over `packages/myco-server/src` plus the registry's own
 * exports — no wake, no boot.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredScheduleFor, SERVER_JOBS, DEFERRED_JOBS, TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { ACCELERATORS, PRE_CONDITIONS, scheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';

const WORKER = fileURLToPath(new URL('../../packages/myco-server/', import.meta.url));
const SRC = join(WORKER, 'src');
/** The file every scheduled task and job is declared in. */
const REGISTRY = join(SRC, 'core', 'jobs.ts');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

const key = (file: string): string => relative(SRC, file).split('\\').join('/');
const sources = (): Array<{ file: string; text: string }> => files(SRC).map((file) => ({ file: key(file), text: readFileSync(file, 'utf8') }));

/**
 * Where each scheduling mechanism may appear. One wake arrives three ways —
 * a hosted alarm, a process timer, an owner's ask — and each is named here with
 * the one file allowed to express it. Anything else naming one is a second
 * scheduler.
 */
const WAKE_MECHANISMS: ReadonlyArray<{ what: string; pattern: RegExp; allowed: readonly string[] }> = [
  // The MECHANISM, not one call form: a timer aliased to a local name, reached
  // through computed access on `globalThis`, or spelled as a sleep in a loop is
  // the same second scheduler as a direct call, so the bare identifiers are what
  // the scan matches. `globalThis` is matched whole: a name assembled at runtime
  // (`'set' + 'Timeout'`) carries no identifier to find, and the shared server
  // source reaches the global object for nothing else.
  { what: 'a process timer', pattern: /\b(setInterval|setTimeout|setImmediate|globalThis)\b|Bun\.sleep|scheduler\.wait/, allowed: ['platform/bun/wake-loop.ts'] },
  { what: 'a hosted alarm', pattern: /\b(setAlarm|getAlarm|deleteAlarm)\b/, allowed: ['platform/cloudflare/deployment-clock.ts'] },
  { what: 'a cron handler', pattern: /\bexport async function scheduled\b/, allowed: ['entry/cloudflare.ts'] },
  { what: 'the tick itself', pattern: /\brunTick\s*\(/, allowed: ['core/tick.ts', 'api/wake.ts', 'platform/bun/wake.ts', 'platform/cloudflare/deployment-clock.ts'] },
  { what: "the clock's pass over every Project", pattern: /\brunScheduledTasks\s*\(/, allowed: ['core/tick.ts', 'core/scheduled-tasks.ts'] },
  { what: 'a dispatch attributed to the clock', pattern: /\bactor:\s*CLOCK_ACTOR\b/, allowed: ['core/scheduled-tasks.ts'] },
];

describe('the registry of scheduled work', () => {
  it('declares every task the clock can dispatch, and every tick job, in one file', () => {
    const registry = readFileSync(REGISTRY, 'utf8');
    expect(registry).toContain('export const TASK_SCHEDULE');
    expect(registry).toContain('export const SERVER_JOBS');

    // Every name the clock could reach this wake — under any owner override —
    // is a key of the declared table, and the table lives in the registry.
    const declared = Object.keys(TASK_SCHEDULE);
    const every = new Set([
      ...scheduledTasks().map((t) => t.task),
      ...scheduledTasks(Object.fromEntries(declared.map((task) => [task, { schedule: { enabled: true } }]))).map((t) => t.task),
    ]);
    for (const task of every) expect({ task, declared: declared.includes(task) }).toEqual({ task, declared: true });
    for (const task of declared) {
      const line = new RegExp(`^\\s+(\\[MAP_TASK\\]|'${task}'):`, 'm');
      expect({ task, inRegistry: line.test(registry) }).toEqual({ task, inRegistry: true });
    }
    for (const job of [...SERVER_JOBS, ...DEFERRED_JOBS]) {
      expect({ job: job.name, inRegistry: registry.includes(`'${job.name}'`) }).toEqual({ job: job.name, inRegistry: true });
    }
  });

  it('registers every precondition and accelerator a declared schedule names, so a misspelling is refused rather than skipped every wake', () => {
    for (const [task, schedule] of Object.entries(TASK_SCHEDULE)) {
      if (schedule === null) continue;
      if (schedule.preCondition !== undefined) {
        expect({ task, condition: schedule.preCondition, registered: Object.hasOwn(PRE_CONDITIONS, schedule.preCondition) })
          .toEqual({ task, condition: schedule.preCondition, registered: true });
      }
      if (schedule.accelerator !== undefined) {
        expect({ task, accelerator: schedule.accelerator.name, registered: Object.hasOwn(ACCELERATORS, schedule.accelerator.name) })
          .toEqual({ task, accelerator: schedule.accelerator.name, registered: true });
      }
    }
  });

  it('answers no schedule for a name inherited from Object.prototype, so a settings string cannot read as a declaration', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      expect({ name, schedule: declaredScheduleFor(name) }).toEqual({ name, schedule: null });
    }
  });

  it('names every task in a grammar the ceiling episode id can join on', () => {
    // The skipped row's id joins the Project, the task and the instant that
    // filled the window with `_`; a task name carrying one would make that join
    // ambiguous to read back.
    for (const task of Object.keys(TASK_SCHEDULE)) expect({ task, named: /^[a-z][a-z0-9-]*$/.test(task) }).toEqual({ task, named: true });
  });

  it('gives every scheduled task a cadence and a depth, and a ceiling to every task an owner can ask for again', () => {
    for (const { task, schedule } of scheduledTasks(Object.fromEntries(Object.keys(TASK_SCHEDULE).map((t) => [t, { schedule: { enabled: true } }])))) {
      expect({ task, cadence: schedule.intervalSeconds > 0, depth: schedule.runIn.length > 0, ceiling: typeof schedule.maxRunsPerDay })
        .toEqual({ task, cadence: true, depth: true, ceiling: 'number' });
    }
  });
});

describe('nothing schedules Deployment work outside the wake', () => {
  for (const mechanism of WAKE_MECHANISMS) {
    it(`names ${mechanism.what} only in ${mechanism.allowed.join(', ')}`, () => {
      const found = sources().filter((s) => mechanism.pattern.test(s.text)).map((s) => s.file);
      expect(found.filter((f) => !mechanism.allowed.includes(f))).toEqual([]);
      // Each allowance is load-bearing: an allowed file that stopped expressing
      // the mechanism means the wake path moved and the gate is reading nothing.
      expect(found.sort()).toEqual([...mechanism.allowed].sort());
    });
  }

  it('keeps one cron floor, declared once, delegating to the clock', () => {
    const wrangler = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    const declarations = [...wrangler.matchAll(/^crons = \[(.*)\]$/gm)].map((m) => m[1]);
    expect(declarations).toHaveLength(1);
    // One expression, not a second cadence beside it: the floor recovers a
    // Deployment holding no alarm, and the alarm is what sets the cadence.
    expect(declarations[0].split(',').map((s) => s.trim()).filter((s) => s.length > 0)).toHaveLength(1);
    expect(readFileSync(join(SRC, 'entry', 'cloudflare.ts'), 'utf8')).toContain('return wakeClock(bindings);');
  });
});
