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
 * its prompt cursor, its session's material and title, the map it keeps — it calls the run-only
 * tools (`run-definitions.ts`), which no member and no grant can see.
 *
 * `report` is the exception to the allowlist and is served to every run. A
 * report is the run protocol rather than a task capability: the close gate
 * makes one the condition of completing, and a task declaring no tools of its
 * own still has to close.
 *
 * A view over the registries: nothing here resolves an op or dispatches a call.
 */
import { RUN_TOOLS } from '../core/tool-catalogue.js';
import { ALWAYS_ALLOWED, isRunCall, RUN_TOOL_MAP, runAllowlist, type RunAllowlist, type RunSurfaceTarget } from './run-allowlist.js';
import { narrowDefinitions } from './external.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';
import { RUN_DEFINITIONS, RUN_PROJECT_DESCRIPTION } from './run-definitions.js';
import type { RegistryEntry } from './registry.js';
import { handleRun } from './tools/run.js';
import { handleRunMap } from './tools/run-map.js';
import { handleRunPrompts } from './tools/run-prompts.js';
import { handleRunSessions } from './tools/run-sessions.js';
import { handleRunSpores } from './tools/run-spores.js';

/** The handlers for the run-only tools, keyed as the served registry is. */
export const RUN_TOOL_REGISTRY: Record<string, { defaultOp: string; ops: Record<string, RegistryEntry> }> = {
  myco_run: { defaultOp: 'report', ops: { report: { handler: handleRun }, state_get: { handler: handleRun }, state_set: { handler: handleRun } } },
  myco_run_spores: { defaultOp: 'list', ops: { list: { handler: handleRunSpores }, get: { handler: handleRunSpores } } },
  myco_run_sessions: { defaultOp: 'list', ops: { list: { handler: handleRunSessions }, material: { handler: handleRunSessions }, title: { handler: handleRunSessions } } },
  myco_run_prompts: { defaultOp: 'unprocessed', ops: { unprocessed: { handler: handleRunPrompts }, mark_processed: { handler: handleRunPrompts } } },
  myco_run_map: { defaultOp: 'get', ops: { get: { handler: handleRunMap }, write: { handler: handleRunMap } } },
};

export { ALWAYS_ALLOWED, isRunCall, RUN_PROJECT_DESCRIPTION, RUN_TOOL_MAP, runAllowlist, type RunAllowlist, type RunSurfaceTarget };

/** The definitions a run is listed: its allowlisted names across both sets, each op enum narrowed to what it may call. */
export function runDefinitions(allow: RunAllowlist): ToolDefinition[] {
  return narrowDefinitions([...TOOL_DEFINITIONS, ...RUN_DEFINITIONS], Object.fromEntries(allow), RUN_PROJECT_DESCRIPTION);
}

/** Every run-only tool the surface can serve, in catalogue order. */
export const RUN_SURFACE_TOOLS: readonly string[] = RUN_TOOLS;

/** Every operation a Myco tool takes, served or run-only: the only operations a step a worker names a Myco call keeps. */
export const MYCO_TOOL_OPS: ReadonlySet<string> = new Set([...TOOL_DEFINITIONS, ...RUN_DEFINITIONS]
  .flatMap((definition) => (definition.inputSchema.properties.op?.enum ?? []).filter((op): op is string => typeof op === 'string')));
