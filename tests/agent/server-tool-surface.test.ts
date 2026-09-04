/**
 * The served tool surface matches the task definitions it serves.
 *
 * A task definition names the tools its prompt calls; the container
 * materializes a tool per name over the run routes. A name in one and not the
 * other is a run that calls a tool it does not hold — invisible until a live
 * run wastes its turns on it. This gate names the drift instead.
 */
import { describe, expect, it } from 'bun:test';
import { loadAllTasks } from '@myco/agent/registry.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';
import { materializedToolsForTask, SERVED_TASKS } from '@myco/agent/runtime/server-tools.js';

/**
 * Names a served task declares that the Deployment does not serve, with what
 * carries the work instead. `vault_unprocessed` finds sessions to title on a
 * local automatic run; a dispatched run always names its one session, so the
 * scan has nothing to do on the harness.
 */
const UNSERVED: Readonly<Record<string, readonly string[]>> = {
  'title-summary': ['vault_unprocessed'],
};

/** The tool surface a run of this task holds, by name. */
function servedNames(taskName: string): string[] {
  const ctx = { client: {} as never, budget: { connectTimeoutMs: 1, requestTimeoutMs: 1 }, runId: 'run', agentId: 'agent' };
  return materializedToolsForTask(taskName, ctx, { reports: 0, writes: 0 }).map((t) => t.name);
}

const tasks = loadAllTasks(resolveDefinitionsDir());

describe('the served tool surface', () => {
  it('holds every tool the served task definitions name, and always the report', () => {
    const missing: string[] = [];
    for (const taskName of SERVED_TASKS) {
      const task = tasks.get(taskName);
      expect({ task: taskName, defined: task !== undefined }).toEqual({ task: taskName, defined: true });
      const served = new Set(servedNames(taskName));
      expect({ task: taskName, reports: served.has('vault_report') }).toEqual({ task: taskName, reports: true });
      const excused = new Set(UNSERVED[taskName] ?? []);
      for (const declared of task!.toolOverrides ?? []) {
        if (!served.has(declared) && !excused.has(declared)) missing.push(`${taskName} -> ${declared}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('materializes more than the report for exactly the served tasks', () => {
    const beyondReport = [...tasks.keys()].filter((name) => servedNames(name).length > 1).sort();
    expect(beyondReport).toEqual([...SERVED_TASKS].sort());
  });

  it('excuses only names the served task definitions still declare', () => {
    for (const [taskName, names] of Object.entries(UNSERVED)) {
      const declared = tasks.get(taskName)?.toolOverrides ?? [];
      for (const name of names) expect({ taskName, name, declared: declared.includes(name) }).toEqual({ taskName, name, declared: true });
    }
  });
});
