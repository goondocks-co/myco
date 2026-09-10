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

/**
 * The tools only a run's credential may call.
 *
 * Deliberately outside `SERVED_TOOLS`: a member and a grant never see these
 * names, and the member side declares none of them, so the parity gate and the
 * ledger's §7.3 catalogue judge the seven and only the seven. What a run does
 * that a member also does — every write of vault content, and search — stays on
 * the catalogued tools rather than being copied here.
 */
export const RUN_TOOLS = [
  'myco_run',
  'myco_run_spores',
  'myco_run_sessions',
  'myco_run_prompts',
] as const;

export type RunTool = (typeof RUN_TOOLS)[number];

/** The run tool a titling run's write of its session lands through; the close rule reads the write back under this name. */
export const TITLE_WRITE_TOOL: RunTool = 'myco_run_sessions';
/** The run tool an extraction run's mark of a read prompt lands through; the close rule reads the write back under this name. */
export const PROMPT_MARK_TOOL: RunTool = 'myco_run_prompts';

/** Whether this name is one of the run-only tools. */
export function isRunTool(name: string): name is RunTool {
  return (RUN_TOOLS as readonly string[]).includes(name);
}

/** Every tool name either surface may carry. */
export type AnyTool = ServedTool | RunTool;

/** The op key of a tool that declares no op of its own. */
export const NO_OP = '*';

/**
 * The tenancy key every tool declares: a project id or a git remote.
 *
 * One spelling, here, for the definitions, the scope resolver and the
 * chokepoint's write check. `validate.ts` refuses an argument the schema does
 * not declare by name, so a site that spells the key by hand is refused rather
 * than admitted and ignored. The member side spells it once too
 * (`packages/myco/src/tools/pivot.ts`), and
 * `tests/myco-server/tool-parity.test.ts` holds the two equal.
 */
export const PROJECT_PIVOT = 'project';

/**
 * Every op of a served tool this Deployment does not answer, named with the
 * issue that delivers it, or `never` for one a Deployment does not offer.
 *
 * Names only, as above — a handler is what makes an op answered, and handlers
 * live with the MCP surface. The handler registry expands this list into the
 * entries that answer a call with `not_served` (`mcp/registry.ts`), and
 * `tests/myco-server/tool-parity.test.ts`
 * holds the union of this list and the registry's handlers equal to each tool's
 * declared op enum.
 */
export const UNSERVED_OPS: Readonly<Partial<Record<ServedTool, Readonly<Record<string, string>>>>> = {
  myco_cortex: { digest: '#1170', canopy_map: '#1170', canopy_entry: '#1170', notifications: '#922', maintenance_summary: '#923' },
  myco_plans: { delete: 'never' },
};

/**
 * Every op that writes, by tool.
 *
 * One list, three readers: the run surface drops these for a dry run, the MCP
 * chokepoint refuses one that names no Project, and a gate holds the set equal
 * to what each tool's `readOnlyHint` publishes. Names only, as above — the
 * handler is what performs the write, and handlers live with the MCP surface.
 *
 * Names only, as above: `run-surface.ts` and the chokepoint both read it, and
 * neither imports the registry.
 */
export const WRITE_OPS: Readonly<Partial<Record<AnyTool, readonly string[]>>> = {
  myco_plans: ['save'],
  myco_spores: ['save', 'supersede', 'consolidate', 'obsolete'],
  // `report` is absent deliberately: a dry run does its work, writes nothing,
  // and still files the report the close gate reads.
  myco_run: ['state_set'],
  myco_run_sessions: ['title'],
  myco_run_prompts: ['mark_processed'],
};

/** Whether this op of this tool writes. */
export function isWriteOp(tool: AnyTool, op: string): boolean {
  return (WRITE_OPS[tool] ?? []).includes(op);
}

/** Whether this Deployment answers this op of this tool. */
export function isServedOp(tool: ServedTool, op: string): boolean {
  return UNSERVED_OPS[tool]?.[op] === undefined;
}
