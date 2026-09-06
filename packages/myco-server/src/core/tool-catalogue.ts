/**
 * The MCP tools this Deployment serves, by name.
 *
 * Every tool the ledger (`docs/architecture/myco-2.0.md` §7.3) keeps on the MCP
 * surface is named here, and `tests/myco-server/tool-catalogue.test.ts` holds the
 * two equal in both directions, failing by name when they drift.
 *
 * Names only. Each name has one operation implementation shared by the CLI
 * mirror, the stdio bridge, HTTP MCP and the dashboard; the handler registry
 * that realises it gates itself against this list.
 */
export const SERVED_TOOLS = [
  'myco_search',
  'myco_cortex',
  'myco_sessions',
  'myco_plans',
  'myco_spores',
  'myco_skills',
  'myco_agent',
] as const;

export type ServedTool = (typeof SERVED_TOOLS)[number];

/** Whether this Deployment serves a tool of this name. */
export function isServedTool(name: string): name is ServedTool {
  return (SERVED_TOOLS as readonly string[]).includes(name);
}

/** The op key of a tool that declares no op of its own. */
export const NO_OP = '*';

/**
 * Every op of a served tool this Deployment does not answer, named with the
 * issue that delivers it, or `never` for one a Deployment does not offer.
 *
 * Names only, as above — a handler is what makes an op answered, and handlers
 * live with the MCP surface. Two readers share this one list: the handler
 * registry expands it into the entries that answer a call with `not_served`
 * (`mcp/registry.ts`), and the payload a Cortex run is handed cuts its rendered
 * tool surface and its guidance to what is left (`core/cortex-input.ts`), so an
 * artifact never teaches a call that refuses. `tests/myco-server/tool-parity.test.ts`
 * holds the union of this list and the registry's handlers equal to each tool's
 * declared op enum.
 */
export const UNSERVED_OPS: Readonly<Partial<Record<ServedTool, Readonly<Record<string, string>>>>> = {
  myco_cortex: { canopy_map: '#920', canopy_entry: '#920', notifications: '#922', maintenance_summary: '#923' },
  myco_plans: { delete: 'never' },
};

/** Whether this Deployment answers this op of this tool. */
export function isServedOp(tool: ServedTool, op: string): boolean {
  return UNSERVED_OPS[tool]?.[op] === undefined;
}
