/**
 * Gate: the tools the server says each task declares are the tools its task
 * file declares.
 *
 * A run's MCP surface is built from `TASK_TOOLS` (`core/task-catalogue.ts`),
 * the server's copy of what each task file under
 * `packages/myco/src/agent/definitions/tasks/` declares — `toolOverrides`, or
 * the union of every phase's `tools` and `deferredTools`, and nothing a task
 * inherits from its agent. The YAML is read here directly, not through the
 * generated bundle, so a task file edited without a codegen run still fails
 * this gate. The two are held equal both ways, so neither can widen or narrow
 * a run's surface alone. This gate goes with the task files when #1170 deletes
 * them; the catalogue then stands alone.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RETAINED_TASKS, TASK_TOOLS, taskTools } from '@myco-server-worker/core/task-catalogue.js';

const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco', 'src', 'agent', 'definitions', 'tasks');

interface TaskFile { name: string; toolOverrides?: string[]; phases?: Array<{ tools?: string[]; deferredTools?: string[] }> }

/** Every task file, parsed as data. */
function taskFiles(): Map<string, TaskFile> {
  return new Map(fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.yaml')).map((f) => {
    const parsed = parseYaml(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as TaskFile;
    return [parsed.name, parsed];
  }));
}

/** What a task file declares: its overrides, else its phases' tools and deferred tools, else nothing. */
function declaredTools(task: TaskFile): string[] {
  if (task.toolOverrides !== undefined) return [...new Set(task.toolOverrides)].sort();
  const phased = (task.phases ?? []).flatMap((phase) => [...(phase.tools ?? []), ...(phase.deferredTools ?? [])]);
  return [...new Set(phased)].sort();
}

describe('the task tool table', () => {
  it('names every retained task and no other', () => {
    expect(Object.keys(TASK_TOOLS).sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('declares for each retained task exactly what its task file declares, and nothing for a task with no file', () => {
    const files = taskFiles();
    expect(files.size).toBeGreaterThan(10);
    for (const task of RETAINED_TASKS) {
      const file = files.get(task);
      const expected = file === undefined ? [] : declaredTools(file);
      expect({ task, tools: [...TASK_TOOLS[task]].sort() }).toEqual({ task, tools: expected });
      expect({ task, duplicates: new Set(TASK_TOOLS[task]).size === TASK_TOOLS[task].length }).toEqual({ task, duplicates: true });
    }
  });

  it('answers nothing for a task it does not serve or for no task', () => {
    expect(taskTools(null)).toEqual([]);
    expect(taskTools('not-a-task')).toEqual([]);
    expect(taskTools('container-smoke')).toEqual([]);
  });
});
