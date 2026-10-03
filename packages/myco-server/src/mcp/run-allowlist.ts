/**
 * The map from a task's declared tools to the `(tool, op)` pairs its run may
 * call, and the allowlist built from it. Data and pure functions only: the run
 * surface (`run-surface.ts`) serves calls through it, and the task descriptions
 * read it without reaching any handler.
 */
import { isWriteOp, NO_OP, type AnyTool } from '../core/tool-catalogue.js';

/** One `(tool, op)` a task tool reaches. Whether it writes is the catalogue's answer, never restated here. */
export interface RunSurfaceTarget { tool: AnyTool; op: string }

/** The one op every run holds, whatever its task declares. */
export const ALWAYS_ALLOWED: RunSurfaceTarget = { tool: 'myco_run', op: 'report' };

export const RUN_TOOL_MAP: Readonly<Record<string, readonly RunSurfaceTarget[]>> = {
  vault_report: [ALWAYS_ALLOWED],
  vault_state: [{ tool: 'myco_run', op: 'state_get' }],
  vault_set_state: [{ tool: 'myco_run', op: 'state_set' }],
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
  vault_canopy_map: [{ tool: 'myco_run_map', op: 'get' }, { tool: 'myco_run_map', op: 'write' }],
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

