/**
 * The MCP tools this Deployment serves, by name.
 *
 * `docs/architecture/myco-2.0.md` §7.3 disposes of every 1.4 MCP tool and
 * names one owning child per row. Three rows are owned by the intelligence-data
 * child (#919), which holds their tables; their MCP surface is delivered by the
 * recall child (#921). The ledger has no mechanism that guarantees a row's
 * non-owning surface gets delivered. This list is that guarantee: the delivering
 * code enumerates every §7.3 tool, and `tests/myco-server/tool-catalogue.test.ts`
 * fails by name when the two drift in either direction.
 *
 * Names only. Each name has one operation implementation shared by the CLI
 * mirror, the stdio bridge, HTTP MCP and the dashboard (#921); the handler
 * registry that realises it gates itself against this list.
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
