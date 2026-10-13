import { describe, expect, it } from 'bun:test';
import FROZEN_TASK_TOOLS from '../fixtures/retirement/task-tools.json';
import { RETAINED_TASKS, TASK_TOOLS, taskTools } from '@myco-server-worker/core/task-catalogue.js';
import { RUN_TOOL_MAP } from '@myco-server-worker/mcp/run-surface.js';

describe('the task tool table', () => {
  it('names every retained task and no other', () => {
    expect(Object.keys(TASK_TOOLS).sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('declares no tool twice, and none the run surface cannot serve', () => {
    for (const task of RETAINED_TASKS) {
      expect({ task, duplicates: new Set(TASK_TOOLS[task]).size === TASK_TOOLS[task].length }).toEqual({ task, duplicates: true });
      const unmapped = TASK_TOOLS[task].filter((tool) => (RUN_TOOL_MAP[tool] ?? []).length === 0);
      expect({ task, unmapped }).toEqual({ task, unmapped: [] });
    }
  });

  it('preserves the frozen task tool contract', () => {
    expect(TASK_TOOLS).toEqual(FROZEN_TASK_TOOLS);
  });

  it('answers nothing for a task it does not serve or for no task', () => {
    expect(taskTools(null)).toEqual([]);
    expect(taskTools('not-a-task')).toEqual([]);
    expect(taskTools('embedding-reconcile')).toEqual([]);
  });
});
