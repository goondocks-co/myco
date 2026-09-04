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

/**
 * Names the Deployment materializes that a served task declares nowhere, with
 * why. Empty: every served task names its whole surface today, and a name
 * arriving here has to earn its line.
 */
const UNDECLARED: Readonly<Record<string, readonly string[]>> = {};

/** The tool surface a run of this task holds, by name. */
function servedNames(taskName: string): string[] {
  const ctx = { client: {} as never, budget: { connectTimeoutMs: 1, requestTimeoutMs: 1 }, runId: 'run', agentId: 'agent' };
  return materializedToolsForTask(taskName, ctx, { reports: 0, writes: 0 }).map((t) => t.name);
}

const tasks = loadAllTasks(resolveDefinitionsDir());

/**
 * Every tool name a task definition declares: a single-query task names them in
 * `toolOverrides`, a phased one in each phase's own list. A hosted run composes
 * the phases into one prompt and holds the union, so the union is what the gate
 * compares against.
 */
function declaredNames(taskName: string): string[] {
  const task = tasks.get(taskName);
  return [...new Set([...(task?.toolOverrides ?? []), ...(task?.phases ?? []).flatMap((phase) => phase.tools)])];
}

describe('the served tool surface', () => {
  it('holds every tool the served task definitions name, and always the report', () => {
    const missing: string[] = [];
    for (const taskName of SERVED_TASKS) {
      const task = tasks.get(taskName);
      expect({ task: taskName, defined: task !== undefined }).toEqual({ task: taskName, defined: true });
      const served = new Set(servedNames(taskName));
      expect({ task: taskName, reports: served.has('vault_report') }).toEqual({ task: taskName, reports: true });
      const declared = declaredNames(taskName);
      expect({ task: taskName, declares: declared.length > 0 }).toEqual({ task: taskName, declares: true });
      const excused = new Set(UNSERVED[taskName] ?? []);
      for (const name of declared) {
        if (!served.has(name) && !excused.has(name)) missing.push(`${taskName} -> ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The other direction: a tool a run holds and its definition never names is a
   * capability the prompt was never told about. The model calls what it is told
   * it has, so an undeclared tool is one that is paid for and never used.
   */
  it('materializes no tool the served task definitions leave undeclared', () => {
    const extra: string[] = [];
    for (const taskName of SERVED_TASKS) {
      const declared = new Set(declaredNames(taskName));
      const excused = new Set(UNDECLARED[taskName] ?? []);
      for (const name of servedNames(taskName)) {
        if (!declared.has(name) && !excused.has(name)) extra.push(`${taskName} -> ${name}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it('excuses only names the served tasks actually leave undeclared', () => {
    for (const [taskName, names] of Object.entries(UNDECLARED)) {
      const declared = new Set(declaredNames(taskName));
      for (const name of names) expect({ taskName, name, declared: declared.has(name) }).toEqual({ taskName, name, declared: false });
    }
  });

  /**
   * A hosted run is one query with one turn budget. A phase gated on another
   * phase's metadata, or run in map mode, has execution the container never
   * performs, so the gate that would have applied silently does not.
   */
  it('serves only phased tasks whose phases run in order, with no metadata gate and no map phase', () => {
    const offenders: string[] = [];
    for (const taskName of SERVED_TASKS) {
      for (const phase of tasks.get(taskName)?.phases ?? []) {
        if (phase.mode === 'map') offenders.push(`${taskName} -> ${phase.name} is a map phase`);
        if (phase.gateOnPriorMetadata !== undefined) offenders.push(`${taskName} -> ${phase.name} gates on prior metadata`);
      }
    }
    expect(offenders).toEqual([]);
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
