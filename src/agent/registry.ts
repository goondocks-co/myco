/**
 * User task registry.
 *
 * Loads built-in tasks from the definitions directory and user-created tasks
 * from the vault's tasks/ subdirectory. User tasks with the same name as a
 * built-in task override the built-in.
 *
 * No module-level cache — always reads from disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { USER_TASKS_DIR, USER_TASK_SOURCE, BUILT_IN_SOURCE, TASK_NAME_PATTERN, MAX_TASK_NAME_LENGTH } from '@myco/constants.js';
import { loadAgentTasks, taskFromParsed } from './loader.js';
import { AgentTaskSchema } from './schemas.js';
import type { AgentTask } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// BUILT_IN_SOURCE imported from @myco/constants.js

/** Suffix appended to the task name when copying a built-in task for the user. */
const COPY_SUFFIX = '-custom';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all tasks: built-in definitions merged with user-created overrides.
 *
 * Built-in tasks are loaded from `definitionsDir/tasks/*.yaml`.
 * User tasks are loaded from `vaultDir/tasks/*.yaml`.
 * A user task with the same name as a built-in task replaces it entirely.
 *
 * Always reads from disk — no caching.
 *
 * @param definitionsDir — path to `src/agent/definitions/` (or dist equivalent).
 * @param vaultDir — optional vault directory; user tasks skipped if not provided.
 * @returns map from task name → AgentTask.
 */
export function loadAllTasks(definitionsDir: string, vaultDir?: string): Map<string, AgentTask> {
  const result = new Map<string, AgentTask>();

  // Load built-in tasks first
  const builtIn = loadAgentTasks(definitionsDir);
  for (const task of builtIn) {
    result.set(task.name, { ...task, isBuiltin: true, source: BUILT_IN_SOURCE });
  }

  // Overlay user tasks (override built-in if same name)
  if (vaultDir) {
    const userTasksDir = path.join(vaultDir, USER_TASKS_DIR);
    if (fs.existsSync(userTasksDir)) {
      const files = fs.readdirSync(userTasksDir).filter((f) => f.endsWith('.yaml'));
      for (const file of files) {
        const filePath = path.join(userTasksDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed = AgentTaskSchema.parse(parseYaml(raw));
          const task: AgentTask = {
            ...taskFromParsed(parsed),
            isBuiltin: false,
            source: USER_TASK_SOURCE,
          };
          result.set(task.name, task);
        } catch (err) {
          console.warn(`[registry] Skipping malformed user task file: ${filePath}`, err);
        }
      }
    }
  }

  return result;
}

/**
 * Validate a task name against the allowed pattern and length limit.
 *
 * Valid names: lowercase letters, digits, and hyphens. Must start and end
 * with a letter or digit. Single character names (a–z, 0–9) are allowed.
 *
 * @param name — candidate task name.
 * @returns true if valid.
 */
export function validateTaskName(name: string): boolean {
  if (name.length > MAX_TASK_NAME_LENGTH) return false;
  return TASK_NAME_PATTERN.test(name);
}

/**
 * Serialize an AgentTask to YAML and write it to `vaultDir/tasks/<name>.yaml`.
 *
 * Validates the task through AgentTaskSchema before writing.
 * Creates the tasks directory if it does not exist (idempotent).
 * Strips the internal `source` and `isBuiltin` fields from the serialized output.
 *
 * @param vaultDir — path to the vault root directory.
 * @param task — task to write.
 * @returns absolute path to the written file.
 * @throws if schema validation fails.
 */
export function writeUserTask(vaultDir: string, task: AgentTask): string {
  // Validate before touching the filesystem
  AgentTaskSchema.parse(task);

  const tasksDir = path.join(vaultDir, USER_TASKS_DIR);
  fs.mkdirSync(tasksDir, { recursive: true });

  // Strip internal-only fields before serializing
  const { isBuiltin: _isBuiltin, source: _source, ...serializable } = task;
  const yaml = stringifyYaml(serializable);

  const filePath = path.join(tasksDir, `${task.name}.yaml`);
  fs.writeFileSync(filePath, yaml, 'utf-8');
  return filePath;
}

/**
 * Delete a user task YAML file from `vaultDir/tasks/<taskName>.yaml`.
 *
 * @param vaultDir — path to the vault root directory.
 * @param taskName — name of the task to delete.
 * @returns true if the file existed and was removed, false if it did not exist.
 */
export function deleteUserTask(vaultDir: string, taskName: string): boolean {
  const filePath = path.join(vaultDir, USER_TASKS_DIR, `${taskName}.yaml`);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath);
  return true;
}

/**
 * Create a user copy of an existing task.
 *
 * Loads all tasks (built-in + user), locates `sourceName`, then writes a new
 * user task with the given name (or `sourceName + COPY_SUFFIX` if omitted),
 * `isDefault: false`, `isBuiltin: false`, and `source: 'user'`.
 *
 * @param definitionsDir — path to built-in definitions directory.
 * @param vaultDir — path to vault root directory.
 * @param sourceName — name of the task to copy.
 * @param newName — optional name for the copy; defaults to `sourceName + '-custom'`.
 * @returns the newly written AgentTask.
 * @throws if the source task is not found.
 * @throws if the new name is invalid.
 */
export function copyTaskToUser(
  definitionsDir: string,
  vaultDir: string,
  sourceName: string,
  newName?: string,
): AgentTask {
  const allTasks = loadAllTasks(definitionsDir, vaultDir);

  const source = allTasks.get(sourceName);
  if (!source) {
    throw new Error(`Task not found: ${sourceName}`);
  }

  const targetName = newName ?? `${sourceName}${COPY_SUFFIX}`;
  if (!validateTaskName(targetName)) {
    throw new Error(`Invalid task name: ${targetName}`);
  }

  const copy: AgentTask = {
    ...source,
    name: targetName,
    isDefault: false,
    isBuiltin: false,
    source: USER_TASK_SOURCE,
  };

  writeUserTask(vaultDir, copy);
  return copy;
}
