/**
 * Every (tool, op) the Deployment answers, and every one it names as not yet
 * served. Keyed by `SERVED_TOOLS`, and held complete against each tool's op
 * enum by `tests/myco-server/tool-parity.test.ts`: an op can be served or
 * named, never absent.
 *
 * The handlers are here; the ops with no handler come from `UNSERVED_OPS` in
 * the catalogue, which names the issue that delivers each one, or `never` for an
 * op a Deployment does not offer. The tool answers those as a `not_served`
 * error, so a caller sees what is missing rather than an empty result. One list
 * of them serves this registry and the Cortex payload alike.
 */
import { NO_OP, SERVED_TOOLS, UNSERVED_OPS, type ServedTool } from '../core/tool-catalogue.js';
import type { ToolContext } from './context.js';
import { handleAgent } from './tools/agent.js';
import { handleCortexDigest, handleCortexInstructions, handleCortexProjectsActivity } from './tools/cortex.js';
import { handlePlans } from './tools/plans.js';
import { handleSessions } from './tools/sessions.js';
import { handleSkills } from './tools/skills.js';
import { handleSpores } from './tools/spores.js';
import { handleSearch } from './tools/search.js';
import type { ToolInput } from './validate.js';

export type ToolHandler = (input: ToolInput, ctx: ToolContext) => Promise<unknown>;
export type RegistryEntry = { handler: ToolHandler } | { notServed: string };

export interface ToolEntry {
  /** The op a call without one runs; null for a tool with no op concept. */
  defaultOp: string | null;
  ops: Record<string, RegistryEntry>;
}

export { NO_OP };

const served = (handler: ToolHandler): RegistryEntry => ({ handler });
/** The catalogue's unserved ops for one tool, as registry entries; the issue it names rides the answer. */
const notServed = (tool: ServedTool): Record<string, RegistryEntry> =>
  Object.fromEntries(Object.entries(UNSERVED_OPS[tool] ?? {}).map(([op, by]) => [op, { notServed: by }]));

export const TOOL_REGISTRY: Record<ServedTool, ToolEntry> = {
  myco_search: { defaultOp: null, ops: { [NO_OP]: served(handleSearch) } },
  myco_cortex: {
    defaultOp: 'digest',
    ops: {
      digest: served(handleCortexDigest),
      instructions: served(handleCortexInstructions),
      projects_activity: served(handleCortexProjectsActivity),
      ...notServed('myco_cortex'),
    },
  },
  myco_plans: {
    defaultOp: 'list',
    ops: { list: served(handlePlans), get: served(handlePlans), save: served(handlePlans), ...notServed('myco_plans') },
  },
  myco_sessions: { defaultOp: 'list', ops: { list: served(handleSessions), get: served(handleSessions) } },
  myco_skills: { defaultOp: 'list', ops: { list: served(handleSkills), get: served(handleSkills) } },
  myco_spores: {
    defaultOp: 'list',
    ops: {
      list: served(handleSpores), get: served(handleSpores), save: served(handleSpores),
      supersede: served(handleSpores), consolidate: served(handleSpores), obsolete: served(handleSpores),
    },
  },
  myco_agent: { defaultOp: 'runs', ops: { runs: served(handleAgent), run: served(handleAgent) } },
};

/** The op a call resolves to: the argument when given, else the tool's default; `NO_OP` for a tool without one. */
export function opOf(tool: ServedTool, input: ToolInput): string {
  const entry = TOOL_REGISTRY[tool];
  if (entry.defaultOp === null) return NO_OP;
  return typeof input.op === 'string' ? input.op : entry.defaultOp;
}

/** The registry entry for a call, or undefined when the tool declares no such op. */
export function entryFor(tool: ServedTool, op: string): RegistryEntry | undefined {
  return TOOL_REGISTRY[tool].ops[op];
}

/** Every tool the registry keys, in catalogue order. */
export const REGISTERED_TOOLS: readonly ServedTool[] = SERVED_TOOLS.filter((t) => t in TOOL_REGISTRY);
