/**
 * API route handlers for agent task CRUD.
 *
 * Thin handlers that delegate to the registry and loader. Each handler
 * takes a RouteRequest and the vault directory, returning a RouteResponse.
 *
 * Route overview:
 *   GET    /api/agent/tasks          — list all tasks (built-in + user)
 *   GET    /api/agent/tasks/:id      — get a single task by name
 *   POST   /api/agent/tasks          — create a new user task
 *   POST   /api/agent/tasks/:id/copy — copy an existing task to user dir
 *   DELETE /api/agent/tasks/:id      — delete a user task (built-ins blocked)
 */

import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { taskFromParsed } from '@myco/agent/loader.js';
import { AgentTaskSchema } from '@myco/agent/schemas.js';
import {
  loadAllTasks,
  validateTaskName,
  writeUserTask,
  deleteUserTask,
  copyTaskToUser,
} from '@myco/agent/registry.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';
import { USER_TASK_SOURCE } from '@myco/constants.js';
import { loadConfig, saveConfig } from '../../config/loader.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HTTP status: 200 OK (returned as undefined — default) */
const HTTP_OK = 200;

/** HTTP status: 201 Created */
const HTTP_CREATED = 201;

/** HTTP status: 400 Bad Request */
const HTTP_BAD_REQUEST = 400;

/** HTTP status: 403 Forbidden */
const HTTP_FORBIDDEN = 403;

/** HTTP status: 404 Not Found */
const HTTP_NOT_FOUND = 404;

/** HTTP status: 409 Conflict */
const HTTP_CONFLICT = 409;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List all tasks: built-in definitions merged with user-created overrides.
 *
 * Optionally filtered by `?source=user` or `?source=built-in`.
 */
export async function handleListTasks(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  let tasks = Array.from(allTasks.values());

  const sourceFilter = req.query?.source as string | undefined;
  if (sourceFilter) {
    tasks = tasks.filter((t) => t.source === sourceFilter);
  }

  return { status: HTTP_OK, body: { tasks } };
}

/**
 * Get a single task by its name (used as the URL `:id` parameter).
 *
 * Returns 404 if the task is not found.
 */
export async function handleGetTask(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const task = allTasks.get(req.params.id);

  if (!task) {
    return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found' } };
  }

  return { status: HTTP_OK, body: { task } };
}

/**
 * Create a new user task from the request body.
 *
 * Validates:
 * - Body must parse against AgentTaskSchema.
 * - Task name must be valid (lowercase letters, digits, hyphens only).
 * - No existing user task with the same name may exist.
 *
 * Returns 201 on success.
 */
export async function handleCreateTask(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  // Parse and validate body against schema
  const result = AgentTaskSchema.safeParse(req.body);
  if (!result.success) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: 'validation_failed', issues: result.error.issues },
    };
  }

  const parsed = result.data;

  // Validate task name format
  if (!validateTaskName(parsed.name)) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: 'invalid_task_name', name: parsed.name },
    };
  }

  // Check for existing user task with the same name (built-ins can be shadowed)
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const existing = allTasks.get(parsed.name);
  if (existing && existing.source === USER_TASK_SOURCE) {
    return {
      status: HTTP_CONFLICT,
      body: { error: 'task_already_exists', name: parsed.name },
    };
  }

  const task = {
    ...parsed,
    isBuiltin: false,
    source: USER_TASK_SOURCE,
  };

  writeUserTask(vaultDir, task);

  return { status: HTTP_CREATED, body: { task } };
}

/**
 * Copy an existing task (built-in or user) to the user task directory.
 *
 * The source task is identified by `req.params.id`.
 * An optional new name may be provided via `req.body.name`.
 *
 * Returns 201 on success.
 */
export async function handleCopyTask(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const sourceName = req.params.id;
  const newName = (req.body as Record<string, unknown> | undefined)?.name as string | undefined;

  const definitionsDir = resolveDefinitionsDir();

  // Validate the new name if provided
  if (newName !== undefined && !validateTaskName(newName)) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: 'invalid_task_name', name: newName },
    };
  }

  try {
    const copy = copyTaskToUser(definitionsDir, vaultDir, sourceName, newName);
    return { status: HTTP_CREATED, body: { task: copy } };
  } catch (err) {
    const message = toErrorMessage(err);
    if (message.includes('not found')) {
      return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found', name: sourceName } };
    }
    return { status: HTTP_BAD_REQUEST, body: { error: 'copy_failed', message } };
  }
}

/**
 * Get the raw YAML content of a user task file.
 *
 * Built-in tasks return their serialized AgentTask as YAML.
 * Returns 404 if the task doesn't exist.
 */
export async function handleGetTaskYaml(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const taskName = req.params.id;
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const task = allTasks.get(taskName);

  if (!task) {
    return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found', name: taskName } };
  }

  // Serialize task to YAML (strip internal fields)
  const { isBuiltin: _ib, source: _src, ...serializable } = task;
  const yaml = stringifyYaml(serializable);

  return { status: HTTP_OK, body: { yaml, source: task.source } };
}

/**
 * Update a user task from raw YAML content.
 *
 * Parses the YAML through AgentTaskSchema for validation.
 * Built-in tasks cannot be updated (returns 403).
 * Returns the updated task on success.
 */
