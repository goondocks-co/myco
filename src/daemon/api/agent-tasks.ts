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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { status: HTTP_NOT_FOUND, body: { error: 'task_not_found', name: sourceName } };
    }
    return { status: HTTP_BAD_REQUEST, body: { error: 'copy_failed', message } };
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
