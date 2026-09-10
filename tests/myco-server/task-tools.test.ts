/**
 * Gate: the tools the server says each task declares are the tools its run
 * surface can actually serve, and — for a task that still has a 1.4 task file —
 * the tools that file declares.
 *
 * A run's MCP surface is built from `TASK_TOOLS` (`core/task-catalogue.ts`).
 * Every name there maps onto at least one `(tool, op)` in `RUN_TOOL_MAP`, so a
 * task cannot declare a tool the surface answers as unknown. For a task whose
 * file still stands under `packages/myco/src/agent/definitions/tasks/`, the
 * two are held equal both ways — the YAML read directly, not through the
 * generated bundle — so neither can widen or narrow a run's surface alone. An
 * outcome task the catalogue alone defines is held to the map. The file half
 * goes with the task files when #1170 deletes them.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RETAINED_TASKS, TASK_TOOLS, taskTools } from '@myco-server-worker/core/task-catalogue.js';
import { RUN_TOOL_MAP } from '@myco-server-worker/mcp/run-surface.js';

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

/** The names `RUN_TOOL_MAP` does not map; the Canopy map's source tools are served by the seam and not by MCP. */
const SEAM_TOOLS = new Set(['code_grep', 'fs_list', 'fs_read', 'fs_tree']);

describe('the task tool table', () => {
  it('names every retained task and no other', () => {
    expect(Object.keys(TASK_TOOLS).sort()).toEqual([...RETAINED_TASKS].sort());
  });

  it('declares no tool twice, and none the run surface cannot serve', () => {
    for (const task of RETAINED_TASKS) {
      expect({ task, duplicates: new Set(TASK_TOOLS[task]).size === TASK_TOOLS[task].length }).toEqual({ task, duplicates: true });
      const unmapped = TASK_TOOLS[task].filter((tool) => !SEAM_TOOLS.has(tool) && (RUN_TOOL_MAP[tool] ?? []).length === 0);
      expect({ task, unmapped }).toEqual({ task, unmapped: [] });
    }
  });

  it('declares for a retained task that still has a file exactly what that file declares', () => {
    const files = taskFiles();
    expect(files.size).toBeGreaterThan(10);
    const withFile = RETAINED_TASKS.filter((task) => files.has(task));
    // The two outcomes the catalogue alone defines have no file; the rest still do.
    expect(withFile.sort()).toEqual(['canopy-map', 'container-smoke', 'title-summary', 'vault-seed'].sort());
    for (const task of withFile) {
      if (task === 'vault-seed') continue;
      expect({ task, tools: [...TASK_TOOLS[task]].sort() }).toEqual({ task, tools: declaredTools(files.get(task)!) });
    }
    // The seeding outcome is one prompt over a checkout the harness explores
    // with its own tools, so its surface is the vault writes alone and not the
    // phased file's source tools.
    expect([...TASK_TOOLS['vault-seed']].sort()).toEqual(['vault_create_spore', 'vault_report', 'vault_search_fts', 'vault_search_semantic', 'vault_spore', 'vault_spores']);
  });

  it('answers nothing for a task it does not serve or for no task', () => {
    expect(taskTools(null)).toEqual([]);
    expect(taskTools('not-a-task')).toEqual([]);
    expect(taskTools('container-smoke')).toEqual([]);
  });
});
