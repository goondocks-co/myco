/**
 * The task catalogue: every retained task names a gate, and the set matches the
 * ledger's KEEP list rather than drifting from it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admissionForTask, MANUAL_ONLY_TASKS, RETAINED_TASKS, scheduledTasks, TASK_ADMISSION, TASK_SCHEDULE } from '@myco-server-worker/core/task-catalogue.js';
import { PROJECT_CAPABILITIES } from '@myco-server-worker/core/settings.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

/** Canopy's two tasks belong to the map task's own issue and are gated there. */
const OWNED_ELSEWHERE = new Set(['canopy-map', 'canopy-describe', 'harness-health']);

describe('the task catalogue', () => {
  it('names a gate for every task the ledger keeps, and none it does not', () => {
    const section = fs.readFileSync(LEDGER, 'utf8');
    const body = section.slice(section.indexOf('### 7.4'), section.indexOf('### 7.5'));
    const kept = body.split('\n')
      .filter((l) => l.startsWith('| `') && l.split('|')[2]?.trim() === 'KEEP')
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
    expect(providerGated).toEqual(['title-summary']);
  });

  it('answers null for a task this Deployment does not serve, rather than a default gate', () => {
    expect(admissionForTask('canopy-map')).toBeNull();
    expect(admissionForTask('invented-task')).toBeNull();
    expect(admissionForTask('digest-only')).toEqual({ kind: 'capability', capability: 'cortex' });
  });

  it('leaves every manual-only task without a schedule, so none of them reaches the clock', () => {
    const scheduled = MANUAL_ONLY_TASKS.filter((task) => TASK_SCHEDULE[task] !== null);
    expect(scheduled).toEqual([]);
    for (const task of MANUAL_ONLY_TASKS) expect({ task, retained: RETAINED_TASKS.includes(task) }).toEqual({ task, retained: true });
  });
});

describe('what the clock runs', () => {
  it('runs the probe alone: the instructions schedule is declared and switched off', () => {
    expect(scheduledTasks().map((t) => t.task)).toEqual(['container-smoke']);
    expect(TASK_SCHEDULE['cortex-instructions']).toEqual({ enabled: false, intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 1 });
  });

  it('makes the declared schedule live when an owner switches it on', () => {
    const live = scheduledTasks({ 'cortex-instructions': { schedule: { enabled: true } } });
    expect(live.map((t) => t.task).sort()).toEqual(['container-smoke', 'cortex-instructions']);
    expect(live.find((t) => t.task === 'cortex-instructions')!.schedule).toMatchObject({ enabled: true, intervalSeconds: 86_400, maxRunsPerDay: 1, overlap: 'skip' });
  });

  it('takes a switched-off override away from a task the Deployment otherwise runs', () => {
    expect(scheduledTasks({ 'container-smoke': { schedule: { enabled: false } } })).toEqual([]);
  });
});
