/**
 * The run-scoped surface: what a run's credential may call over MCP.
 *
 * A task file declares its tools in the task vocabulary (`vault_*`); the tool
 * surface judges `(tool, op)`. This is the one map between them, an explicit
 * allowlist in the shape of the external surface (`external.ts`): fail-closed,
 * never a name filter, never a `readOnlyHint` denylist.
 *
 * The surface is two sets. Where a run's work is a member's work — every write
 * of vault content, and search — it calls the catalogued tools, so one
 * operation has one implementation and one attribution path. Where the
 * operation is the run's own — material reads bounded by its window, its state,
 * its prompt cursor, its session's material and title — it calls the run-only
 * tools (`run-definitions.ts`), which no member and no grant can see.
 *
 * `report` is the exception to the allowlist and is served to every run. A
 * report is the run protocol rather than a task capability: the close gate
 * makes one the condition of completing, and a task declaring no tools of its
 * own still has to close.
 *
 * A view over the registries: nothing here resolves an op or dispatches a call.
 */
import { isWriteOp, NO_OP, RUN_TOOLS, type AnyTool } from '../core/tool-catalogue.js';
import { narrowDefinitions } from './external.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';
import { RUN_DEFINITIONS, RUN_PROJECT_DESCRIPTION } from './run-definitions.js';
import type { RegistryEntry } from './registry.js';
import { handleRun } from './tools/run.js';
import { handleRunPrompts } from './tools/run-prompts.js';
import { handleRunSessions } from './tools/run-sessions.js';
import { handleRunSpores } from './tools/run-spores.js';

/** One `(tool, op)` a task tool reaches. Whether it writes is the catalogue's answer, never restated here. */
export interface RunSurfaceTarget { tool: AnyTool; op: string }

/** The one op every run holds, whatever its task declares. */
export const ALWAYS_ALLOWED: RunSurfaceTarget = { tool: 'myco_run', op: 'report' };

export const RUN_TOOL_MAP: Readonly<Record<string, readonly RunSurfaceTarget[]>> = {
  vault_report: [ALWAYS_ALLOWED],
  vault_state: [{ tool: 'myco_run', op: 'state_get' }],
  vault_set_state: [{ tool: 'myco_run', op: 'state_set' }],
  vault_agents_block: [{ tool: 'myco_run', op: 'agents_block' }],
  vault_spores: [{ tool: 'myco_run_spores', op: 'list' }],
  vault_spore: [{ tool: 'myco_run_spores', op: 'get' }],
  vault_sessions: [{ tool: 'myco_run_sessions', op: 'list' }],
  vault_session_summary_material: [{ tool: 'myco_run_sessions', op: 'material' }],
  vault_update_session: [{ tool: 'myco_run_sessions', op: 'title' }],
  vault_unprocessed: [{ tool: 'myco_run_prompts', op: 'unprocessed' }],
  vault_mark_processed: [{ tool: 'myco_run_prompts', op: 'mark_processed' }],
  vault_create_spore: [{ tool: 'myco_spores', op: 'save' }],
  vault_resolve_spore: [
    { tool: 'myco_spores', op: 'supersede' },
    { tool: 'myco_spores', op: 'obsolete' },
    { tool: 'myco_spores', op: 'consolidate' },
  ],
  vault_search_fts: [{ tool: 'myco_search', op: NO_OP }],
  vault_search_semantic: [{ tool: 'myco_search', op: NO_OP }],
};

/** The handlers for the run-only tools, keyed as the served registry is. */
export const RUN_TOOL_REGISTRY: Record<string, { defaultOp: string; ops: Record<string, RegistryEntry> }> = {
  myco_run: { defaultOp: 'report', ops: { report: { handler: handleRun }, state_get: { handler: handleRun }, state_set: { handler: handleRun }, agents_block: { handler: handleRun } } },
  myco_run_spores: { defaultOp: 'list', ops: { list: { handler: handleRunSpores }, get: { handler: handleRunSpores } } },
  myco_run_sessions: { defaultOp: 'list', ops: { list: { handler: handleRunSessions }, material: { handler: handleRunSessions }, title: { handler: handleRunSessions } } },
  myco_run_prompts: { defaultOp: 'unprocessed', ops: { unprocessed: { handler: handleRunPrompts }, mark_processed: { handler: handleRunPrompts } } },
};

/** The `(tool, op)` pairs one run may call. */
export type RunAllowlist = ReadonlyMap<AnyTool, ReadonlySet<string>>;

/** The allowlist for a task's declared tools; a dry run keeps its reads and loses every write. Every run holds `report`. */
export function runAllowlist(tools: readonly string[], options: { dryRun: boolean }): RunAllowlist {
  const allow = new Map<AnyTool, Set<string>>([[ALWAYS_ALLOWED.tool, new Set([ALWAYS_ALLOWED.op])]]);
  for (const name of tools) {
    for (const target of RUN_TOOL_MAP[name] ?? []) {
      if (options.dryRun && isWriteOp(target.tool, target.op)) continue;
      const ops = allow.get(target.tool) ?? new Set<string>();
      ops.add(target.op);
      allow.set(target.tool, ops);
    }
  }
  return allow;
}

/** True when `(tool, op)` — the op as the registry resolved it — is on this run's surface. */
export function isRunCall(allow: RunAllowlist, tool: AnyTool, op: string): boolean {
  return allow.get(tool)?.has(op) ?? false;
}

export { RUN_PROJECT_DESCRIPTION };

/** The definitions a run is listed: its allowlisted names across both sets, each op enum narrowed to what it may call. */
export function runDefinitions(allow: RunAllowlist): ToolDefinition[] {
  return narrowDefinitions([...TOOL_DEFINITIONS, ...RUN_DEFINITIONS], Object.fromEntries(allow), RUN_PROJECT_DESCRIPTION);
}

/** Every run-only tool the surface can serve, in catalogue order. */
export const RUN_SURFACE_TOOLS: readonly string[] = RUN_TOOLS;
