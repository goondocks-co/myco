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