export async function handleUpdateTask(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const taskName = req.params.id;
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const existing = allTasks.get(taskName);

  if (!existing) {
    return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found', name: taskName } };
  }

  if (existing.isBuiltin || existing.source !== USER_TASK_SOURCE) {
    return { status: HTTP_FORBIDDEN, body: { error: 'cannot_update_builtin', name: taskName } };
  }

  const body = req.body as Record<string, unknown> | undefined;
  const yamlContent = body?.yaml;
  if (typeof yamlContent !== 'string') {
    return { status: HTTP_BAD_REQUEST, body: { error: 'missing_yaml_field' } };
  }

  try {
    const parsed = AgentTaskSchema.parse(parseYaml(yamlContent));
    const task = { ...taskFromParsed(parsed), isBuiltin: false, source: USER_TASK_SOURCE };

    // Ensure the name matches the URL param (prevent renaming via YAML)
    if (task.name !== taskName) {
      return { status: HTTP_BAD_REQUEST, body: { error: 'name_mismatch', expected: taskName, got: task.name } };
    }

    writeUserTask(vaultDir, task);
    return { status: HTTP_OK, body: { task } };
  } catch (err) {
    const message = toErrorMessage(err);
    return { status: HTTP_BAD_REQUEST, body: { error: 'validation_failed', message } };
  }
}

/**
 * Delete a user task by name.
 *
 * Built-in tasks may not be deleted (returns 403).
 * Returns 404 if the task does not exist.
 */
export async function handleDeleteTask(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const taskName = req.params.id;
  const definitionsDir = resolveDefinitionsDir();
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const task = allTasks.get(taskName);

  // Task must exist
  if (!task) {
    return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found', name: taskName } };
  }

  // Built-in tasks cannot be deleted
  if (task.isBuiltin || task.source !== USER_TASK_SOURCE) {
    return {
      status: HTTP_FORBIDDEN,
      body: { error: 'cannot_delete_builtin', name: taskName },
    };
  }

  deleteUserTask(vaultDir, taskName);

  return { status: HTTP_OK, body: { deleted: taskName } };
}

/**
 * Get the full config override for a specific task from myco.yaml.
 *
 * Returns: provider, model, maxTurns, timeoutSeconds, and per-phase overrides.
 */
export async function handleGetTaskConfig(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const taskId = req.params.id;
  const config = loadConfig(vaultDir);
  const taskConfig = config.agent.tasks?.[taskId] ?? null;
  return { status: HTTP_OK, body: { taskId, config: taskConfig } };
}

/**
 * Update config overrides for a specific task in myco.yaml.
 *
 * Accepts partial updates — only provided fields are set. Fields set to
 * `null` are removed. Supports: provider, model, maxTurns, timeoutSeconds, phases.
 *
 * Phase overrides are keyed by phase name and support: provider, model, maxTurns.
 */
export async function handleUpdateTaskConfig(
  req: RouteRequest,
  vaultDir: string,
): Promise<RouteResponse> {
  const taskId = req.params.id;
  const body = req.body as Record<string, unknown> | undefined;

  if (!body) {
    return { status: HTTP_BAD_REQUEST, body: { error: 'missing_body' } };
  }

  const config = loadConfig(vaultDir);
  if (!config.agent.tasks) {
    config.agent.tasks = {};
  }
  if (!config.agent.tasks[taskId]) {
    config.agent.tasks[taskId] = {};
  }

  const taskEntry = config.agent.tasks[taskId];

  // Apply each field if present in the body
  if ('provider' in body) {
    if (body.provider === null) {
      delete taskEntry.provider;
    } else {
      const p = body.provider as Record<string, unknown>;
      taskEntry.provider = {
        type: p.type as 'cloud' | 'ollama' | 'lmstudio',
        model: p.model as string | undefined,
        base_url: p.base_url as string | undefined,
        context_length: p.context_length as number | undefined,
      };
    }
  }

  if ('model' in body) {
    if (body.model === null) delete taskEntry.model;
    else taskEntry.model = body.model as string;
  }

  if ('maxTurns' in body) {
    if (body.maxTurns === null) delete taskEntry.maxTurns;
    else taskEntry.maxTurns = body.maxTurns as number;
  }

  if ('timeoutSeconds' in body) {
    if (body.timeoutSeconds === null) delete taskEntry.timeoutSeconds;
    else taskEntry.timeoutSeconds = body.timeoutSeconds as number;
  }

  if ('phases' in body) {
    if (body.phases === null) {
      delete taskEntry.phases;
    } else {
      const phasesInput = body.phases as Record<string, Record<string, unknown> | null>;
      if (!taskEntry.phases) taskEntry.phases = {};
      for (const [phaseName, phaseValue] of Object.entries(phasesInput)) {
        if (phaseValue === null) {
          delete taskEntry.phases[phaseName];
        } else {
          if (!taskEntry.phases[phaseName]) taskEntry.phases[phaseName] = {};
          const pe = taskEntry.phases[phaseName];
          if ('provider' in phaseValue) {
            if (phaseValue.provider === null) delete pe.provider;
            else {
              const pp = phaseValue.provider as Record<string, unknown>;
              pe.provider = {
                type: pp.type as 'cloud' | 'ollama' | 'lmstudio',
                model: pp.model as string | undefined,
                base_url: pp.base_url as string | undefined,
                context_length: pp.context_length as number | undefined,
              };
            }
          }
          if ('model' in phaseValue) {
            if (phaseValue.model === null) delete pe.model;
            else pe.model = phaseValue.model as string;
          }
          if ('maxTurns' in phaseValue) {
            if (phaseValue.maxTurns === null) delete pe.maxTurns;
            else pe.maxTurns = phaseValue.maxTurns as number;
          }
        }
      }
      // Clean up empty phases map
      if (Object.keys(taskEntry.phases).length === 0) delete taskEntry.phases;
    }
  }

  // Clean up empty task entry
  if (Object.keys(taskEntry).length === 0) {
    delete config.agent.tasks[taskId];
  }

  saveConfig(vaultDir, config);

  return {
    status: HTTP_OK,
    body: { taskId, config: config.agent.tasks[taskId] ?? null },
  };
}
