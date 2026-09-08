/**
 * The external surface: what an External Agent grant may call.
 *
 * An explicit per-(tool, op) allowlist, never a tool-name filter and never a
 * `readOnlyHint` denylist. Six tool names of project-scoped reads, plus the two
 * spore writes a grant records its findings through — `save` and `supersede`,
 * each attributed to the grant itself (`auth/grants.ts`). `consolidate` and
 * `obsolete` are absent: both move rows a grant did not write. No plan write
 * exists here at all.
 *
 * The reads are the six the member-side surface declares
 * (`packages/myco/src/mcp/external-surface.ts`); the two writes are served
 * here alone, named in `tests/myco-server/tool-parity.test.ts`, which holds the
 * two allowlists equal once those named pairs are added to the member's.
 *
 * A view over the registry: nothing here resolves an op or dispatches a call.
 * Fails closed: a (tool, op) not listed does not exist on this surface.
 */
import { NO_OP, type ServedTool } from '../core/tool-catalogue.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';

/** The op key of a tool without an op concept; the registry resolves such a tool to the same key. */
const ANY_OP = NO_OP;

export const EXTERNAL_TOOL_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  myco_search: new Set([ANY_OP]),
  myco_cortex: new Set(['digest']),
  myco_plans: new Set(['list', 'get']),
  myco_sessions: new Set(['list', 'get']),
  myco_skills: new Set(['list', 'get']),
  myco_spores: new Set(['list', 'get', 'save', 'supersede']),
};

/** The tool names the surface advertises. */
export const EXTERNAL_TOOLS: readonly string[] = Object.keys(EXTERNAL_TOOL_ALLOWLIST);

/** True when `(tool, op)` — the op as the registry resolved it — is on the surface. */
export function isExternalCall(tool: ServedTool, op: string): boolean {
  const ops = EXTERNAL_TOOL_ALLOWLIST[tool];
  if (ops === undefined) return false;
  return ops.has(ANY_OP) || ops.has(op);
}

/** What `project_id` means on the surface: the grant's own Project, named or not. */
export const EXTERNAL_PROJECT_ID_DESCRIPTION = 'The Project this access key reads and records into. Optional; it may name only that Project.';

/**
 * The definitions a narrowed surface lists: the allowlisted names, each
 * definition as the Deployment serves it to a member with its `op` enum
 * narrowed to the ops the surface answers and `project_id` described for a
 * principal bound to one Project. An agent reads the schema before it calls; a
 * schema that offers `save` and refuses it sends the agent into a refusal it
 * could have avoided. The narrowing is presentation: `callTool` judges every
 * call by the allowlist whatever schema the caller read. One narrowing serves
 * the external surface and the run surface (`run-surface.ts`).
 */
export function narrowDefinitions(allowlist: Readonly<Record<string, ReadonlySet<string>>>, projectIdDescription: string): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((d) => d.name in allowlist).map((d) => {
    const ops = allowlist[d.name];
    const properties = { ...d.inputSchema.properties };
    const op = properties.op;
    if (!ops.has(ANY_OP) && op !== undefined && Array.isArray(op.enum)) properties.op = { ...op, enum: op.enum.filter((v) => typeof v === 'string' && ops.has(v)) };
    if (properties.project_id !== undefined) properties.project_id = { ...properties.project_id, description: projectIdDescription };
    return { ...d, inputSchema: { ...d.inputSchema, properties } };
  });
}

/** The definitions the external surface lists. */
export function externalDefinitions(): ToolDefinition[] {
  return narrowDefinitions(EXTERNAL_TOOL_ALLOWLIST, EXTERNAL_PROJECT_ID_DESCRIPTION);
}
