/**
 * Gate: the tools the server says each task declares are the tools its task
 * file declares.
 *
 * A run's MCP surface is built from `TASK_TOOLS` (`core/task-catalogue.ts`),
 * the server's copy of what each task file under
 * `packages/myco/src/agent/definitions/tasks/` declares — `toolOverrides`, or
 * the union of every phase's `tools` and `deferredTools`, and nothing a task
 * inherits from its agent. The two are held equal here, both ways, so neither
 * can widen or narrow a run's surface alone. This gate goes with the task files
 * when #1170 deletes them; the catalogue then stands alone.
 */
import { describe, expect, it } from 'bun:test';
import { BUNDLED_AGENT_TASKS } from '@myco/agent/definitions.generated.js';
import { RETAINED_TASKS, TASK_TOOLS, taskTools } from '@myco-server-worker/core/task-catalogue.js';

/** What a task file declares: its overrides, else its phases' tools and deferred tools, else nothing. */
function declaredTools(task: (typeof BUNDLED_AGENT_TASKS)[number]): string[] {
  if (task.toolOverrides !== undefined) return [...new Set(task.toolOverrides)].sort();
  const phased = (task.phases ?? []).flatMap((phase) => [...(phase.tools ?? []), ...(phase.deferredTools ?? [])]);
  return [...new Set(phased)].sort();
}

describe('the task tool table', () => {
  it('names every retained task and no other', () => {
    expect(Object.keys(TASK_TOOLS).sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('declares for each retained task exactly what its task file declares, and nothing for a task with no file', () => {
    const files = new Map(BUNDLED_AGENT_TASKS.map((t) => [t.name, t]));
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
