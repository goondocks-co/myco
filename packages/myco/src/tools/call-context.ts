/**
 * Resolve a per-call effective `MycoRequestContext` from raw tool input.
 *
 * Stream J's agent-native parity contract: every vault-scoped MCP tool
 * accepts optional `grove_id` / `project_id` body fields that pivot the
 * call to a different (Grove, project) than the harness launched under.
 * This mirrors the daemon UI's project switcher — without it, agents
 * spawned inside one project can't drive intelligence reads or actions
 * against another Grove without restarting under a different env.
 *
 * Resolution rules:
 *   - No fields supplied            → return `baseContext` unchanged.
 *   - Only `project_id` supplied    → swap `projectId` on the base
 *                                     context (same Grove/database;
 *                                     in-process services pivot via
 *                                     `projectScopeFromRequestContext`).
 *   - `grove_id` supplied (with or  → re-resolve the full context
 *     without `project_id`)           against the Grove registry, which
 *                                     yields a new `databasePath` and
 *                                     forces the dispatcher to open the
 *                                     target Grove's DB.
 *
 * Errors throw `ToolError('invalid_input', ...)` so MCP clients see a
 * typed failure rather than a 500 from the daemon.
 */

import path from 'node:path';
import { ToolError } from './error.js';
import {
  REQUEST_CONTEXT_HEADERS,
  requireProjectId,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import {
  assertGroveProjectId,
  isGroveEraId,
  type GroveProjectId,
} from '@myco/grove/ids.js';
import {
  findRegisteredProject,
  groveOwnedByThisDaemon,
  loadGroveRecord,
} from '@myco/grove/registry.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';

/** The two scope-pivot fields any tool input may carry. */
export interface CallContextPivot {
  grove_id?: unknown;
  project_id?: unknown;
}

/**
 * Read scope-pivot fields off raw tool input. Returns trimmed strings
 * or undefined; rejects non-string values with a typed error so the
 * dispatcher surfaces them before handler dispatch.
 */
export function readPivot(input: unknown): { groveId?: string; projectId?: string } {
  if (!input || typeof input !== 'object') return {};
  const obj = input as CallContextPivot;
  const groveId = readPivotField(obj.grove_id, 'grove_id');
  const projectId = readPivotField(obj.project_id, 'project_id');
  return { groveId, projectId };
}

function readPivotField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolError('invalid_input', `Invalid argument '${name}': expected string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Compute the effective context for a single tool call.
 *
 * `mycoHome` is injected for testability; production callers omit it
 * and let `resolveMycoHome()` find it from env/config.
 */
export function resolveCallContext(
  baseContext: MycoRequestContext,
  pivot: { groveId?: string; projectId?: string },
  options: { mycoHome?: string } = {},
): MycoRequestContext {
  const { groveId, projectId } = pivot;
  if (!groveId && !projectId) return baseContext;

  // Same-Grove project pivot: swap projectId only. The DB and Grove
  // membership stay the same — only the row-scope filter changes.
  if (!groveId && projectId) {
    if (!isGroveEraId(projectId, 'project')) {
      // For myco_cortex, `project_id` historically carries a Canopy
      // project id (md5 hex hash). We only treat it as a scope pivot
      // when it matches the Grove project format. Everything else
      // passes through to the handler unchanged.
      return baseContext;
    }
    return {
      ...baseContext,
      projectId: assertGroveProjectId(projectId),
      source: 'explicit',
    };
  }

  // Cross-Grove pivot: re-resolve against the registry. Throws a typed
  // error when the Grove or the project isn't registered so the agent
  // sees a clear "not found" instead of a generic tool failure.
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const grove = loadGroveRecord(groveId!, mycoHome);
  if (!grove) {
    throw new ToolError('invalid_input', `Unknown Grove: ${groveId}`);
  }
  // Ownership gate: a pivot into a Grove that lives in another daemon's
  // home must be refused BEFORE the dispatcher opens (and schema-migrates)
  // that Grove's database — a daemon pivoting into a foreign-home Grove
  // would otherwise create or roll its schema.
  if (!groveOwnedByThisDaemon(grove, mycoHome)) {
    throw new ToolError(
      'foreign_grove',
      `Grove ${grove.id} is served by another daemon`,
    );
  }

  let resolvedProjectId: GroveProjectId;
  let resolvedProjectRoot: string;
  if (projectId) {
    if (!isGroveEraId(projectId, 'project')) {
      throw new ToolError('invalid_input', `Invalid project_id: expected proj_<32 hex>, got ${projectId}`);
    }
    const registered = findRegisteredProject({
      projectId,
      groveId: grove.id,
      bindingId: null,
      projectRoot: null,
    }, mycoHome);
    if (!registered) {
      throw new ToolError('invalid_input', `Project ${projectId} is not registered in Grove ${grove.id}`);
    }
    resolvedProjectId = assertGroveProjectId(projectId);
    resolvedProjectRoot = path.resolve(registered.project.root);
  } else {
    // grove_id only: keep the base context's project id (the agent is
    // saying "look at the same project but in a different Grove DB").
    // If that project isn't registered in the target Grove, we still
    // pivot the database — row-scope filters will simply return zero
    // matches, which is the honest answer.
    resolvedProjectId = requireProjectId(baseContext, 'caller tenancy');
    resolvedProjectRoot = baseContext.projectRoot;
  }

  return {
    projectRoot: resolvedProjectRoot,
    // Preserve the caller's cwd across the pivot — switching Grove or
    // pivoting project_id doesn't change "where the user is right now".
    callerRoot: baseContext.callerRoot,
    projectId: resolvedProjectId,
    groveId: grove.id,
    machineId: baseContext.machineId,
    sessionId: baseContext.sessionId,
    projectVaultDir: resolveProjectVaultDir(resolvedProjectRoot),
    databasePath: resolveGroveDbPath(grove.id, mycoHome),
    source: 'explicit',
    // The agent explicitly named the target Grove/project in the tool
    // call — this pivot is caller-supplied tenancy, not synthesized.
    tenancySource: 'caller',
  };
}

/** Stable list of pivot keys; used by the dispatcher to strip them from
 * the input before handler dispatch (so handlers don't accidentally
 * forward them as URL query params or column filters). */
export const PIVOT_FIELD_NAMES = ['grove_id', 'project_id'] as const;

/** Returns input minus the pivot keys. Returns the same reference when
 * no pivot keys are present — avoids unnecessary object churn on the
 * hot path. */
export function stripPivotFields<T extends Record<string, unknown>>(input: T): T {
  if (!('grove_id' in input) && !('project_id' in input)) return input;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'grove_id' || key === 'project_id') continue;
    next[key] = value;
  }
  return next as T;
}

/** Re-export the request-context header names so callers don't need to
 * pull from two modules to write tests. */
export { REQUEST_CONTEXT_HEADERS };
