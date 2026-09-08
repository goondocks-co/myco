/**
 * The run-scoped surface: what a run's credential may call over MCP.
 *
 * A task file declares its tools in the task vocabulary (`vault_*`); the tool
 * surface judges `(myco_* tool, op)`. This is the one map between them, an
 * explicit allowlist in the shape of the external surface (`external.ts`):
 * fail-closed, never a name filter, never a `readOnlyHint` denylist. A task
 * tool with no entry here has no MCP equivalent yet — #1146 adds the ops and
 * extends the map — and a run holding only such tools has an empty surface.
 *
 * A view over the registry: nothing here resolves an op or dispatches a call.
 * `runAllowlist` turns one task's declared tools into the `(tool, op)` set the
 * chokepoint checks, dropping every write for a dry run.
 */
import { NO_OP, type ServedTool } from '../core/tool-catalogue.js';
import { narrowDefinitions } from './external.js';
import type { ToolDefinition } from './definitions.js';

/** One `(tool, op)` a task tool reaches, and whether it writes. */
export interface RunSurfaceTarget { tool: ServedTool; op: string; write: boolean }

export const RUN_TOOL_MAP: Readonly<Record<string, readonly RunSurfaceTarget[]>> = {
  vault_spores: [{ tool: 'myco_spores', op: 'list', write: false }],
  vault_spore: [{ tool: 'myco_spores', op: 'get', write: false }],
  vault_create_spore: [{ tool: 'myco_spores', op: 'save', write: true }],
  // The run-side `consolidate` action names one source and a wisdom spore already
  // recorded; the member op of that name records the wisdom spore in the same
  // write. Different shapes, so it is not mapped here (#1146 decides its op).
  vault_resolve_spore: [{ tool: 'myco_spores', op: 'supersede', write: true }, { tool: 'myco_spores', op: 'obsolete', write: true }],
  vault_sessions: [{ tool: 'myco_sessions', op: 'list', write: false }, { tool: 'myco_sessions', op: 'get', write: false }],
  vault_search_fts: [{ tool: 'myco_search', op: NO_OP, write: false }],
  vault_search_semantic: [{ tool: 'myco_search', op: NO_OP, write: false }],
};

/** The `(tool, op)` pairs one run may call. */
export type RunAllowlist = ReadonlyMap<ServedTool, ReadonlySet<string>>;

/** The allowlist for a task's declared tools; a dry run keeps its reads and loses every write. */
export function runAllowlist(tools: readonly string[], options: { dryRun: boolean }): RunAllowlist {
  const allow = new Map<ServedTool, Set<string>>();
  for (const name of tools) {
    for (const target of RUN_TOOL_MAP[name] ?? []) {
      if (options.dryRun && target.write) continue;
      const ops = allow.get(target.tool) ?? new Set<string>();
      ops.add(target.op);
      allow.set(target.tool, ops);
    }
  }
  return allow;
}

/** True when `(tool, op)` — the op as the registry resolved it — is on this run's surface. */
export function isRunCall(allow: RunAllowlist, tool: ServedTool, op: string): boolean {
  return allow.get(tool)?.has(op) ?? false;
}

/** What `project_id` means on the surface: the run's own Project, named or not. */
export const RUN_PROJECT_ID_DESCRIPTION = 'The Project this run works in. Optional; it may name only that Project.';

/** The definitions a run is listed: its allowlisted names, each op enum narrowed to what it may call. */
export function runDefinitions(allow: RunAllowlist): ToolDefinition[] {
  return narrowDefinitions(Object.fromEntries(allow), RUN_PROJECT_ID_DESCRIPTION);
}
